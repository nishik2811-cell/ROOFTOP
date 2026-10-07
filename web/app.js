'use strict';

/*
 * Rooftop page. Plain JS, no libraries, so it loads on a Wi-Fi with no internet.
 * The city is drawn once into an offscreen canvas (the "world"); the visible canvas only copies the
 * slice under the camera, so dragging around stays smooth on old phones.
 */

const $ = (sel) => document.querySelector(sel);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MURAL_COLORS = ['#e0392b', '#2f86d6', '#f0be2e', '#e46aa8', '#2f9e66', '#ef7d2d'];
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);
const MAX_MURAL_IMAGE = 12 * 1024 * 1024;
const POLL_MS = 3000;

function storage(area) {
  return {
    get(key) { try { return area().getItem(key); } catch { return null; } },
    set(key, value) { try { area().setItem(key, value); } catch { /* private mode or blocked */ } },
  };
}
const local = storage(() => localStorage);
const session = storage(() => sessionStorage);

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };
const colorFor = (name) => MURAL_COLORS[hash(name) % MURAL_COLORS.length];
const isImage = (file) => IMAGE_EXT.has(extOf(file.name)) && file.size <= MAX_MURAL_IMAGE;

function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
  return bytes.toFixed(bytes < 10 ? 1 : 0) + ' ' + units[i];
}

function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(ms).toLocaleDateString();
}

/* ===================================================================== */
/* Server                                                                */
/* ===================================================================== */

const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const params = new URLSearchParams(location.search);
let pin = params.get('pin') || session.get('rooftop-pin') || '';
if (params.has('pin')) {
  session.set('rooftop-pin', pin);
  history.replaceState(null, '', location.pathname); // keep the PIN out of the address bar
}

class PinError extends Error {}

// Each browser keeps a random id, so two browsers behind one address (two tabs apps, one laptop) are two devices.
const deviceId = local.get('rooftop-device') || (() => {
  const id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
  local.set('rooftop-device', id);
  return id;
})();
const withPin = (path) => (isLocal ? path : path + (path.includes('?') ? '&' : '?') + 'pin=' + encodeURIComponent(pin) + '&device=' + deviceId);
const fileUrl = (name) => withPin('/api/files/' + encodeURIComponent(name));
const saveUrl = (name) => withPin('/api/files/' + encodeURIComponent(name) + '?dl=1'); // asks the browser to save, not open

async function call(path, options) {
  const res = await fetch(withPin(path), options);
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    askPin(body.blocked
      ? 'Too many wrong tries from this device. Restart Rooftop on the PC to reset.'
      : pin ? 'That PIN did not work. The PC may have started a new session, so check its screen.' : '');
    throw new PinError();
  }
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res;
}

/* ===================================================================== */
/* City                                                                  */
/* ===================================================================== */

function createCity(canvas, { imageUrl, onSelect, onHover = () => {}, onFrame = () => {} }) {
  const ctx = canvas.getContext('2d');
  const U = 22;
  const COS = Math.cos(Math.PI / 6);
  const iso = (x, y, z) => [(x - z) * COS * U, (x + z) * 0.5 * U - y * U];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const MONO = 'ui-monospace, Menlo, Consolas, monospace';

  // Golden hour by day, indigo and neon by night. Facades are pastel stucco; roofs are flat tiles.
  const PALETTES = {
    day: {
      skyTop: '#ef7e6c', skyLow: '#ffd9a2', sun: 'rgba(255,244,214,0.9)', haze: 'rgba(255,222,190,0.6)',
      ground: '#e8d2ad', speck: 'rgba(150,100,60,0.18)', road: '#9a8c84', lane: 'rgba(255,248,230,0.75)',
      lawn: '#cfe0a6', plaza: '#f0c9a0', tile: 'rgba(196,110,70,0.35)', water: '#4fb0ad', ripple: 'rgba(255,255,255,0.45)',
      facades: ['#f4a99a', '#f6d28b', '#a4d6c9', '#c4bdeb', '#f6ece0', '#ec9a76'],
      shade: 0.82, roofA: '#c8673f', roofB: '#6d7787', window: '#3f5560', shutters: ['#2f8f83', '#3d6fb0', '#c2463b'],
      lit: null, ink: '#3a2a26', tank: '#8a5a3c', leaf: '#3f8a52', leafDark: '#2b6a3c', bloom: '#e85d9a',
      board: '#2a2422', bulb: null,
      seaFar: '#3d93ad', seaNear: '#6cc6c1', sand: '#f2dcae', wetSand: '#d8b986', foam: 'rgba(255,255,255,0.85)', sail: '#fbf3e6',
    },
    night: {
      skyTop: '#160f38', skyLow: '#5a2a6e', sun: null, haze: 'rgba(120,60,140,0.4)',
      ground: '#2c2440', speck: 'rgba(0,0,0,0.25)', road: '#1f1a2e', lane: 'rgba(255,214,140,0.4)',
      lawn: '#25402f', plaza: '#3a2f52', tile: 'rgba(0,0,0,0.25)', water: '#1f3f5c', ripple: 'rgba(255,220,160,0.35)',
      facades: ['#6a4a63', '#6e5a48', '#3f5a5f', '#4c4870', '#5d5662', '#6a4436'],
      shade: 0.75, roofA: '#4a2c2a', roofB: '#262b38', window: '#1b1d2b', shutters: ['#1f4e48', '#22385c', '#5c2a26'],
      lit: '#ffcf73', ink: '#120d1a', tank: '#4a3426', leaf: '#1f4a33', leafDark: '#143423', bloom: '#8a3a6a',
      board: '#120d1a', bulb: '#fff1c2',
      seaFar: '#101d3c', seaNear: '#1d3f5e', sand: '#4a3f58', wetSand: '#372f48', foam: 'rgba(255,226,170,0.45)', sail: '#cfc3d8',
    },
  };

  /* ---- the city plan: a regular grid of equal blocks around a central plaza, split by a straight canal ---- */
  const plan = rng(20261007);
  const BW = 8, BD = 6, ST = 3;                  // block width, block depth, street width
  const bx = (i) => i * (BW + ST), bz = (j) => j * (BD + ST);
  const PLAZA = { x0: bx(2), x1: bx(3) + BW, z0: bz(3), z1: bz(4) + BD };
  // Towards the horizon the city ends at a beach and the sea runs out to the sky. On this projection
  // screen height depends only on x + z, so the shoreline is a straight horizontal line on screen.
  const SHORE = 8, LAND = SHORE + 2.5;            // x + z where the water stops, and where the sand stops
  const onLand = (x, z, margin = 0) => x + z >= LAND + margin;
  const shoreY = SHORE * 0.5 * U, landY = LAND * 0.5 * U;
  const AVENUES = [];
  for (let i = -3; i <= 7; i++) AVENUES.push([bx(i) + BW, bx(i + 1)]);
  const ROADS_Z = [];
  for (let j = -3; j <= 8; j++) ROADS_Z.push(bz(j) + BD + ST / 2);
  const CAR_ROADS_Z = ROADS_Z.filter((z) => z < PLAZA.z0 || z > PLAZA.z1); // no traffic through the plaza
  const centre = [(PLAZA.x0 + PLAZA.x1) / 2, (PLAZA.z0 + PLAZA.z1) / 2];
  // four districts, each with its own facade colour and roof
  const district = (i, j) => (i < 2.5 ? 0 : 1) + (j < 2.5 ? 0 : 2);
  const DISTRICT_FACADE = [4, 1, 2, 0], DISTRICT_ROOF = ['B', 'A', 'B', 'A'];
  const towerBlocks = new Set(['1,3', '4,3', '1,4', '4,4']);
  const buildings = [];
  const lots = [];
  const trees = [];
  const gardens = [];
  for (let i = -4; i <= 7; i++) {
    for (let j = -3; j <= 8; j++) {
      const x0 = bx(i), z0 = bz(j);
      if (x0 >= PLAZA.x0 && x0 < PLAZA.x1 && z0 >= PLAZA.z0 && z0 < PLAZA.z1) continue;
      lots.push({ x0, x1: x0 + BW, z0, z1: z0 + BD });
      const d = Math.hypot(x0 + BW / 2 - centre[0], z0 + BD / 2 - centre[1]);
      const seed = Math.floor(plan() * 1e9);
      if (!onLand(x0, z0, -1)) { // the block runs into the beach: keep it as a park of palms behind the sand
        for (let px = x0 + 1; px < x0 + BW; px += 2.2) for (let pz = z0 + 1; pz < z0 + BD; pz += 2)
          if (onLand(px, pz, 1)) trees.push({ x: px, z: pz, s: 0.7, seed: Math.floor(px * 13 + pz * 7), palm: true });
        continue;
      }
      if (towerBlocks.has(i + ',' + j)) {
        buildings.push({ type: 'tower', x0: x0 + 2, x1: x0 + 6, z0: z0 + 1, z1: z0 + 5, floors: 11, h: 11 * 0.95 + 0.4, facade: 3, roof: 'B', seed });
        continue;
      }
      // heights step down evenly from the centre, every block has two matching buildings and a lawn between
      const floors = Math.max(2, Math.min(7, Math.round(8 - d / 7)));
      const type = floors >= 6 ? 'block' : floors >= 4 ? 'block' : 'house';
      for (const [a, b] of [[0.7, 3.6], [4.4, 7.3]]) {
        buildings.push({ type, x0: x0 + a, x1: x0 + b, z0: z0 + 0.9, z1: z0 + 5.1, floors, h: floors * 0.95 + 0.4,
          facade: DISTRICT_FACADE[district(i, j)], roof: DISTRICT_ROOF[district(i, j)], seed: seed + a * 1000 });
      }
      gardens.push({ x0: x0 + 3.75, x1: x0 + 4.25, z0: z0 + 0.9, z1: z0 + 5.1 });
    }
  }
  // street trees at an even rhythm along every avenue, and a ring around the plaza
  for (const [a] of AVENUES) for (let z = -24; z < 72; z += 2.5) {
    if (!onLand(a, z, 0.5)) continue;
    trees.push({ x: a + 0.25, z, s: 0.62, seed: Math.floor(z * 31 + a) });
  }
  for (let x = PLAZA.x0 + 1; x < PLAZA.x1; x += 2) {
    trees.push({ x, z: PLAZA.z0 + 0.8, s: 0.75, seed: x * 7 });
    trees.push({ x, z: PLAZA.z1 - 0.8, s: 0.75, seed: x * 11 });
  }
  const corners = [iso(0, 0, 0), iso(58, 0, 0), iso(0, 0, 54), iso(58, 0, 54)];
  const view = {
    x0: Math.min(...corners.map((p) => p[0])) + 80, x1: Math.max(...corners.map((p) => p[0])) - 80,
    y0: corners[0][1] - 330, y1: Math.max(...corners.map((p) => p[1])) - 40,
  };
  const horizon = corners[0][1] - 60;
  const W = view.x1 - view.x0, H = view.y1 - view.y0;

  // outline of a box on screen: back top, right top, right bottom, front bottom, left bottom, left top
  const silhouette = (b) => [iso(b.x0, b.h, b.z0), iso(b.x1, b.h, b.z0), iso(b.x1, 0, b.z0), iso(b.x1, 0, b.z1), iso(b.x0, 0, b.z1), iso(b.x0, b.h, b.z1)];
  const endFace = (b) => [iso(b.x1, b.h, b.z1), iso(b.x1, b.h, b.z0), iso(b.x1, 0, b.z0), iso(b.x1, 0, b.z1)];
  const centerOf = (poly) => [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length];
  for (const b of buildings) {
    b.sil = silhouette(b);
    b.box = { x0: Math.min(...b.sil.map((p) => p[0])), x1: Math.max(...b.sil.map((p) => p[0])), y0: Math.min(...b.sil.map((p) => p[1])), y1: Math.max(...b.sil.map((p) => p[1])) };
    b.depth = b.x0 + b.x1 + b.z0 + b.z1;
  }
  const inView = (p, m) => p[0] > view.x0 + m && p[0] < view.x1 - m && p[1] > view.y0 + m && p[1] < view.y1 - m;
  const hidden = (p, depth) => buildings.some((b) => b.depth > depth && ((p[0] > b.box.x0 && p[0] < b.box.x1 && p[1] > b.box.y0 && p[1] < b.box.y1 && inside(p, b.sil))
    || (b.board && inside(p, b.board))));

  // The tallest towers near the middle carry the billboards; tall end walls carry the murals.
  const mid = [(view.x0 + view.x1) / 2, (view.y0 + view.y1) / 2 + 60];
  const billboardTowers = buildings.filter((b) => b.type === 'tower' && inView(centerOf(endFace(b)), 120))
    .sort((a, b) => Math.hypot(...sub(centerOf(endFace(a)), mid)) - Math.hypot(...sub(centerOf(endFace(b)), mid))).slice(0, 4);
  const boards = billboardTowers.map((b) => {
    const len = Math.min(5.2, b.x1 - b.x0 + 1.6), x0 = (b.x0 + b.x1) / 2 - len / 2, z = (b.z0 + b.z1) / 2, y0 = b.h + 0.9, y1 = y0 + len * 0.55;
    const board = { b, x0, x1: x0 + len, z, y0, y1, poly: [iso(x0, y1, z), iso(x0 + len, y1, z), iso(x0 + len, y0, z), iso(x0, y0, z)] };
    b.board = [board.poly[0], board.poly[1], iso(x0 + len, b.h, z), iso(x0, b.h, z)]; // the board plus its legs
    for (const [px, py] of b.board) b.box = { x0: Math.min(b.box.x0, px), x1: Math.max(b.box.x1, px), y0: Math.min(b.box.y0, py), y1: Math.max(b.box.y1, py) };
    return board;
  });
  const walls = buildings.filter((b) => b.h >= 3 && !billboardTowers.includes(b) && inView(centerOf(endFace(b)), 70)
    && !hidden(centerOf(endFace(b)), b.depth + 0.01));

  const drawables = [
    ...buildings.filter((b) => b.box.x1 > view.x0 - 40 && b.box.x0 < view.x1 + 40 && b.box.y0 < view.y1 && iso(b.x0, 0, b.z0)[1] > horizon + 44).map((b) => ({ kind: 'building', item: b, key: b.depth })),
    ...trees.filter((t) => iso(t.x, 0, t.z)[1] > horizon + 44).map((t) => ({ kind: 'tree', item: t, key: t.x * 2 + t.z * 2 })),
  ].sort((a, b) => a.key - b.key);

  /* ---- moving life: cars on the avenues, sailboats at sea, people in the plaza ---- */
  const life = rng(99);
  const CAR_COLORS = ['#e2483d', '#f2b632', '#2f86d6', '#f6ece0', '#3a2a26', '#2f9e66'];
  const cars = [];
  for (const z of CAR_ROADS_Z) for (let k = 0; k < 2; k++) cars.push({ axis: 'x', lane: z + (k % 2 ? 0.6 : -0.6), dir: k % 2 ? -1 : 1, t: -40 + life() * 136, speed: 0.0016 + life() * 0.0012, color: CAR_COLORS[Math.floor(life() * 6)] });
  for (const [a, b] of AVENUES.filter((_, n) => n % 2 === 0)) for (let k = 0; k < 2; k++) cars.push({ axis: 'z', lane: (a + b) / 2 + (k % 2 ? 0.6 : -0.6), dir: k % 2 ? -1 : 1, t: -34 + life() * 100, speed: 0.0016 + life() * 0.0012, color: CAR_COLORS[Math.floor(life() * 6)] });
  // sailboats out at sea, each on a fixed line parallel to the shore (constant x + z), moving across the screen
  const sails = [0.6, 3.2, 5.6].map((s0, k) => ({ s0, d: -70 + life() * 140, speed: 0.0007 + life() * 0.0006, dir: k % 2 ? -1 : 1 }));
  // the bits of shoreline no building stands in front of, where the surf may be animated
  const surf = [];
  for (let x = view.x0 - 60; x < view.x1 + 60; x += 6) if (!hidden([x, shoreY - 2], SHORE * 2) && !hidden([x, shoreY + 2], SHORE * 2)) surf.push(x);
  const people = Array.from({ length: 30 }, () => ({ x: PLAZA.x0 + 1.5 + life() * (PLAZA.x1 - PLAZA.x0 - 3), z: PLAZA.z0 + 1.5 + life() * (PLAZA.z1 - PLAZA.z0 - 3), a: life() * 6.28, color: CAR_COLORS[Math.floor(life() * 6)] }));

  /* ---- state ---- */
  let night = false;
  let files = [];
  let assigned = new Map(); // building or board -> file
  let murals = [];          // [{ file, poly, center, kind }], billboards first, then walls, newest first
  let selected = -1;
  let hovered = -1;
  const images = new Map();
  const world = document.createElement('canvas');
  let fit = 1, dpr = 1, cssW = 0, cssH = 0, k = 1;
  const cam = { x: 0, y: 0, z: 1, vx: 0, vy: 0 };
  let placed = false, tween = null, flight = null, splash = null, renderTimer = 0, lastFrame = 0;

  /* ---- drawing helpers ---- */
  function poly(c, pts, fill) {
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
    c.closePath();
    c.fillStyle = fill;
    c.fill();
  }

  function inked(c, pts, r, color, width = 1.2) {
    c.strokeStyle = color;
    c.lineWidth = width;
    c.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      c.beginPath();
      pts.forEach(([x, y], i) => {
        const jx = (r() - 0.5) * 1.3, jy = (r() - 0.5) * 1.3;
        i ? c.lineTo(x + jx, y + jy) : c.moveTo(x + jx, y + jy);
      });
      c.closePath();
      c.stroke();
    }
  }

  function onFace(c, o, u, v, w, h, paint) {
    c.save();
    c.transform(u[0] / w, u[1] / w, v[0] / h, v[1] / h, o[0], o[1]);
    paint(c, w, h);
    c.restore();
  }

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (s) => Math.round(((n >> s) & 255) * f).toString(16).padStart(2, '0');
    return '#' + ch(16) + ch(8) + ch(0);
  }

  /* ---- backdrop: sky, sun, ground, canal, roads, plaza ---- */
  function drawBackdrop(c, p) {
    const r = rng(7);
    const x0 = view.x0 - 60, w = W + 120;
    const sky = c.createLinearGradient(0, view.y0, 0, horizon + 40);
    sky.addColorStop(0, p.skyTop);
    sky.addColorStop(1, p.skyLow);
    c.fillStyle = sky;
    c.fillRect(x0, view.y0 - 60, w, horizon - view.y0 + 140);
    if (p.sun) {
      const [sx, sy] = [view.x0 + W * 0.72, horizon - 70];
      c.fillStyle = p.sun;
      c.beginPath(); c.arc(sx, sy, 46, 0, Math.PI * 2); c.fill();
    } else {
      for (let i = 0; i < 120; i++) {
        c.fillStyle = `rgba(255,248,230,${0.3 + r() * 0.7})`;
        c.fillRect(x0 + r() * w, view.y0 - 40 + r() * (horizon - view.y0), 1.5, 1.5);
      }
    }
    // a distant skyline cut-out along the horizon, across the water
    c.fillStyle = shade(p.skyLow, 0.86);
    for (let x = x0; x < x0 + w;) {
      const bw = 24 + r() * 50, bh = 20 + r() * 70;
      c.fillRect(x, horizon - bh + 40, bw, bh);
      x += bw + r() * 8;
    }
    const haze = c.createLinearGradient(0, horizon - 10, 0, horizon + 50);
    haze.addColorStop(0, 'rgba(0,0,0,0)');
    haze.addColorStop(1, p.haze);
    c.fillStyle = haze;
    c.fillRect(x0, horizon - 10, w, 60);

    // ground everywhere below the horizon, so the sky never shows through at the sides
    c.save();
    c.beginPath(); c.rect(x0, horizon + 40, w, view.y1 - horizon + 80); c.clip();
    c.fillStyle = p.ground;
    c.fillRect(x0, horizon, w, view.y1 - horizon + 120);
    c.fillStyle = p.speck;
    for (let i = 0; i < 2400; i++) {
      const [sx, sy] = iso(-4 + r() * 54, 0, -4 + r() * 48);
      c.fillRect(sx, sy, 1.6, 1.6);
    }
    c.restore();
    // roads
    // everything on the ground stops where the sand starts
    c.save();
    c.beginPath(); c.rect(x0, landY, w, view.y1 - landY + 200); c.clip();
    for (const z of ROADS_Z) poly(c, [iso(-40, 0, z - ST / 2), iso(100, 0, z - ST / 2), iso(100, 0, z + ST / 2), iso(-40, 0, z + ST / 2)], p.road);
    for (const [a, b] of AVENUES) poly(c, [iso(a, 0, -40), iso(b, 0, -40), iso(b, 0, 70), iso(a, 0, 70)], p.road);
    c.strokeStyle = p.lane;
    c.lineWidth = 1.3;
    c.setLineDash([8, 9]);
    for (const z of ROADS_Z) { const a = iso(-40, 0, z), b = iso(100, 0, z); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
    for (const [a, b] of AVENUES) { const s = iso((a + b) / 2, 0, -40), e = iso((a + b) / 2, 0, 70); c.beginPath(); c.moveTo(s[0], s[1]); c.lineTo(e[0], e[1]); c.stroke(); }
    c.setLineDash([]);
    for (const l of lots) poly(c, [iso(l.x0, 0, l.z0), iso(l.x1, 0, l.z0), iso(l.x1, 0, l.z1), iso(l.x0, 0, l.z1)], p.lawn);
    c.restore();
    drawCoast(c, p, r, x0, w);
    // plaza: tiles, a fountain in the middle
    poly(c, [iso(PLAZA.x0, 0, PLAZA.z0), iso(PLAZA.x1, 0, PLAZA.z0), iso(PLAZA.x1, 0, PLAZA.z1), iso(PLAZA.x0, 0, PLAZA.z1)], p.plaza);
    c.strokeStyle = p.tile;
    c.lineWidth = 1;
    for (let x = PLAZA.x0; x <= PLAZA.x1; x += 1) { const a = iso(x, 0, PLAZA.z0), b = iso(x, 0, PLAZA.z1); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
    for (let z = PLAZA.z0; z <= PLAZA.z1; z += 1) { const a = iso(PLAZA.x0, 0, z), b = iso(PLAZA.x1, 0, z); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
    for (const g of gardens) {
      poly(c, [iso(g.x0, 0, g.z0), iso(g.x1, 0, g.z0), iso(g.x1, 0, g.z1), iso(g.x0, 0, g.z1)], p.plaza);
      c.fillStyle = p.bloom;
      
    }
    const [fx, fy] = iso((PLAZA.x0 + PLAZA.x1) / 2, 0, (PLAZA.z0 + PLAZA.z1) / 2);
    c.fillStyle = shade(p.plaza, 0.75);
    c.beginPath(); c.ellipse(fx, fy, 46, 23, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = p.water;
    c.beginPath(); c.ellipse(fx, fy - 3, 38, 18, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = shade(p.plaza, 0.6);
    c.fillRect(fx - 4, fy - 26, 8, 22);
    c.fillStyle = p.ripple;
    c.beginPath(); c.ellipse(fx, fy - 28, 10, 5, 0, 0, Math.PI * 2); c.fill();
  }

  /* ---- coast: sea from the horizon to the shore, then a strip of sand up to the first street ---- */
  function drawCoast(c, p, r, x0, w) {
    const seaTop = horizon + 40; // the far skyline stands right on the water
    const sea = c.createLinearGradient(0, seaTop, 0, shoreY);
    sea.addColorStop(0, p.seaFar);
    sea.addColorStop(1, p.seaNear);
    c.fillStyle = sea;
    c.fillRect(x0, seaTop, w, shoreY - seaTop);
    // swell: short strokes, smaller and flatter towards the horizon
    c.strokeStyle = p.ripple;
    c.lineCap = 'round';
    for (let i = 0; i < 260; i++) {
      const t = r(), y = seaTop + 4 + t * t * (shoreY - seaTop - 8), near = (y - seaTop) / (shoreY - seaTop);
      const x = x0 + r() * w, len = 4 + near * 14;
      c.globalAlpha = 0.35 + near * 0.5;
      c.lineWidth = 0.6 + near * 0.9;
      c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + len / 2, y - 1.5 - near * 2, x + len, y); c.stroke();
    }
    c.globalAlpha = 1;
    if (p.sun) { // the sun's path on the water
      const sx = view.x0 + W * 0.72;
      c.fillStyle = p.sun;
      for (let y = seaTop + 2; y < shoreY - 6; y += 4) {
        const near = (y - seaTop) / (shoreY - seaTop), half = 30 - near * 14 + (r() - 0.5) * 16;
        c.globalAlpha = 0.55 * (1 - near * 0.7);
        c.fillRect(sx - half, y, half * 2, 1.4);
      }
      c.globalAlpha = 1;
    }
    // sand, darker where the waves wet it, with a scatter of shells and pebbles
    c.fillStyle = p.sand;
    c.fillRect(x0, shoreY, w, landY - shoreY + 1);
    c.fillStyle = p.wetSand;
    c.beginPath(); c.moveTo(x0, shoreY);
    for (let x = x0; x <= x0 + w; x += 12) c.lineTo(x, shoreY + 4 + Math.sin(x * 0.05) * 1.6);
    c.lineTo(x0 + w, shoreY); c.closePath(); c.fill();
    c.fillStyle = p.speck;
    for (let i = 0; i < 500; i++) c.fillRect(x0 + r() * w, shoreY + 6 + r() * (landY - shoreY - 7), 1.5, 1.5);
    c.strokeStyle = p.foam;
    c.lineWidth = 1.6;
    c.beginPath();
    for (let x = x0; x <= x0 + w; x += 6) { const y = shoreY - 1 + Math.sin(x * 0.07) * 1.4; x === x0 ? c.moveTo(x, y) : c.lineTo(x, y); }
    c.stroke();
    // a curb where the street begins
    c.fillStyle = shade(p.sand, 0.86);
    c.fillRect(x0, landY - 1.5, w, 2);
  }

  /* ---- buildings ---- */
  function drawBuilding(c, b, p) {
    const r = rng(b.seed);
    const { x0, x1, z0, z1, h } = b;
    const wall = p.facades[b.facade], side = shade(wall, p.shade), roof = b.roof === 'A' ? p.roofA : p.roofB;
    const shutter = p.shutters[b.seed % p.shutters.length];

    // long front face: shuttered windows, balconies with plants on the blocks
    const fo = iso(x0, h, z1);
    onFace(c, fo, sub(iso(x1, h, z1), fo), sub(iso(x0, 0, z1), fo), (x1 - x0) * U, h * U, (f, w, hh) => {
      f.fillStyle = wall;
      f.fillRect(0, 0, w, hh);
      f.fillStyle = 'rgba(255,255,255,0.08)';
      f.fillRect(0, 0, w, 0.35 * U); // cornice
      const cols = Math.max(1, Math.floor((x1 - x0) / 1.3));
      const gap = (w - cols * 0.5 * U) / (cols + 1);
      for (let fl = 0; fl < b.floors; fl++) {
        const y = 0.55 * U + fl * 0.95 * U;
        for (let col = 0; col < cols; col++) {
          const x = gap + col * (0.5 * U + gap);
          const lit = p.lit && r() < 0.42;
          f.fillStyle = lit ? p.lit : p.window;
          f.fillRect(x, y, 0.5 * U, 0.5 * U);
          if (!lit) { // shutters either side
            f.fillStyle = shutter;
            f.fillRect(x - 0.16 * U, y, 0.14 * U, 0.5 * U);
            f.fillRect(x + 0.52 * U, y, 0.14 * U, 0.5 * U);
          }
          if (b.type === 'block' && fl > 0 && r() < 0.35) { // balcony with flowers
            f.fillStyle = shade(wall, 0.7);
            f.fillRect(x - 0.2 * U, y + 0.5 * U, 0.9 * U, 0.1 * U);
            f.fillStyle = r() < 0.5 ? p.bloom : p.leaf;
            for (let k2 = 0; k2 < 3; k2++) { f.beginPath(); f.arc(x + k2 * 0.25 * U, y + 0.47 * U, 2.6, 0, Math.PI * 2); f.fill(); }
          }
        }
      }
      // ground floor: a door, and a shop awning on the blocks
      f.fillStyle = shade(wall, 0.55);
      f.fillRect(w / 2 - 0.3 * U, hh - 0.75 * U, 0.6 * U, 0.75 * U);
      if (b.type !== 'tower' && b.floors > 2) {
        f.fillStyle = p.shutters[(b.seed >> 3) % p.shutters.length];
        for (let s = 0; s < w; s += 0.4 * U) { f.globalAlpha = ((s / (0.4 * U)) % 2) ? 1 : 0.35; f.fillRect(s, hh - 1.0 * U, 0.4 * U, 0.22 * U); }
        f.globalAlpha = 1;
      }
    });
    inked(c, [iso(x0, h, z1), iso(x1, h, z1), iso(x1, 0, z1), iso(x0, 0, z1)], r, p.ink);

    // end wall: mural (a file) or plain stucco with a few windows
    const file = assigned.get(b);
    const eo = iso(x1, h, z1);
    onFace(c, eo, sub(iso(x1, h, z0), eo), sub(iso(x1, 0, z1), eo), (z1 - z0) * U, h * U, (f, w, hh) => {
      f.fillStyle = side;
      f.fillRect(0, 0, w, hh);
      if (file) {
        paintMural(f, w, hh, file);
      } else {
        for (let fl = 0; fl < b.floors; fl++) {
          if (r() < 0.5) continue;
          f.fillStyle = p.lit && r() < 0.5 ? p.lit : p.window;
          f.fillRect(w / 2 - 0.22 * U, 0.55 * U + fl * 0.95 * U, 0.44 * U, 0.5 * U);
        }
      }
    });
    inked(c, endFace(b), r, p.ink);

    // flat roof with a parapet, a water tank and an antenna
    const roofPts = [iso(x0, h, z0), iso(x1, h, z0), iso(x1, h, z1), iso(x0, h, z1)];
    poly(c, roofPts, roof);
    poly(c, [iso(x0 + 0.25, h, z0 + 0.25), iso(x1 - 0.25, h, z0 + 0.25), iso(x1 - 0.25, h, z1 - 0.25), iso(x0 + 0.25, h, z1 - 0.25)], shade(roof, 1.12));
    inked(c, roofPts, r, p.ink);
    if (!billboardTowers.includes(b) && r() < 0.7) {
      const tx = x0 + 0.9 + r() * Math.max(0.1, x1 - x0 - 1.8), tz = z0 + 1.1;
      const top = iso(tx, h + 1.3, tz), bot = iso(tx, h + 0.4, tz), rx = 0.55 * U, ry = rx * 0.5;
      c.strokeStyle = p.ink; c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(bot[0] - rx * 0.6, bot[1]); c.lineTo(bot[0] - rx * 0.6, bot[1] + 0.4 * U); c.moveTo(bot[0] + rx * 0.6, bot[1]); c.lineTo(bot[0] + rx * 0.6, bot[1] + 0.4 * U); c.stroke();
      c.fillStyle = p.tank;
      c.fillRect(top[0] - rx, top[1], rx * 2, bot[1] - top[1]);
      c.beginPath(); c.ellipse(bot[0], bot[1], rx, ry, 0, 0, Math.PI); c.fill();
      c.fillStyle = shade(p.tank, 0.75);
      c.beginPath(); c.moveTo(top[0] - rx - 2, top[1]); c.lineTo(top[0], top[1] - 0.6 * U); c.lineTo(top[0] + rx + 2, top[1]); c.closePath(); c.fill();
      c.strokeStyle = shade(p.tank, 0.6);
      for (let hoop = 1; hoop < 3; hoop++) { const yy = top[1] + (bot[1] - top[1]) * hoop / 3; c.beginPath(); c.moveTo(top[0] - rx, yy); c.lineTo(top[0] + rx, yy); c.stroke(); }
    }
    if (b.type === 'tower' && !billboardTowers.includes(b)) {
      const [ax, ay] = iso(x1 - 0.8, h, z0 + 0.8);
      c.strokeStyle = p.ink; c.lineWidth = 1.3;
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(ax, ay - 34); c.moveTo(ax - 7, ay - 24); c.lineTo(ax + 7, ay - 24); c.moveTo(ax - 4, ay - 30); c.lineTo(ax + 4, ay - 30); c.stroke();
    }

    // a giant billboard on the roof
    const board = boards.find((bd) => bd.b === b);
    if (board) drawBillboard(c, board, p);
  }

  function drawBillboard(c, bd, p) {
    const r = rng(bd.b.seed + 1);
    const { x0, x1, z, y0, y1 } = bd;
    // scaffold legs and a catwalk
    c.strokeStyle = p.ink;
    c.lineWidth = 2;
    for (const lx of [x0 + 0.5, (x0 + x1) / 2, x1 - 0.5]) {
      const a = iso(lx, bd.b.h, z), t = iso(lx, y0, z);
      c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(t[0], t[1]); c.stroke();
    }
    poly(c, [iso(x0, y0, z), iso(x1, y0, z), iso(x1, y0, z + 0.5), iso(x0, y0, z + 0.5)], shade(p.board, 1.6));
    // the board, with the file painted on it
    poly(c, bd.poly, p.board);
    const o = bd.poly[0];
    onFace(c, o, sub(bd.poly[1], o), sub(bd.poly[3], o), (x1 - x0) * U, (y1 - y0) * U, (f, w, hh) => {
      const file = assigned.get(bd);
      if (file) paintBillboard(f, w, hh, file);
      else paintInvite(f, w, hh);
    });
    inked(c, bd.poly, r, p.ink, 1.6);
    if (p.bulb) { // night: a row of bulbs along the top
      const n = 9;
      for (let i = 0; i <= n; i++) {
        const [bx, by] = iso(x0 + (x1 - x0) * i / n, y1 + 0.12, z);
        c.fillStyle = 'rgba(255,230,160,0.35)';
        c.beginPath(); c.arc(bx, by, 6, 0, Math.PI * 2); c.fill();
        c.fillStyle = p.bulb;
        c.beginPath(); c.arc(bx, by, 2.2, 0, Math.PI * 2); c.fill();
      }
    }
  }

  function drawTree(c, t, p) {
    const r = rng(t.seed);
    const [bx, by] = iso(t.x, 0, t.z);
    const size = 13 * t.s;
    if (t.palm) { // a leaning trunk and a crown of drooping fronds
      const lean = (r() - 0.5) * 10, top = [bx + lean, by - size * 2.6];
      c.strokeStyle = shade(p.tank, 1.1); c.lineWidth = 2.6;
      c.beginPath(); c.moveTo(bx, by); c.quadraticCurveTo(bx + lean * 0.2, by - size * 1.4, top[0], top[1]); c.stroke();
      c.fillStyle = p.leaf; c.strokeStyle = p.leafDark; c.lineWidth = 0.9;
      for (let k2 = 0; k2 < 6; k2++) {
        const a = (k2 / 6) * Math.PI * 2 + r() * 0.4, ex = top[0] + Math.cos(a) * size * 1.15, ey = top[1] + Math.abs(Math.sin(a)) * size * 0.35 + size * 0.45;
        c.beginPath(); c.moveTo(top[0], top[1]);
        c.quadraticCurveTo((top[0] + ex) / 2, top[1] - size * 0.5, ex, ey);
        c.quadraticCurveTo((top[0] + ex) / 2, top[1] - size * 0.15, top[0], top[1]);
        c.fill(); c.stroke();
      }
      return;
    }
    c.strokeStyle = p.ink;
    c.lineWidth = 1.8;
    c.beginPath(); c.moveTo(bx, by); c.lineTo(bx, by - size * 1.3); c.stroke();
    // a tall rounded cypress-like crown, with a few flowers
    c.fillStyle = p.leafDark;
    c.beginPath(); c.ellipse(bx + 2, by - size * 2, size * 0.75, size * 1.25, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = p.leaf;
    c.beginPath(); c.ellipse(bx, by - size * 2.1, size * 0.65, size * 1.15, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = p.ink; c.lineWidth = 0.9; c.stroke();
    c.fillStyle = p.bloom;
    for (let i = 0; i < 4; i++) { c.beginPath(); c.arc(bx + (r() - 0.5) * size, by - size * (1.5 + r() * 1.2), 2, 0, Math.PI * 2); c.fill(); }
  }

  /* ---- art: murals on walls, posters on billboards ---- */
  function paintMural(f, w, h, file) {
    const r = rng(hash(file.name));
    const img = images.get(file.name);
    f.save();
    f.beginPath(); f.rect(3, 3, w - 6, h - 6); f.clip();
    f.fillStyle = colorFor(file.name);
    f.fillRect(0, 0, w, h);
    if (img && img.naturalWidth) {
      const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
      f.drawImage(img, (w - img.naturalWidth * s) / 2, (h - img.naturalHeight * s) * 0.3, img.naturalWidth * s, img.naturalHeight * s);
    } else {
      for (let i = 0; i < 14; i++) {
        f.globalAlpha = 0.3 + r() * 0.4;
        f.fillStyle = MURAL_COLORS[Math.floor(r() * MURAL_COLORS.length)];
        f.beginPath(); f.arc(r() * w, r() * h, 4 + r() * 12, 0, Math.PI * 2); f.fill();
      }
      f.globalAlpha = 1;
      const text = (extOf(file.name) || 'file').toUpperCase().slice(0, 4);
      f.textAlign = 'center'; f.textBaseline = 'middle'; f.lineJoin = 'round';
      f.font = `800 ${Math.min(w / (text.length * 0.62), 24)}px ${MONO}`;
      f.lineWidth = 3; f.strokeStyle = '#2a1f1c'; f.fillStyle = '#fbf3e6';
      f.strokeText(text, w / 2, h * 0.3); f.fillText(text, w / 2, h * 0.3);
    }
    f.restore();
  }

  function paintBillboard(f, w, h, file) {
    const img = images.get(file.name);
    const color = colorFor(file.name);
    f.fillStyle = '#fbf3e6';
    f.fillRect(0, 0, w, h);
    if (img && img.naturalWidth) {
      const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
      f.save(); f.beginPath(); f.rect(4, 4, w - 8, h - 8); f.clip();
      f.drawImage(img, (w - img.naturalWidth * s) / 2, (h - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
      f.restore();
      return;
    }
    // a poster: a big colour block with the file type, the name underneath, the sender in small type
    f.fillStyle = color;
    f.fillRect(4, 4, w * 0.42, h - 8);
    const text = (extOf(file.name) || 'file').toUpperCase().slice(0, 4);
    f.fillStyle = '#fbf3e6';
    f.textAlign = 'center'; f.textBaseline = 'middle';
    f.font = `800 ${Math.min(h * 0.34, w * 0.42 / (text.length * 0.6))}px ${MONO}`;
    f.fillText(text, 4 + w * 0.21, h / 2);
    f.fillStyle = '#2a1f1c';
    f.textAlign = 'left';
    f.font = `800 ${h * 0.14}px ${MONO}`;
    const name = file.name.length > 18 ? file.name.slice(0, 16) + '..' : file.name;
    f.fillText(name, w * 0.47, h * 0.42);
    f.font = `600 ${h * 0.1}px ${MONO}`;
    f.fillStyle = shade(color, 0.7);
    f.fillText('from ' + (file.from || '').slice(0, 18), w * 0.47, h * 0.64);
  }

  function paintInvite(f, w, h) {
    f.fillStyle = '#fbf3e6';
    f.fillRect(0, 0, w, h);
    f.fillStyle = '#e2483d';
    f.fillRect(4, 4, w - 8, h * 0.18);
    f.fillStyle = '#2a1f1c';
    f.textAlign = 'center'; f.textBaseline = 'middle';
    f.font = `800 ${h * 0.2}px ${MONO}`;
    f.fillText('YOUR FILE', w / 2, h * 0.47);
    f.fillText('GOES UP HERE', w / 2, h * 0.72);
  }

  function render() {
    if (!cssW) return;
    const p = night ? PALETTES.night : PALETTES.day;
    world.width = Math.ceil(W * k);
    world.height = Math.ceil(H * k);
    const c = world.getContext('2d');
    c.setTransform(k, 0, 0, k, -view.x0 * k, -view.y0 * k);
    drawBackdrop(c, p);
    for (const d of drawables) (d.kind === 'building' ? drawBuilding : drawTree)(c, d.item, p);
    requestDraw();
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 120);
  }

  /* ---- files: newest on the billboards, the rest on walls (a file keeps its wall) ---- */
  function wallFor(name, taken) {
    if (!walls.length) return null;
    const start = hash(name) % walls.length;
    for (let i = 0; i < walls.length; i++) {
      const wall = walls[(start + i) % walls.length];
      if (!taken.has(wall)) return wall;
    }
    return null;
  }

  function setFiles(next) {
    files = next;
    // Files keep their spot between updates, so removing one never shuffles the rest.
    // A new file takes a free billboard, or bumps an older billboard file onto a wall, or gets a wall.
    const was = new Map([...assigned].map(([place, f]) => [f.name, place]));
    assigned = new Map();
    const fresh = [];
    for (const f of files) {
      const place = was.get(f.name);
      if (place) assigned.set(place, f); else fresh.push(f);
    }
    const toWall = (f) => { const wall = wallFor(f.name, assigned); if (wall) assigned.set(wall, f); };
    for (const f of fresh.sort((a, b) => b.at - a.at)) {
      const free = boards.find((bd) => !assigned.has(bd));
      if (free) { assigned.set(free, f); continue; }
      const oldest = boards.reduce((o, bd) => (!o || assigned.get(bd).at < assigned.get(o).at ? bd : o), null);
      if (oldest && assigned.get(oldest).at < f.at) {
        const bumped = assigned.get(oldest);
        assigned.set(oldest, f);
        toWall(bumped);
      } else toWall(f);
    }
    const spot = new Map([...assigned].map(([place, f]) => [f.name, place]));
    murals = files.filter((f) => spot.has(f.name)).map((f) => {
      const place = spot.get(f.name);
      const polyPts = place.poly && place.b ? place.poly : endFace(place);
      return { file: f, poly: polyPts, center: centerOf(polyPts), kind: place.b ? 'billboard' : 'wall' };
    });
    for (const f of files) {
      if (isImage(f) && !images.has(f.name)) {
        const img = new Image();
        img.decoding = 'async';
        img.onload = scheduleRender;
        img.src = imageUrl(f.name);
        images.set(f.name, img);
      }
    }
    if (selected >= murals.length) selected = murals.length - 1;
    render();
  }

  /* ---- camera: drag with momentum, wheel and pinch zoom, fly to a file ---- */
  const visW = () => cssW / cam.z;
  const visH = () => cssH / cam.z;
  function clamp() {
    cam.z = Math.min(Math.max(cam.z, fit), fit * 2.4);
    cam.x = Math.min(Math.max(cam.x, view.x0), view.x1 - visW());
    cam.y = Math.min(Math.max(cam.y, view.y0), view.y1 - visH());
  }

  function flyTo([x, y], zoom = cam.z, animate = true, dur = 1100) {
    const z = Math.min(Math.max(zoom, fit), fit * 2.4);
    const to = { x: x - cssW / z / 2, y: y - cssH / z * 0.48, z };
    to.x = Math.min(Math.max(to.x, view.x0), view.x1 - cssW / z);
    to.y = Math.min(Math.max(to.y, view.y0), view.y1 - cssH / z);
    if (!animate || reduceMotion) { Object.assign(cam, to); tween = null; }
    else tween = { from: { x: cam.x, y: cam.y, z: cam.z }, to, start: performance.now(), dur };
    requestDraw();
  }

  function zoomAt(factor, sx, sy) {
    const wx = cam.x + sx / cam.z, wy = cam.y + sy / cam.z;
    cam.z *= factor;
    clamp();
    cam.x = wx - sx / cam.z;
    cam.y = wy - sy / cam.z;
    clamp();
    requestDraw();
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const centre = cssW ? [cam.x + visW() / 2, cam.y + visH() / 2] : null;
    cssW = rect.width; cssH = rect.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const oldFit = fit;
    tween = null;
    fit = Math.max(cssW / W, cssH / H) * (cssW < 768 ? 1.25 : 1.12);
    cam.z = placed ? cam.z * (fit / oldFit) : fit;
    k = Math.min(dpr * fit * 2.4, Math.sqrt(10e6 / (W * H))); // the cache is sharp enough for zooming in
    if (!placed) {
      flyTo([(view.x0 + view.x1) / 2, (view.y0 + view.y1) / 2 + 40], fit, false);
      placed = true;
    } else if (centre) {
      cam.x = centre[0] - visW() / 2; cam.y = centre[1] - visH() / 2; clamp();
    }
    render();
  }

  /* ---- frame loop ---- */
  let queued = false;
  function requestDraw() {
    if (!queued) { queued = true; requestAnimationFrame(frame); }
  }

  function frame(now) {
    queued = false;
    if (!cssW || document.hidden) return;
    if (tween) {
      const t = Math.min(1, (now - tween.start) / tween.dur);
      const e = 1 - Math.pow(1 - t, 4); // ease-out: starts moving at once, settles softly
      cam.x = tween.from.x + (tween.to.x - tween.from.x) * e;
      cam.y = tween.from.y + (tween.to.y - tween.from.y) * e;
      cam.z = tween.from.z + (tween.to.z - tween.from.z) * e;
      if (t >= 1) tween = null;
    } else if (!drag && (Math.abs(cam.vx) > 0.02 || Math.abs(cam.vy) > 0.02)) {
      cam.x -= cam.vx / cam.z; cam.y -= cam.vy / cam.z;
      cam.vx *= 0.93; cam.vy *= 0.93;
      clamp();
    }
    const dt = Math.min(64, now - (lastFrame || now));
    lastFrame = now;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(world, (cam.x - view.x0) * k, (cam.y - view.y0) * k, visW() * k, visH() * k, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(cam.z * dpr, 0, 0, cam.z * dpr, -cam.x * cam.z * dpr, -cam.y * cam.z * dpr);

    drawLife(now, dt);
    drawHotspots(now);

    if (selected >= 0 && murals[selected]) {
      ctx.strokeStyle = '#fbf3e6';
      ctx.lineWidth = 3 / cam.z;
      ctx.setLineDash([7 / cam.z, 5 / cam.z]);
      ctx.lineDashOffset = reduceMotion ? 0 : -now / 50;
      ctx.beginPath();
      murals[selected].poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (hovered >= 0 && murals[hovered] && hovered !== selected) { // light up the wall or board under the cursor
      ctx.strokeStyle = '#fbf3e6';
      ctx.lineWidth = 3 / cam.z;
      ctx.beginPath();
      murals[hovered].poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
    }
    if (flight) drawPlane(flight);
    if (splash) {
      const t = (now - splash.start) / 900;
      if (t >= 1) splash = null;
      else {
        for (let i = 0; i < 3; i++) {
          const rt = Math.max(0, t - i * 0.12);
          ctx.strokeStyle = MURAL_COLORS[(splash.seed + i) % MURAL_COLORS.length];
          ctx.globalAlpha = 1 - rt;
          ctx.lineWidth = (4 * (1 - rt)) / cam.z;
          ctx.beginPath(); ctx.arc(splash.at[0], splash.at[1], 10 + rt * 90, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }
    // tell the page where each file's top-right corner is on screen, for its remove button
    onFrame(murals.map((m) => {
      const p = m.poly.reduce((best, q) => (q[0] - q[1] > best[0] - best[1] ? q : best));
      return { x: (p[0] - cam.x) * cam.z, y: (p[1] - cam.y) * cam.z };
    }));
    // the city is alive, so keep drawing (the loop pauses while the tab is hidden)
    if (reduceMotion && !tween && !flight && !splash) return;
    requestDraw();
  }

  function drawLife(now, dt) {
    if (reduceMotion) return;
    const p = night ? PALETTES.night : PALETTES.day;
    for (const car of cars) {
      // wrap around the whole city, well outside the view, so cars never pop in or out on screen
      // and stop short of the beach: a road meets the sand at x + z = LAND
      const [lo, hi] = car.axis === 'x' ? [Math.max(-40, LAND + 0.8 - car.lane), 96] : [Math.max(-34, LAND + 0.8 - car.lane), 66];
      if (hi <= lo + 4) continue;
      car.t += car.dir * car.speed * dt;
      if (car.t > hi) car.t = lo; else if (car.t < lo) car.t = hi;
      const [x, z] = car.axis === 'x' ? [car.t, car.lane] : [car.lane, car.t];
      ctx.globalAlpha = Math.min(1, (car.t - lo) / 2, (hi - car.t) / 2);
      drawCar(x, 0, z, car, p);
      ctx.globalAlpha = 1;
    }
    // surf rolling in along the beach
    ctx.strokeStyle = p.foam;
    ctx.lineWidth = 1.3;
    ctx.globalAlpha = 0.45 + 0.35 * Math.sin(now * 0.0012);
    ctx.beginPath();
    for (let i = 0; i < surf.length; i++) {
      const x = surf[i], y = shoreY - 3.5 + Math.sin(x * 0.05 + now * 0.0015) * 1.6 + Math.sin(now * 0.0012) * 1.2;
      if (i && surf[i - 1] === x - 6) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    for (const sail of sails) {
      sail.d += sail.dir * sail.speed * dt;
      if (sail.d > 75) sail.d = -75; else if (sail.d < -75) sail.d = 75;
      const pt = iso((sail.s0 + sail.d) / 2, 0, (sail.s0 - sail.d) / 2);
      if (hidden(pt, sail.s0 * 2)) continue;
      const k2 = 0.55 + sail.s0 / SHORE * 0.6; // nearer boats are bigger
      ctx.fillStyle = p.ink;
      ctx.beginPath(); ctx.moveTo(pt[0] - 9 * k2, pt[1]); ctx.lineTo(pt[0] + 9 * k2, pt[1]); ctx.lineTo(pt[0] + 6 * k2, pt[1] + 3.5 * k2); ctx.lineTo(pt[0] - 6 * k2, pt[1] + 3.5 * k2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = p.sail;
      ctx.beginPath(); ctx.moveTo(pt[0] - sail.dir * 1, pt[1] - 1); ctx.lineTo(pt[0] - sail.dir * 1, pt[1] - 17 * k2); ctx.lineTo(pt[0] + sail.dir * 8 * k2, pt[1] - 2); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(pt[0] - sail.dir * 2.5, pt[1] - 1); ctx.lineTo(pt[0] - sail.dir * 2.5, pt[1] - 13 * k2); ctx.lineTo(pt[0] - sail.dir * 8 * k2, pt[1] - 2); ctx.closePath(); ctx.fill();
    }
    for (const person of people) {
      person.a += (Math.sin(now * 0.001 + person.x) * 0.02);
      person.x += Math.cos(person.a) * 0.0006 * dt;
      person.z += Math.sin(person.a) * 0.0006 * dt;
      if (person.x < PLAZA.x0 + 0.5 || person.x > PLAZA.x1 - 0.5 || person.z < PLAZA.z0 + 0.5 || person.z > PLAZA.z1 - 0.5) person.a += Math.PI;
      const pt = iso(person.x, 0, person.z);
      if (hidden(pt, person.x * 2 + person.z * 2)) continue;
      ctx.fillStyle = person.color;
      ctx.fillRect(pt[0] - 1.5, pt[1] - 7, 3, 6);
      ctx.fillStyle = p.ink;
      ctx.beginPath(); ctx.arc(pt[0], pt[1] - 8.5, 1.8, 0, Math.PI * 2); ctx.fill();
    }
    if (p.lit) { // night: street lamps along the avenues
      for (const [a, b] of AVENUES) for (let z = 1; z < 40; z += 4) {
        if (!onLand(b, z, 0.5)) continue;
        const [lx, ly] = iso(b + 0.2, 0, z);
        if (hidden([lx, ly - 8], b * 2 + z * 2)) continue;
        ctx.fillStyle = 'rgba(255,207,115,0.18)';
        ctx.beginPath(); ctx.arc(lx, ly - 10, 14, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = p.lit;
        ctx.fillRect(lx - 1.5, ly - 12, 3, 3);
      }
    }
  }

  function drawCar(x, y, z, car, p) {
    const along = car.axis === 'x';
    const L = 1.0, W = 0.5;
    const box = (cx, cz, l, w, y0, y1, color) => {
      const [hx, hz] = along ? [l / 2, w / 2] : [w / 2, l / 2];
      const a = iso(cx - hx, y1, cz - hz), b = iso(cx + hx, y1, cz - hz), c = iso(cx + hx, y1, cz + hz), d = iso(cx - hx, y1, cz + hz);
      const c0 = iso(cx + hx, y0, cz + hz), d0 = iso(cx - hx, y0, cz + hz), b0 = iso(cx + hx, y0, cz - hz);
      poly(ctx, [d, c, c0, d0], shade(color, 0.82));
      poly(ctx, [c, b, b0, c0], shade(color, 0.66));
      poly(ctx, [a, b, c, d], color);
      return { d, c, c0, d0 };
    };
    // body, then a shorter cabin set back a little in the direction of travel, with dark glass
    const off = 0.08 * car.dir;
    const fx = along ? x - off : x, fz = along ? z : z - off;
    box(x, z, L, W, y + 0.06, y + 0.24, car.color);
    const cab = box(fx, fz, L * 0.52, W * 0.86, y + 0.24, y + 0.42, car.color);
    ctx.fillStyle = night ? 'rgba(255,214,140,0.55)' : 'rgba(40,40,60,0.55)';
    ctx.beginPath(); [cab.d, cab.c, cab.c0, cab.d0].forEach(([px, py], i) => {
      const qx = px, qy = i < 2 ? py + 1 : py - 1; i ? ctx.lineTo(qx, qy) : ctx.moveTo(qx, qy);
    }); ctx.closePath(); ctx.fill();
    if (p.lit) { const h = iso(x + (along ? car.dir * L / 2 : 0), y + 0.15, z + (along ? 0 : car.dir * L / 2)); ctx.fillStyle = p.lit; ctx.fillRect(h[0] - 1.5, h[1] - 1.5, 3, 3); }
    const [ex, ez] = along ? [L / 2, W / 2] : [W / 2, L / 2];
    occlude(x - ex, x + ex, z - ez, z + ez, y);
  }

  // Paint back whatever stands in front of a moving thing, straight from the cached world, so it
  // passes behind buildings and billboards instead of over them.
  function occlude(x0, x1, z0, z1, y) {
    // On this projection a box hides another only if it lies wholly further along x or wholly further along z.
    // (Comparing centres goes wrong for big buildings next to small cars.)
    const left = iso(x0, y, z1), right = iso(x1, y, z0), top = iso(x0, y + 0.5, z0), bottom = iso(x1, y, z1);
    const sx0 = left[0], sx1 = right[0], sy0 = top[1], sy1 = bottom[1];
    for (const b of buildings) {
      if (!(b.x0 >= x1 - 0.01 || b.z0 >= z1 - 0.01)) continue;
      if (sx1 < b.box.x0 || sx0 > b.box.x1 || sy1 < b.box.y0 || sy0 > b.box.y1) continue;
      ctx.save();
      ctx.globalAlpha = 1; // a car fading out at the beach still passes fully behind buildings
      ctx.beginPath();
      b.sil.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.closePath();
      if (b.board) { b.board.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py))); ctx.closePath(); }
      ctx.clip();
      ctx.drawImage(world, view.x0, view.y0, world.width / k, world.height / k);
      ctx.restore();
    }
  }

  // Pulsing dots over every file, like markers on a map.
  function drawHotspots(now) {
    murals.forEach((m, i) => {
      const [x, y] = m.center;
      const pulse = reduceMotion ? 0.4 : (now / 1400 + i * 0.17) % 1;
      const color = colorFor(m.file.name);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.45 * (1 - pulse);
      const big = i === hovered || i === selected ? 1.5 : 1;
      ctx.beginPath(); ctx.arc(x, y, ((9 + pulse * 18) * big) / cam.z * fit, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(x, y, 6.5 / cam.z * fit, 0, Math.PI * 2);
      ctx.fillStyle = '#fbf3e6'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 4 / cam.z * fit, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
    });
  }

  function drawPlane({ from, to, progress }) {
    const hops = 4;
    const x = from[0] + (to[0] - from[0]) * progress;
    const y = from[1] + (to[1] - from[1]) * progress - Math.abs(Math.sin(progress * hops * Math.PI)) * 80;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.4 + Math.sin(progress * 10) * 0.2);
    ctx.fillStyle = '#fbf3e6';
    ctx.strokeStyle = '#2a1f1c';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(-12, 0); ctx.lineTo(14, -7); ctx.lineTo(-2, 9); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-2, 9); ctx.lineTo(14, -7); ctx.lineTo(-4, 2); ctx.closePath(); ctx.fillStyle = '#e8d9c4'; ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  /* ---- input ---- */
  let drag = null;
  const pointers = new Map();
  let pinch = null;
  const toWorld = (e) => {
    const rect = canvas.getBoundingClientRect();
    return [cam.x + (e.clientX - rect.left) / cam.z, cam.y + (e.clientY - rect.top) / cam.z];
  };
  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    canvas.setPointerCapture(e.pointerId);
    tween = null;
    cam.vx = cam.vy = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
      drag = null;
    } else {
      drag = { sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y, moved: false, lx: e.clientX, ly: e.clientY };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const rect = canvas.getBoundingClientRect();
      zoomAt(d / pinch.d, (a[0] + b[0]) / 2 - rect.left, (a[1] + b[1]) / 2 - rect.top);
      pinch.d = d;
      return;
    }
    if (drag) {
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (Math.hypot(dx, dy) > 6) drag.moved = true;
      if (drag.moved) {
        cam.vx = e.clientX - drag.lx; cam.vy = e.clientY - drag.ly;
        drag.lx = e.clientX; drag.ly = e.clientY;
        cam.x = drag.cx - dx / cam.z; cam.y = drag.cy - dy / cam.z;
        clamp();
        requestDraw();
      }
      return;
    }
    if (e.pointerType === 'mouse') { // hover: name the file under the cursor
      const w = toWorld(e);
      const hit = murals.findIndex((m) => inside(w, m.poly) || Math.hypot(w[0] - m.center[0], w[1] - m.center[1]) < 14 / cam.z);
      if (hit !== hovered) { hovered = hit; requestDraw(); }
      const rect = canvas.getBoundingClientRect();
      onHover(hit, e.clientX - rect.left, e.clientY - rect.top);
    }
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && !drag.moved && e.type === 'pointerup') {
      const w = toWorld(e);
      const hit = murals.findIndex((m) => inside(w, m.poly) || Math.hypot(w[0] - m.center[0], w[1] - m.center[1]) < 18 / cam.z);
      if (hit >= 0) onSelect(hit);
    }
    drag = null;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => { if (hovered >= 0) { hovered = -1; requestDraw(); } onHover(-2, 0, 0); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    else { cam.x += e.deltaX / cam.z; clamp(); requestDraw(); }
  }, { passive: false });

  function inside([x, y], pts) {
    let hit = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }

  new ResizeObserver(resize).observe(canvas);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) requestDraw(); });

  return {
    setFiles,
    murals: () => murals,
    setNight(value) { night = value; render(); },
    select(index, animate = true) {
      selected = index;
      if (murals[index]) flyTo(murals[index].center, fit * 1.7, animate);
      requestDraw();
    },
    zoomBy(f) { zoomAt(f, cssW / 2, cssH / 2); },
    overview() { selected = -1; flyTo([cam.x + visW() / 2, cam.y + visH() / 2], fit); },
    // the opening: a slow aerial glide across the city
    tour() {
      flyTo([view.x0 + W * 0.3, view.y0 + H * 0.42], fit * 1.4, false);
      flyTo([view.x0 + W * 0.66, view.y0 + H * 0.58], fit * 1.4, true, 16000);
    },
    // entering: dive in over the plaza, then pull back to the whole city
    arrive() {
      const plaza = iso(centre[0], 0, centre[1]);
      flyTo(plaza, fit * 1.7, false);
      flyTo([plaza[0], plaza[1] - 40], fit, true, 2400);
    },
    // An upload: a paper plane hops over the rooftops to the billboard the file will go up on.
    startFlight() {
      const target = boards[0] ? centerOf(boards[0].poly) : [cam.x + visW() / 2, cam.y + visH() / 2];
      flyTo([(target[0] + cam.x + visW() / 2) / 2, (target[1] + cam.y + visH() / 2) / 2], cam.z);
      flight = { from: [cam.x + 40 / cam.z, cam.y + visH() - 80 / cam.z], to: target, progress: 0 };
      requestDraw();
    },
    flightProgress(p) { if (flight) { flight.progress = p; requestDraw(); } },
    endFlight() { flight = null; requestDraw(); },
    celebrate(index) {
      if (!murals[index]) return;
      splash = { at: murals[index].center, start: performance.now(), seed: hash(murals[index].file.name) };
      requestDraw();
    },
  };
}

/* ===================================================================== */
/* Page                                                                  */
/* ===================================================================== */

let state = { me: '', you: '', local: false, devices: [], files: [], texts: [] };
let filesKey = '';
let knownFiles = null;
let selected = -1;
let pollTimer = 0;
let lastOnline = true;
let lastTextAt = null;     // newest message time we have already shown
let seenTexts = new Set(); // for highlighting new rows in the PC's message list

const city = createCity($('#city'), { imageUrl: fileUrl, onSelect: (i) => select(i), onHover: (i, x, y) => hover(i, x, y), onFrame: placeRemoveButtons });

/* ---- removing files: an × on each file in the city and in the inbox. Two clicks, so a slip does not delete. ---- */
// Only one file can be "armed" at a time; the state lives here, not on the button, because the inbox list
// is rebuilt on every poll and would otherwise forget the first click.
let armedName = null, armedTimer = 0;
function setArmed(name) {
  armedName = name;
  clearTimeout(armedTimer);
  if (name) armedTimer = setTimeout(() => setArmed(null), 3000);
  document.querySelectorAll('.remove').forEach((b) => {
    const on = b.dataset.name === armedName;
    b.classList.toggle('armed', on);
    b.setAttribute('aria-label', on ? `Click again to remove ${b.dataset.name}` : `Remove ${b.dataset.name}`);
  });
}

async function removeFile(name) {
  if (armedName !== name) { setArmed(name); return; }
  setArmed(null);
  try {
    await call('/api/remove?name=' + encodeURIComponent(name), { method: 'POST' });
    toast(`Removed ${name}`);
    if (!$('#story').hidden && city.murals()[selected]?.file.name === name) closeStory(false); // camera stays put
    await refresh();
  } catch (e) {
    if (!(e instanceof PinError)) toast('Could not remove that file');
  }
}

function removeButton(name) {
  const b = el('button', { type: 'button', className: 'remove' }, icon('i-x'));
  b.dataset.name = name;
  b.classList.toggle('armed', armedName === name);
  b.setAttribute('aria-label', (armedName === name ? 'Click again to remove ' : 'Remove ') + name);
  b.addEventListener('pointerdown', (e) => e.stopPropagation()); // never starts a drag of the city
  b.addEventListener('click', (e) => { e.stopPropagation(); removeFile(name); });
  return b;
}

const pinLayer = $('#removeLayer');
const pinButtons = new Map(); // file name -> button over the city
function placeRemoveButtons(points) {
  const murals = city.murals();
  const w = pinLayer.clientWidth, h = pinLayer.clientHeight;
  const seen = new Set();
  murals.forEach((m, i) => {
    if (!m.file.removable) return;
    const name = m.file.name;
    seen.add(name);
    let b = pinButtons.get(name);
    if (!b) { b = removeButton(name); pinButtons.set(name, b); pinLayer.append(b); }
    const { x, y } = points[i];
    b.hidden = x < 8 || y < 8 || x > w - 8 || y > h - 8;
    b.style.transform = `translate3d(${x - 11}px, ${y - 11}px, 0)`;
  });
  for (const [name, b] of pinButtons) if (!seen.has(name)) { b.remove(); pinButtons.delete(name); }
}

/* ---- toast ---- */
let toastTimer = 0;
function toast(message, ms = 2600) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ---- polling ---- */
async function refresh() {
  clearTimeout(pollTimer);
  if (!pin && !isLocal) return;
  try {
    const next = await (await call('/api/state')).json();
    state = next;
    if (!lastOnline) toast('Back online');
    lastOnline = true;
    const key = next.files.map((f) => f.name + ':' + f.size).join('|');
    if (key !== filesKey) {
      filesKey = key;
      const fresh = arrival(next.files);
      const keep = city.murals()[selected]?.file.name;
      city.setFiles(next.files);
      const murals = city.murals();
      const freshIndex = fresh ? murals.findIndex((m) => m.file.name === fresh.name) : -1;
      if (fresh) transmission(fresh);
      if (freshIndex >= 0) { // a new arrival: fly to it and splash, but let the person decide to open it
        select(freshIndex, true, false);
        city.celebrate(freshIndex);
      } else { // keep the bottom strip on the same file without moving the camera
        const keepIndex = murals.findIndex((m) => m.file.name === keep);
        selected = keepIndex >= 0 ? keepIndex : (murals.length ? 0 : -1);
        updateNav();
      }
    }
    announceText(next.texts);
    renderSheets();
    syncName();
    maybeAskName();
    if (next.chatSeq !== chatLatest || next.session !== chatSession) loadChat();
    if (next.callSeq !== callLatestSeq) pollCallSignals();
    registerKey();
    offerSealed(next.sealed || []);
  } catch (e) {
    if (e instanceof PinError) return; // wait for a new PIN
    if (lastOnline) toast('Lost the PC. Retrying', 0);
    lastOnline = false;
  }
  pollTimer = setTimeout(refresh, POLL_MS);
}

/** A file that showed up since the last poll and did not come from this device. */
function arrival(files) {
  const fresh = knownFiles ? files.find((f) => !knownFiles.has(f.name) && !f.mine) : null;
  knownFiles = new Set(files.map((f) => f.name));
  return fresh;
}

/** Pops the "incoming transmission" card for a message from another device, unless the chat is open anyway. */
function announceText(texts) { // texts are messages from other PCs (the terminal "text" command); only this PC sees them
  const newest = texts.find((t) => !t.mine);
  if (lastTextAt !== null && newest && newest.at > lastTextAt) transmission(null, newest);
  if (newest) lastTextAt = Math.max(lastTextAt || 0, newest.at);
  else if (lastTextAt === null) lastTextAt = 0;
}

let txTimer = 0;
function transmission(file, message) {
  const box = $('#transmission');
  const open = $('#txOpen');
  const copy = $('#txCopy');
  notify(file ? `${file.name}` : `Message from ${message.from}`, file ? `From ${file.from}, ${humanSize(file.size)}` : message.text, file ? 'file' : 'message');
  if (file) {
    $('#txBody').textContent = `${file.name} from ${file.from}`;
    open.href = saveUrl(file.name);
    open.download = file.name;
  } else {
    $('#txBody').textContent = `"${message.text}" from ${message.from}`;
    copy.onclick = () => copyText(message.text);
    $('#txTitle').textContent = message.private ? 'Private message' : 'Incoming transmission';
  }
  if (file) $('#txTitle').textContent = 'Incoming transmission';
  open.hidden = !file;
  copy.hidden = !!file;
  box.hidden = false;
  clearTimeout(txTimer);
  txTimer = setTimeout(() => { box.hidden = true; }, file ? 7000 : 12000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = el('textarea', { value: text });
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy'); // browsers that block the clipboard API on this page
    area.remove();
  }
  toast('Copied');
}

/* ---- bottom navigator ---- */
function select(index, animate = true, story = true) {
  const murals = city.murals();
  if (!murals.length) { selected = -1; updateNav(); return; }
  selected = (index + murals.length) % murals.length;
  city.select(selected, animate);
  updateNav();
  if (story) openStory(selected);
}

/* ---- after the city opens: ring cursor, hover preview, story panel ---- */
/** "Aryan → Everyone" style: who sent it, and to whom. "You" when it is this device. */
function route(f) {
  const from = f.mine ? 'You' : f.from;
  const to = !f.to || f.to === 'everyone' ? 'Everyone' : f.to === state.you ? 'You' : f.to;
  return `${from} → ${to}`;
}

function paintThumb(el, f) {
  el.style.backgroundColor = colorFor(f.name);
  el.style.backgroundImage = isImage(f) ? `url("${fileUrl(f.name)}")` : '';
  el.textContent = isImage(f) ? '' : (extOf(f.name) || 'file').toUpperCase().slice(0, 4);
}

function hover(index, x, y) {
  const ring = $('#ring');
  const peek = $('#peek');
  if (index === -2) { ring.hidden = true; peek.hidden = true; return; }
  const rect = $('#city').getBoundingClientRect();
  ring.hidden = false;
  ring.style.transform = `translate(${rect.left + x}px, ${rect.top + y}px)`;
  ring.classList.toggle('hot', index >= 0);
  const m = city.murals()[index];
  if (!m) { peek.hidden = true; return; }
  paintThumb($('#peekThumb'), m.file);
  $('#peekName').textContent = m.file.name;
  $('#peekMeta').textContent = `${route(m.file)}, ${humanSize(m.file.size)}`;
  peek.style.transform = `translate(${Math.min(x + 22, rect.width - 280)}px, ${Math.max(y - 70, 8)}px)`;
  peek.hidden = false;
}

function openStory(index) {
  const m = city.murals()[index];
  if (!m) return;
  const story = $('#story');
  const art = $('#storyArt');
  paintThumb(art, m.file);
  $('#storyKicker').textContent = m.kind === 'billboard' ? '[up on a billboard]' : '[painted on a wall]';
  $('#storyTitle').textContent = m.file.name;
  $('#storyMeta').textContent = `${route(m.file)}\n${humanSize(m.file.size)}, ${timeAgo(m.file.at)}`;
  $('#storySave').href = saveUrl(m.file.name);
  $('#storySave').download = m.file.name;
  $('#storyCount').textContent = `${index + 1} / ${city.murals().length}`;
  story.hidden = false;
  requestAnimationFrame(() => story.classList.add('open'));
}

function closeStory(zoomOut = true) {
  const story = $('#story');
  story.classList.remove('open');
  setTimeout(() => { if (!story.classList.contains('open')) story.hidden = true; }, 450);
  if (zoomOut) city.overview();
}

$('#storyClose').addEventListener('click', () => closeStory());
$('#storyPrev').addEventListener('click', () => select(selected - 1));
$('#storyNext').addEventListener('click', () => select(selected + 1));
document.addEventListener('keydown', (e) => {
  if ($('#story').hidden || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') closeStory();
  if (e.key === 'ArrowRight') select(selected + 1);
  if (e.key === 'ArrowLeft') select(selected - 1);
});

function updateNav() {
  // the bottom bar now picks who to send to; the story panel handles moving between files
}

/** Who can receive: everyone, the PC (when you are a guest), and every other browser that is connected. */
function renderRecipients(force = false) {
  const people = [];
  if (!state.local && state.meId) people.push({ id: state.meId, name: state.me, key: state.meKey || '', pc: true });
  for (const d of state.devices) if (d.kind !== 'PC' && d.id) people.push({ id: d.id, name: d.name, key: d.key });
  // files: only devices with a key can be picked, and each says whether its key has been verified
  const files = [['*', 'Everyone', false], ...people.map((d) => [d.id,
    `${initials(d.name)} · ${d.name}${d.pc ? ' (PC)' : ''}${d.key ? (isVerified(d.key) ? ' ✓ verified' : ' · not verified') : d.pc ? ' · PC page closed' : ' · no key yet'}`, !d.key])];
  for (const [select, options] of [[$('#sendTo'), files]]) {
    const key = JSON.stringify(options);
    if (select.dataset.key === key && !force) continue; // rebuilding an open dropdown would close it
    const keep = select.value;
    select.replaceChildren(...options.map(([value, text, disabled]) => el('option', { value, textContent: text, disabled })));
    select.value = options.some(([v, , off]) => v === keep && !off) ? keep : '*';
    select.dataset.key = key;
  }
  $('#sendToChat').hidden = $('#sendTo').value === '*';
}

/* ---- avatars: initials in a colour that belongs to the device ---- */
const AVATAR_COLORS = ['#d9412b', '#2f78c4', '#b8861b', '#c94886', '#2a8c5c', '#d96a22', '#6f55b8', '#1d7f85'];
function initials(name) {
  const words = String(name || '?').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}
const avatarColor = (id) => AVATAR_COLORS[hash(String(id || '')) % AVATAR_COLORS.length];
function avatar(d, size = '') {
  const a = el('span', { className: 'avatar' + (size ? ' ' + size : ''), textContent: initials(d.name) });
  a.style.background = avatarColor(d.id || d.name);
  a.setAttribute('aria-hidden', 'true');
  return a;
}

/* ---- sending: a queue that runs a few files at once, small ones first ---- */
const picker = $('#picker');
picker.addEventListener('change', () => {
  const chosen = [...picker.files];
  picker.value = '';
  upload(chosen);
});

const PARALLEL = 3;          // files moving at the same time
const SMALL_FILE = 1 << 20;  // a file up to 1 MB may start even when all lanes are busy with big ones
const AGING_MS = 20000;      // and a big file never waits longer than this behind smaller ones
const jobs = [];             // every send since the page opened: waiting, sending, sent, failed, cancelled
let jobSeq = 0;
let batch = 0;               // goes up each time the queue starts from idle; the button shows this batch's progress
class Cancelled extends Error {}

/** Queues files for whoever is chosen in "Send to" right now. Works any time, also while other files are sending. */
function upload(list) {
  if (!list.length) return;
  const to = $('#sendTo').value;
  // Every file is sealed in this browser for each recipient's key; nobody without a key gets anything.
  const { list: recipients, missing } = E2E && myPair ? recipientsFor(to) : { list: [], missing: [] };
  const keepHere = state.local && to === '*'; // the PC's own files to Everyone also go up in its own city
  if (!recipients.length && !keepHere) {
    toast(!E2E || !myPair ? 'This browser cannot encrypt, so it cannot send. Try a current Chrome, Safari or Firefox.'
      : `${missing.length ? missing.join(', ') : 'Nobody'} cannot receive encrypted files yet. Ask them to open or reload Rooftop.`, 7000);
    return;
  }
  if (missing.length) toast(`Not sent to ${missing.join(', ')}: no key yet, and Rooftop never sends files unencrypted.`, 7000);
  if (!busy()) { batch++; city.startFlight(); }
  const toName = to === '*' ? 'Everyone' : recipients[0]?.name || state.me;
  for (const file of list) {
    jobs.push({ id: ++jobSeq, file, to, toName, recipients, keepHere, sealed: recipients.length > 0,
      state: 'waiting', sent: 0, speed: 0, queuedAt: Date.now(), batch, xhr: null, cancelled: false, note: '' });
  }
  if (jobs.filter((j) => j.state === 'sending').length >= PARALLEL) toast(`${list.length > 1 ? list.length + ' files' : list[0].name} queued`);
  pump();
  renderTray();
}

const busy = () => jobs.some((j) => j.state === 'waiting' || j.state === 'sending');

/** Starts as many waiting files as there are free lanes. */
function pump() {
  for (;;) {
    const waiting = jobs.filter((j) => j.state === 'waiting');
    if (!waiting.length) return;
    const sending = jobs.filter((j) => j.state === 'sending');
    const smallest = waiting.reduce((a, b) => (b.file.size < a.file.size ? b : a));
    let next = null;
    if (sending.length < PARALLEL) next = waiting.find((j) => Date.now() - j.queuedAt > AGING_MS) || smallest;
    else if (sending.length === PARALLEL && smallest.file.size <= SMALL_FILE && sending.every((j) => j.file.size > SMALL_FILE)) next = smallest;
    if (!next) return;
    run(next);
  }
}

async function run(job) {
  job.state = 'sending';
  job.startedAt = performance.now();
  try {
    job.compressed = await worthCompressing(job.file);
    if (job.sealed) await sendSealed(job);
    if (job.keepHere) { // over localhost to its own inbox: the bytes never leave this PC unencrypted
      job.sent = 0;
      const res = await sendOne(job);
      job.savedAs = res?.name || job.file.name;
    }
    job.state = 'sent';
    job.sent = job.file.size;
    if (job.sealed && job.recipients.length === 1) job.note = `Safety code ${await safetyCodeFor(job.recipients[0].key)}`;
    else if (job.sealed) job.note = `end-to-end to ${job.recipients.length} devices`;
  } catch (e) {
    job.state = job.cancelled ? 'cancelled' : 'failed';
    if (!job.cancelled) job.note = e instanceof PinError ? 'needs the PIN, then retry' : e.message;
  }
  job.xhr = null;
  job.endedAt = performance.now();
  pump();
  renderTray();
  if (!busy()) finishBatch();
}

/** Everything in this batch is done: land the plane, tell the person, and show where the last file went up. */
async function finishBatch() {
  city.endFlight();
  const mine = jobs.filter((j) => j.batch === batch);
  const sent = mine.filter((j) => j.state === 'sent'), failed = mine.filter((j) => j.state === 'failed');
  const one = sent.length && sent.every((j) => j.sealed && j.recipients.length === 1 && j.recipients[0].id === sent[0].recipients[0].id);
  if (failed.length) toast(`${sent.length} sent, ${failed.length} failed. Retry from the list.`, 6000);
  else if (one) toast(`Sent end-to-end to ${sent[0].recipients[0].name}. ${sent[sent.length - 1].note}: it should show the same on their screen.`, 10000);
  else if (sent.length) toast(`${sent.length > 1 ? sent.length + ' files' : sent[0].file.name} sent end-to-end${sent[0].to === '*' ? ' to everyone' : ''}`);
  await refresh();
  const last = [...sent].reverse().find((j) => j.savedAs);
  if (last) {
    const index = city.murals().findIndex((m) => m.file.name === last.savedAs);
    if (index >= 0) { select(index, true, false); city.celebrate(index); }
  }
  if (!failed.length) setTimeout(() => { if (!busy()) clearFinished(true); }, 8000);
}

function cancelJob(job) {
  if (job.state === 'waiting') { job.state = 'cancelled'; renderTray(); if (!busy()) finishBatch(); return; }
  if (job.state !== 'sending') return;
  job.cancelled = true;
  job.xhr?.abort();
}

function retryJob(job) {
  Object.assign(job, { state: 'waiting', sent: 0, speed: 0, queuedAt: Date.now(), cancelled: false, note: '' });
  if (!jobs.some((j) => j !== job && j.state === 'sending')) { batch++; city.startFlight(); }
  job.batch = batch;
  pump();
  renderTray();
}

function clearFinished(auto = false) {
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i];
    if (j.state === 'sent' || j.state === 'cancelled' || (!auto && j.state === 'failed')) { jobs.splice(i, 1); trayRows.get(j.id)?.remove(); trayRows.delete(j.id); }
  }
  renderTray();
}

/* ---- the transfers tray: live speed, time left and a speed graph ---- */
const trayRows = new Map(); // job id -> its row, kept so buttons are not rebuilt under the pointer
const speedTrail = [];      // total speed every half second, for the graph
const TRAIL = 60;           // 30 seconds of history
let trayOpen = true;

function duration(seconds) {
  if (!isFinite(seconds)) return '';
  if (seconds < 60) return Math.max(1, Math.round(seconds)) + ' s';
  if (seconds < 3600) return Math.round(seconds / 60) + ' min';
  return Math.floor(seconds / 3600) + ' h ' + Math.round((seconds % 3600) / 60) + ' min';
}
const rate = (bytesPerSecond) => humanSize(Math.max(0, Math.round(bytesPerSecond))) + '/s';

// Twice a second: how fast each file moves, smoothed so the numbers do not jump around.
setInterval(() => {
  const sending = jobs.filter((j) => j.state === 'sending');
  for (const j of sending) {
    const now = performance.now(), dt = (now - (j.lastTick || j.startedAt)) / 1000;
    const instant = dt > 0 ? (j.sent - (j.lastSent || 0)) / dt : 0;
    j.speed = j.speed ? j.speed * 0.6 + instant * 0.4 : instant;
    j.lastTick = now;
    j.lastSent = j.sent;
  }
  if (sending.length || speedTrail.length) {
    speedTrail.push(sending.reduce((a, j) => a + j.speed, 0));
    if (speedTrail.length > TRAIL) speedTrail.shift();
    if (!busy() && speedTrail.every((v) => v === 0)) speedTrail.length = 0;
  }
  if (jobs.length) renderTray();
}, 500);

function renderTray() {
  const tray = $('#tray');
  tray.hidden = !jobs.length;
  if (!jobs.length) { setSendButton(); return; }
  tray.classList.toggle('folded', !trayOpen);
  const active = jobs.filter((j) => j.state === 'sending'), waiting = jobs.filter((j) => j.state === 'waiting');
  const speed = active.reduce((a, j) => a + j.speed, 0);
  const left = [...active, ...waiting].reduce((a, j) => a + j.file.size - j.sent, 0);
  const done = jobs.filter((j) => j.state === 'sent').length, failed = jobs.filter((j) => j.state === 'failed').length;
  $('#trayTitle').textContent = active.length || waiting.length
    ? `Sending ${active.length}${waiting.length ? `, ${waiting.length} waiting` : ''}`
    : failed ? `${done} sent, ${failed} failed` : `${done} sent`;
  $('#traySum').textContent = active.length
    ? `${rate(speed)}${speed > 0 ? ` · ${duration(left / speed)} left` : ''}`
    : waiting.length ? 'Starting' : 'All done';
  drawSpeedGraph();

  const list = $('#trayList');
  for (const j of jobs) {
    let row = trayRows.get(j.id);
    if (!row) {
      row = el('li', { className: 'job' },
        el('span', { className: 'job-name', textContent: j.file.name, title: j.file.name }),
        el('span', { className: 'job-meta' }),
        el('span', { className: 'job-bar' }, el('i')),
        el('button', { type: 'button', className: 'job-act' }));
      row.lastChild.addEventListener('click', () => {
        if (j.state === 'failed' || j.state === 'cancelled') retryJob(j);
        else if (j.state === 'sent') { jobs.splice(jobs.indexOf(j), 1); row.remove(); trayRows.delete(j.id); renderTray(); }
        else cancelJob(j);
      });
      trayRows.set(j.id, row);
      list.append(row);
    }
    row.className = 'job is-' + j.state;
    const pct = j.file.size ? Math.min(100, Math.floor((j.sent / j.file.size) * 100)) : 100;
    const to = j.toName === 'Everyone' ? '' : ` · to ${j.toName}`;
    row.children[1].textContent = {
      waiting: `Waiting · ${humanSize(j.file.size)}${to}`,
      sending: `${pct}% · ${rate(j.speed)}${j.speed > 0 ? ` · ${duration((j.file.size - j.sent) / j.speed)} left` : ''}${j.compressed ? ' · compressed' : ''}${to}`,
      sent: `Sent · ${humanSize(j.file.size)}${j.endedAt ? ` · ${rate(j.file.size / Math.max(0.001, (j.endedAt - j.startedAt) / 1000))}` : ''}${j.note ? ' · ' + j.note : ''}${to}`,
      failed: `Failed: ${j.note}`,
      cancelled: 'Cancelled',
    }[j.state];
    row.children[2].firstChild.style.transform = `scaleX(${j.state === 'sent' ? 1 : pct / 100})`;
    const act = row.lastChild;
    const [iconId, label] = j.state === 'failed' || j.state === 'cancelled' ? ['i-retry', 'Try again'] : j.state === 'sent' ? ['i-x', 'Clear'] : ['i-x', 'Cancel'];
    if (act.dataset.icon !== iconId) { act.replaceChildren(icon(iconId)); act.dataset.icon = iconId; }
    act.setAttribute('aria-label', `${label} ${j.file.name}`);
  }
  $('#trayClear').hidden = !jobs.some((j) => j.state === 'sent' || j.state === 'failed' || j.state === 'cancelled');
  setSendButton();
}

/** The Send button doubles as the progress bar of the current batch. */
function setSendButton() {
  const mine = jobs.filter((j) => j.batch === batch && j.state !== 'cancelled');
  const total = mine.reduce((a, j) => a + j.file.size, 0), sent = mine.reduce((a, j) => a + (j.state === 'sent' ? j.file.size : j.sent), 0);
  const p = total ? sent / total : 1;
  const on = busy();
  const left = jobs.filter((j) => j.state === 'waiting' || j.state === 'sending').length;
  $('#sendLabel').textContent = on ? `Sending ${left > 1 ? left + ' · ' : ''}${Math.round(p * 100)}%` : 'Send files';
  $('#sendFill').style.transform = `scaleX(${on ? p : 0})`;
  if (on) city.flightProgress(p);
}

// One series, so no legend: the title above names it. A 2px line over a faint fill; hover reads a value off it.
let graphHover = -1;
function drawSpeedGraph() {
  const canvas = $('#trayGraph');
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const max = Math.max(1, ...speedTrail) * 1.15;
  const x = (i) => w - (speedTrail.length - 1 - i) * (w / (TRAIL - 1));
  const y = (v) => h - 2 - (v / max) * (h - 6);
  c.strokeStyle = 'rgb(242 238 230 / 0.14)'; // baseline
  c.lineWidth = 1;
  c.beginPath(); c.moveTo(0, h - 1.5); c.lineTo(w, h - 1.5); c.stroke();
  if (speedTrail.length < 2) return;
  c.beginPath();
  speedTrail.forEach((v, i) => (i ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v))));
  c.lineTo(x(speedTrail.length - 1), h); c.lineTo(x(0), h); c.closePath();
  c.fillStyle = 'rgb(42 169 179 / 0.22)';
  c.fill();
  c.beginPath();
  speedTrail.forEach((v, i) => (i ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v))));
  c.strokeStyle = '#2aa9b3';
  c.lineWidth = 2;
  c.lineJoin = 'round';
  c.stroke();
  const i = graphHover >= 0 ? Math.min(graphHover, speedTrail.length - 1) : -1;
  if (i >= 0) {
    c.strokeStyle = 'rgb(242 238 230 / 0.5)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(x(i), 0); c.lineTo(x(i), h); c.stroke();
    c.fillStyle = '#2aa9b3';
    c.strokeStyle = '#171615';
    c.lineWidth = 2;
    c.beginPath(); c.arc(x(i), y(speedTrail[i]), 4, 0, Math.PI * 2); c.fill(); c.stroke();
  }
  $('#trayPeak').textContent = i >= 0 ? `${rate(speedTrail[i])}, ${Math.round((speedTrail.length - 1 - i) / 2)} s ago` : `peak ${rate(Math.max(...speedTrail))}`;
}
$('#trayGraph').addEventListener('pointermove', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const fromRight = Math.round((r.right - e.clientX) / (r.width / (TRAIL - 1)));
  graphHover = speedTrail.length - 1 - fromRight;
  if (graphHover < 0) graphHover = -1;
  drawSpeedGraph();
});
$('#trayGraph').addEventListener('pointerleave', () => { graphHover = -1; drawSpeedGraph(); });
$('#trayFold').addEventListener('click', () => {
  trayOpen = !trayOpen;
  $('#trayFold').setAttribute('aria-expanded', String(trayOpen));
  $('#trayFold').setAttribute('aria-label', trayOpen ? 'Hide the list' : 'Show the list');
  renderTray();
});
$('#trayClear').addEventListener('click', () => clearFinished());

/* ---- compression: only when the file actually shrinks ---- */
const PACKED = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'heif', 'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi',
  'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'zip', 'gz', 'tgz', '7z', 'rar', 'xz', 'bz2', 'zst', 'br',
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'apk', 'aab', 'ipa', 'jar', 'dmg', 'pdf']);
const canGzip = typeof CompressionStream === 'function';
const gzip = (blob) => new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();

/** Packs a quarter megabyte of the file as a test; worth it only if that comes out at least a fifth smaller. */
async function worthCompressing(file) {
  if (!canGzip || file.size < 64 * 1024 || PACKED.has(extOf(file.name))) return false;
  try {
    const sample = file.slice(0, 256 * 1024);
    return (await gzip(sample)).size < sample.size * 0.8;
  } catch {
    return false;
  }
}

// Files go up in 4 MB pieces. If the Wi-Fi drops, each piece is retried; the PC keeps what already arrived,
// so retrying (or sending the same file again later) carries on from there instead of starting over.
const PIECE = 4 * 1024 * 1024;
const RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendOne(job) {
  const file = job.file;
  const key = `${file.name}|${file.size}|${file.lastModified}`;
  let offset = 0, failures = 0;
  for (;;) {
    if (job.cancelled) throw new Cancelled();
    const end = Math.min(file.size, offset + PIECE);
    let res;
    try {
      const raw = file.slice(offset, end);
      const body = job.compressed ? await gzip(raw) : raw;
      res = await sendPiece(job, key, offset, end - offset, body, (loaded) => { job.sent = offset + (body.size ? loaded / body.size : 1) * (end - offset); });
    } catch (e) {
      if (e instanceof PinError || e.fatal || job.cancelled) throw e;
      if (++failures > RETRIES) throw new Error('connection lost. Try again to continue where it stopped');
      job.note = `retrying (${failures} of ${RETRIES})`;
      await sleep(1000 * failures);
      continue; // same offset; if the PC got more than we think, it answers 409 with the right place
    }
    failures = 0;
    job.note = '';
    if (res.done) return res;
    if (res.status === 409 && res.offset > offset) job.note = 'resumed';
    offset = res.offset;
    job.sent = offset;
  }
}

function sendPiece(job, key, offset, rawLength, body, onLoaded) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    job.xhr = x;
    const q = `?name=${encodeURIComponent(job.file.name)}&size=${job.file.size}&key=${encodeURIComponent(key)}&offset=${offset}&to=${encodeURIComponent(job.to)}`
      + (job.compressed ? `&z=gzip&raw=${rawLength}` : '');
    x.open('POST', withPin('/api/upload' + q));
    x.upload.onprogress = (e) => onLoaded(e.loaded);
    x.onload = () => {
      let res = {};
      try { res = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status === 200) resolve(res);
      else if (x.status === 409) resolve({ offset: res.offset, status: 409 }); // the PC tells us where to carry on
      else if (x.status === 403) { askPin('That PIN did not work.'); reject(new PinError()); }
      else if (x.status >= 500) reject(new Error('the PC had a problem'));
      else reject(Object.assign(new Error(x.responseText || 'HTTP ' + x.status), { fatal: true }));
    };
    x.onabort = () => reject(new Cancelled());
    x.onerror = () => reject(new Error('connection lost'));
    x.ontimeout = () => reject(new Error('timed out'));
    x.timeout = 120000;
    x.send(body);
  });
}

/* ---- end-to-end encryption for every file (crypto in e2e.js) ----
   Each browser makes a P-256 key pair per session and keeps it in IndexedDB; the private half cannot be read out,
   not even by this page. Files are sealed here for every recipient's key; the PC only relays sealed bytes and
   deletes them once every recipient has saved its copy. */
const E2E = window.RooftopE2E && window.crypto?.subtle ? window.RooftopE2E : null;
let myPair = null, myRaw = null, myKey = '', keySession = '', keysBusy = null;
let oldPairs = []; // keys from earlier sessions: files for the PC can wait on it across session changes

function keyStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('rooftop', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('keys', mode);
      const r = fn(tx.objectStore('keys'));
      tx.oncomplete = () => resolve(r?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}

/** The key pair for the PC's current session: kept across reloads, replaced as soon as the session changes. */
async function ensureKeys() {
  if (!E2E || !state.session || state.session === keySession) return;
  let stored = null;
  try { stored = await keyStore('readonly', (s) => s.get('me')); } catch { /* private browsing: a key for this visit only */ }
  try { oldPairs = (await keyStore('readonly', (s) => s.get('old'))) || []; } catch { /* none */ }
  if (stored?.session === state.session && stored.pair) myPair = stored.pair;
  else {
    if (stored?.pair) oldPairs = [stored.pair, ...oldPairs].slice(0, 20);
    myPair = await E2E.newKeyPair();
    try {
      await keyStore('readwrite', (s) => { s.put(oldPairs, 'old'); return s.put({ session: state.session, pair: myPair }, 'me'); });
    } catch { /* kept in memory */ }
  }
  myRaw = await E2E.publicRaw(myPair);
  myKey = E2E.b64(myRaw);
  keySession = state.session;
}

async function registerKey() {
  if (!keysBusy) keysBusy = ensureKeys().catch(() => { myPair = null; }).finally(() => { keysBusy = null; });
  await keysBusy;
  if (!myKey || state.youKey === myKey) return;
  // The PC's page is the one device that can be open in two browsers at once (both are "this PC"). Each registers
  // once per session, or again if the PC forgot its key, so the one opened last owns it instead of the two swapping
  // it on every poll. Phones each have their own device id, so they simply re-register.
  if (isLocal && state.youKey && hostRegistered === keySession + myKey) return;
  hostRegistered = keySession + myKey;
  await call('/api/key', { method: 'POST', body: myKey }).catch(() => {});
}
let hostRegistered = '';

const safetyCodeFor = (theirKey) => E2E.safetyCode(myRaw, E2E.unb64(theirKey));

/* ---- verification: a short code to compare, or a QR code the other device scans with its camera ---- */
const verified = new Set(JSON.parse(local.get('rooftop-verified') || '[]'));
const keyFingerprints = new Map();
/** 120 bits of SHA-256 of the key: short enough for a QR code, far too long to fake. */
async function fingerprint(key) {
  if (!keyFingerprints.has(key)) keyFingerprints.set(key, E2E.b64(new Uint8Array(await crypto.subtle.digest('SHA-256', E2E.unb64(key)))).slice(0, 20));
  return keyFingerprints.get(key);
}
const isVerified = (key) => !!key && keyFingerprints.has(key) && verified.has(keyFingerprints.get(key));
function setVerified(print, on) {
  if (on) verified.add(print); else verified.delete(print);
  local.set('rooftop-verified', JSON.stringify([...verified].slice(-300)));
}
// Opened from another device's QR code: https://<pc>:8443/#v=<fingerprint> (a new tab, or this one if already open)
function verifyFromLink() {
  if (!/^#v=[A-Za-z0-9_-]{20}$/.test(location.hash)) return;
  setVerified(location.hash.slice(3), true);
  history.replaceState(null, '', location.pathname + location.search);
  setTimeout(() => toast('Key verified. That device is now marked as verified here.', 5000), 300);
  if (state.session) renderKeys().then(() => renderRecipients(true));
}
verifyFromLink();
window.addEventListener('hashchange', verifyFromLink);

/** Who a file sent to "to" would reach: devices with a key, and the names of those that have none yet. */
function recipientsFor(to) {
  const all = [];
  if (!state.local) all.push({ id: state.meId, name: state.me, key: state.meKey || '', pc: true });
  for (const d of state.devices) if (d.kind !== 'PC' && d.id) all.push({ id: d.id, name: d.name, key: d.key });
  const chosen = to === '*' ? all : all.filter((d) => d.id === to);
  return { list: chosen.filter((d) => d.key), missing: chosen.filter((d) => !d.key).map((d) => d.name) };
}

const UPLOAD_BATCH = 4 * 1024 * 1024;
async function sendSealed(job) {
  const file = job.file;
  const data = job.compressed ? await gzip(file) : file;
  const details = { name: file.name, type: file.type || '', z: job.compressed ? 'gzip' : '', to: job.to === '*' ? 'everyone' : 'direct' };
  const { total, pieces } = await E2E.seal(data, details, job.recipients.map((r) => E2E.unb64(r.key)), myPair);
  const key = E2E.b64(crypto.getRandomValues(new Uint8Array(12))); // a new id per send
  const to = job.recipients.map((r) => r.id).join(',');
  let offset = 0;
  // 1 MB sealed chunks are sent about 4 at a time: every request is a new connection (and TLS handshake), so fewer,
  // bigger requests go faster. Still in order, so a dropped request resumes at the right byte.
  async function* batched() {
    let parts = [], size = 0;
    for await (const p of pieces) {
      parts.push(p);
      size += p.length;
      if (size >= UPLOAD_BATCH) { yield new Blob(parts); parts = []; size = 0; }
    }
    if (parts.length) yield new Blob(parts);
  }
  for await (const piece of batched()) {
    let at = offset; // where the PC is inside this batch: after a dropped connection it may hold part of it
    for (let failures = 0; ;) {
      if (job.cancelled) throw new Cancelled();
      try {
        const part = at === offset ? piece : piece.slice(at - offset);
        const res = await postSealed(job, part, key, at, total, to, (loaded) => { job.sent = ((at + loaded) / total) * file.size; });
        if (res.offset === offset + piece.size) break;
        if (res.offset > offset && res.offset < offset + piece.size) { at = res.offset; continue; } // carry on from there
        if (res.offset !== at) throw Object.assign(new Error('the PC lost track of this file'), { fatal: true });
      } catch (e) {
        if (e instanceof PinError || e.fatal || job.cancelled || ++failures > RETRIES) throw e;
        job.note = `retrying (${failures} of ${RETRIES})`;
        await sleep(1000 * failures);
      }
    }
    offset += piece.size;
  }
  job.note = '';
  return null;
}

function postSealed(job, piece, key, offset, total, to, onLoaded) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    job.xhr = x;
    x.open('POST', withPin(`/api/sealed/upload?key=${key}&offset=${offset}&size=${total}&to=${encodeURIComponent(to)}`));
    x.upload.onprogress = (e) => onLoaded(e.loaded);
    x.onload = () => {
      let body = {};
      try { body = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status === 200 || x.status === 409) resolve(body);
      else if (x.status === 403) { askPin('That PIN did not work.'); reject(new PinError()); }
      else reject(Object.assign(new Error(x.responseText || 'HTTP ' + x.status), { fatal: x.status < 500 }));
    };
    x.onabort = () => reject(new Cancelled());
    x.onerror = () => reject(new Error('connection lost'));
    x.send(piece); // a Blob: Chrome uploads a Blob ~50x faster than raw bytes (measured on this PC: ~600 vs ~12 MB/s)
  });
}

/** Downloads and opens one sealed file: { name, blob, sender, code, everyone }. */
async function openSealed(item, onProgress) {
  const res = await call('/api/sealed/' + item.id);
  const out = await E2E.open(res.body.getReader(), [myPair, ...oldPairs], onProgress);
  const senderKey = E2E.b64(out.senderRaw);
  const sender = state.devices.find((d) => d.key === senderKey) || (state.meKey === senderKey ? { id: state.meId, name: state.me } : null);
  await fingerprint(senderKey);
  let blob = new Blob(out.parts, { type: out.details.type || '' });
  if (out.details.z === 'gzip') blob = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
  return { name: out.details.name, blob, sender, senderKey, code: await E2E.safetyCode(myRaw, out.senderRaw), everyone: out.details.to === 'everyone' };
}

// Receiving. Phones: one card at a time; Open = download + decrypt here, Save = keep it, then the PC deletes its copy.
// The PC's own page opens files for the PC by itself and saves them into the PC's inbox (over localhost).
let sealedShowing = null;
const sealedDone = new Set();
function offerSealed(list) {
  if (sealedShowing || !myPair) return;
  const next = list.find((s) => !sealedDone.has(s.id));
  if (!next) return;
  sealedShowing = next;
  if (state.local) { receiveOnHost(next); return; }
  notify('Private file', `${humanSize(next.size)} waiting for you`, 'file');
  $('#sealedBody').textContent = `About ${humanSize(next.size)} waiting for you. Only this device can open it.`;
  $('#sealedCode').textContent = '';
  $('#sealedOpen').hidden = false;
  $('#sealedOpen').disabled = false;
  $('#sealedOpen').textContent = 'Open';
  $('#sealedSave').hidden = true;
  $('#sealedCard').hidden = false;
}

async function receiveOnHost(item) {
  try {
    const got = await openSealed(item, () => {});
    const q = `?name=${encodeURIComponent(got.name)}&to=${got.everyone ? '*' : encodeURIComponent(state.meId)}` + (got.sender ? `&as=${encodeURIComponent(got.sender.id)}` : '');
    await call('/api/upload' + q, { method: 'POST', body: got.blob });
    await call(`/api/sealed/${item.id}/ack`, { method: 'POST' });
    sealedDone.add(item.id);
  } catch (e) {
    if (e instanceof PinError) return;
    sealedDone.add(item.id); // do not loop on it now; the PC keeps it, so reloading this page tries again
    toast(`A private file could not be opened: ${e.message}`, 8000);
  } finally {
    sealedShowing = null;
  }
  refresh();
}

$('#sealedOpen').addEventListener('click', async () => {
  const item = sealedShowing;
  const btn = $('#sealedOpen');
  btn.disabled = true;
  try {
    const got = await openSealed(item, (n) => { btn.textContent = `${Math.min(100, Math.round((n / item.size) * 100))}%`; });
    const url = URL.createObjectURL(got.blob);
    const save = $('#sealedSave');
    save.href = url;
    save.download = got.name;
    save.textContent = 'Save';
    save.hidden = false;
    btn.hidden = true;
    const trust = isVerified(got.senderKey) ? 'verified' : 'not verified';
    $('#sealedBody').textContent = `${got.name} from ${got.sender ? got.sender.name : 'a device that has left'} (${trust})`;
    $('#sealedCode').replaceChildren('Safety code ', el('b', { textContent: got.code }), '. It should match the sender\'s screen.');
    save.onclick = () => setTimeout(async () => {
      await call(`/api/sealed/${item.id}/ack`, { method: 'POST' }).catch(() => {});
      sealedDone.add(item.id);
      URL.revokeObjectURL(url);
      $('#sealedCard').hidden = true;
      sealedShowing = null;
      toast('Saved. The PC deletes its encrypted copy once everyone has theirs.');
      refresh();
    }, 1500);
  } catch (e) {
    if (e instanceof PinError) return;
    btn.disabled = false;
    btn.textContent = 'Try again';
    $('#sealedBody').textContent = `Could not open it: ${e.message}.`;
  }
});

/* ---- key panels: my QR code, and each device's code with a verify switch ---- */
let qrFor = '';
async function renderKeys() {
  if (!myKey) return;
  const print = await fingerprint(myKey);
  const base = state.local ? (hostUrl || '').split('/?')[0] : location.origin;
  const link = base ? `${base}/#v=${print}` : '';
  if (link && link !== qrFor) {
    qrFor = link;
    try {
      const { qr } = await (await call('/api/qr?text=' + encodeURIComponent(link))).json();
      for (const c of document.querySelectorAll('[data-my-qr]')) drawQr(c, qr);
    } catch { qrFor = ''; }
  }
  for (const list of document.querySelectorAll('[data-key-list]')) {
    const rows = [];
    for (const d of recipientsFor('*').list.concat(state.local ? [] : [])) {
      const code = await safetyCodeFor(d.key);
      const p = await fingerprint(d.key);
      const on = verified.has(p);
      const btn = el('button', { type: 'button', className: 'verify-btn' + (on ? ' on' : ''), textContent: on ? 'Verified' : 'Codes match' });
      btn.setAttribute('aria-pressed', String(on));
      btn.addEventListener('click', () => { setVerified(p, !on); renderKeys(); renderRecipients(true); });
      rows.push(el('li', {}, avatar(d), el('span', { className: 'key-name', textContent: d.name }), el('span', { className: 'code', textContent: code }), btn));
    }
    for (const name of recipientsFor('*').missing) rows.push(el('li', { className: 'no-key' }, el('span', { className: 'key-name', textContent: name }), el('span', { className: 'code', textContent: 'no key yet' })));
    list.replaceChildren(...rows);
    list.hidden = !rows.length;
  }
}

// Scanning a code in the page, where the browser can read QR codes (most Android phones); otherwise use the camera app.
async function scanCode() {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) return;
  const box = $('#scanBox');
  const video = $('#scanVideo');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    toast('No camera access. Use the camera app on the other code instead.', 5000);
    return;
  }
  video.srcObject = stream;
  box.hidden = false;
  await video.play().catch(() => {});
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const stop = () => { stream.getTracks().forEach((t) => t.stop()); box.hidden = true; clearInterval(timer); };
  $('#scanStop').onclick = stop;
  const timer = setInterval(async () => {
    const codes = await detector.detect(video).catch(() => []);
    const m = codes.map((c) => /#v=([A-Za-z0-9_-]{20})$/.exec(c.rawValue)).find(Boolean);
    if (!m) return;
    stop();
    setVerified(m[1], true);
    await renderKeys();
    renderRecipients(true);
    const who = recipientsFor('*').list.find((d) => keyFingerprints.get(d.key) === m[1]);
    toast(who ? `${who.name} is verified` : 'Key verified', 4000);
  }, 350);
}
document.querySelectorAll('[data-scan]').forEach((b) => {
  b.hidden = !('BarcodeDetector' in window);
  b.addEventListener('click', scanCode);
});

// Desktop browsers: drop files anywhere on the city.
const stage = $('#stage');
stage.addEventListener('dragover', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  stage.classList.add('dragging');
});
stage.addEventListener('dragleave', (e) => { if (e.target === stage || !stage.contains(e.relatedTarget)) stage.classList.remove('dragging'); });
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('dragging');
  upload([...e.dataTransfer.files]);
});

/* ---- sheets ---- */
document.querySelectorAll('[data-sheet]').forEach((b) => b.addEventListener('click', () => openSheet(b.dataset.sheet)));
document.querySelectorAll('dialog.sheet').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d && d.id !== 'sheet-pin') d.close(); });
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
});
$('#sheet-pin').addEventListener('cancel', (e) => e.preventDefault()); // nothing works without a PIN

function openSheet(name) {
  renderSheets();
  const d = document.getElementById('sheet-' + name);
  if (!d.open) d.showModal();
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function icon(id) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'i');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#' + id);
  svg.append(use);
  return svg;
}

function renderSheets() {
  renderRecipients();
  const fileList = $('#fileList');
  fileList.replaceChildren(...state.files.map((f) => {
    const badge = el('span', { className: 'badge' });
    badge.style.backgroundColor = colorFor(f.name);
    if (isImage(f)) badge.style.backgroundImage = `url("${fileUrl(f.name)}")`;
    else badge.textContent = (extOf(f.name) || 'file').toUpperCase().slice(0, 4);
    const info = el('div', {}, el('div', { className: 'name', title: f.name, textContent: f.name }),
      el('div', { className: 'meta', textContent: `${route(f)}, ${humanSize(f.size)}, ${timeAgo(f.at)}` }));
    const dl = el('a', { className: 'dl', href: saveUrl(f.name), download: f.name }, icon('i-down'));
    dl.setAttribute('aria-label', `Save ${f.name}`);
    return el('li', {}, badge, info, dl, ...(f.removable ? [removeButton(f.name)] : []));
  }));
  $('#fileEmpty').hidden = state.files.length > 0;

  renderChatAll();

  $('.you').hidden = state.local;
  $('#nameForm').hidden = state.local;
  $('#youName').textContent = state.you || 'this device';
  if (document.activeElement !== $('#myName')) $('#myName').value = local.get('rooftop-name') || '';
  $('#pcName').textContent = state.me || 'the PC';
  const allDevices = [...state.devices];
  if (!state.local && state.meId) {
    allDevices.unshift({ id: state.meId, name: state.me || 'the PC', kind: 'PC' });
  }
  $('#deviceList').replaceChildren(...allDevices.map((d) => {
    const callBtn = el('button', { className: 'call-dev-btn', type: 'button', title: `Video call ${d.name}` }, icon('i-video'));
    callBtn.setAttribute('aria-label', `Video call ${d.name}`);
    callBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      $('#sheet-nearby').close();
      startVideoCall(d.id, d.name);
    });
    const li = el('li', { className: d.kind === 'PC' && state.local ? '' : 'tap' }, avatar(d), el('span', { className: 'dev-name', textContent: d.name }), el('span', { className: 'kind', textContent: d.kind }), callBtn);
    if (!(d.kind === 'PC' && state.local)) { li.dataset.id = d.id; li.title = `Chat with ${d.name}`; }
    return li;
  }));
  $('#deviceList').hidden = !allDevices.length;
  $('#deviceEmpty').hidden = allDevices.length > 0;
  if (isLocal) renderHost();
  renderCallSheet();
  renderNotify();
  renderKeys().then(() => renderRecipients());
  if ($('#sheet-inbox').open && !$('#panelHistory').hidden && state.historyAt !== historyAt) loadHistory();
}

function renderCallSheet() {
  const list = $('#callDeviceList');
  const empty = $('#callDeviceEmpty');
  if (!list) return;
  const allDevices = [...state.devices];
  if (!state.local && state.meId) {
    allDevices.unshift({ id: state.meId, name: state.me || 'the PC', kind: 'PC' });
  }
  const devList = allDevices.filter((d) => d.id !== state.youId);
  list.replaceChildren(...devList.map((d) => {
    const callBtn = el('button', { className: 'pill pill-primary', type: 'button', style: 'margin-left:auto;padding:6px 14px;font-size:12px;display:flex;align-items:center;gap:6px' }, icon('i-video'), 'Call');
    callBtn.addEventListener('click', () => {
      $('#sheet-call').close();
      startVideoCall(d.id, d.name);
    });
    return el('li', { style: 'display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--ink-line)' },
      avatar(d),
      el('span', { className: 'dev-name', textContent: d.name, style: 'font-weight:600' }),
      el('span', { className: 'kind', textContent: d.kind, style: 'font-size:11px;color:var(--chalk-dim)' }),
      callBtn
    );
  }));
  list.hidden = !devList.length;
  empty.hidden = devList.length > 0;
}

/* ---- the PC's own console ---- */
function renderHost() {
  $('#hostCount').textContent = state.devices.length;
  $('#hostDevices').replaceChildren(...state.devices.map((d) => {
    const callBtn = el('button', { className: 'call-dev-btn', type: 'button', title: `Video call ${d.name}` }, icon('i-video'));
    callBtn.setAttribute('aria-label', `Video call ${d.name}`);
    callBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startVideoCall(d.id, d.name);
    });
    return el('li', {}, avatar(d), el('span', { className: 'dev-name', textContent: d.name }), el('span', { className: 'kind', textContent: d.kind }), callBtn);
  }));
  $('#hostDevices').hidden = !state.devices.length;
  $('#hostDevicesEmpty').hidden = state.devices.length > 0;

  const first = seenTexts.size === 0;
  $('#hostMessages').replaceChildren(...state.texts.map((t) => {
    const key = t.at + t.from;
    const copy = el('button', { className: 'icon-btn', type: 'button' }, icon('i-copy'));
    copy.setAttribute('aria-label', 'Copy message');
    copy.addEventListener('click', () => copyText(t.text));
    const li = el('li', {}, avatar({ id: t.fromId, name: t.from }), el('span', { className: 'msg', textContent: t.text }),
      el('span', { className: 'meta', textContent: `${t.mine ? 'You' : t.from}${t.private ? ' → ' + t.to : ''}, ${timeAgo(t.at)}` }), copy);
    if (!first && !seenTexts.has(key)) li.classList.add('fresh');
    return li;
  }));
  seenTexts = new Set(state.texts.map((t) => t.at + t.from));
  if (first && !state.texts.length) seenTexts.add('none');
  $('#hostMessages').hidden = !state.texts.length;
  $('#hostMessagesEmpty').hidden = state.texts.length > 0;
  if (document.activeElement !== $('#hostName')) $('#hostName').value = state.me;
}

let hostUrl = '';
async function loadConnect() {
  try {
    const info = await (await call('/api/connect')).json();
    if (hostUrl && info.url !== hostUrl) toast('Network changed. New QR code ready', 5000);
    if (info.url === hostUrl) return;
    hostUrl = info.url;
    $('#hostUrl').textContent = info.url;
    $('#hostPin').textContent = info.pin;
    const net = $('#hostNet');
    net.classList.toggle('warn', !info.secure);
    net.textContent = info.secure
      ? 'Phones must be on the same Wi-Fi or hotspot as this PC. Switch networks and this code updates on its own.'
      : 'HTTPS could not start, so phones cannot connect. See the Rooftop terminal for the reason.';
    drawQr($('#hostQr'), info.qr);
  } catch {
    $('#hostNet').textContent = 'Rooftop is not answering. Is it still running in the terminal?';
  }
}

function drawQr(canvas, rows) {
  const c = canvas.getContext('2d');
  const n = rows.length;
  const cell = Math.floor(canvas.width / n);
  const offset = Math.floor((canvas.width - cell * n) / 2);
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = '#111111';
  rows.forEach((row, y) => [...row].forEach((bit, x) => { if (bit === '1') c.fillRect(offset + x * cell, offset + y * cell, cell, cell); }));
}

$('#copyUrl').addEventListener('click', () => copyText(hostUrl));

// Ending a session takes two clicks, so a stray click cannot kick everyone off.
let sessionArmed = 0;
$('#newSession').addEventListener('click', async () => {
  const btn = $('#newSession');
  if (!sessionArmed) {
    btn.textContent = 'Click again to end the session';
    btn.classList.add('armed');
    sessionArmed = setTimeout(() => { sessionArmed = 0; btn.textContent = 'End session, start new'; btn.classList.remove('armed'); }, 4000);
    return;
  }
  clearTimeout(sessionArmed); sessionArmed = 0;
  btn.classList.remove('armed');
  btn.textContent = 'End session, start new';
  try {
    await call('/api/session', { method: 'POST' });
    hostUrl = '';
    await loadConnect();
    await refresh();
    toast('New session started. Share the new QR code or PIN.', 5000);
  } catch {
    toast('Could not start a new session.');
  }
});

/* ---- chat: conversations sealed end to end, like the files ----
   Everyone (the room), one personal chat per person, and named groups. Every message, typing signal and group change
   is sealed here for each recipient's session key; the PC only relays ciphertext. Conversations exist only in the
   browsers: the PC sees envelopes, never which conversation they belong to or what they say. */
const convs = new Map();   // id -> { id, kind: 'all' | 'p' | 'g', name, peer, members: Set, msgs: [], lastAt }
const typing = new Map();  // conversation id -> Map(sender id -> until)
let chatCursor = 0, chatLatest = -1, chatSession = '', chatBusy = null, chatLoaded = false, openConv = null, chatWarned = 0, lastTypingSent = 0, pendingClip = null;
let chatRead = JSON.parse(session.get('rooftop-chat-read') || '{}'); // conversation id -> last seq read
const LINK = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

function conv(id) {
  if (!convs.has(id)) {
    if (id === 'all') convs.set(id, { id, kind: 'all', name: 'Everyone', msgs: [], lastAt: 0 });
    else if (id.startsWith('p:')) convs.set(id, { id, kind: 'p', peer: id.slice(2), msgs: [], lastAt: 0 });
    else return null; // groups exist only once someone told us about them
  }
  return convs.get(id);
}
const person = (id) => (id === state.youId ? { id, name: state.local ? state.me : state.you, key: myKey }
  : id === state.meId ? { id, name: state.me, key: state.meKey || '' }
  : (({ name, key }) => ({ id, name, key }))(state.devices.find((d) => d.id === id) || { name: 'someone who left', key: '' }));
const convName = (c) => (c.kind === 'p' ? person(c.peer).name : c.name);

/** Everyone who gets a message in this conversation, as { id, key }: only devices with a key, this one included. */
function chatRecipients(c, withMe = true) {
  let ids;
  if (c.kind === 'all') ids = [...state.devices.filter((d) => d.kind !== 'PC').map((d) => d.id), ...(state.local ? [] : [state.meId])];
  else if (c.kind === 'p') ids = [c.peer];
  else ids = [...c.members].filter((id) => id !== state.youId);
  const out = ids.map(person).filter((p) => p.key);
  if (withMe && myKey) out.push({ id: state.youId, key: myKey });
  return out;
}

async function sendEnvelope(body, c, ttl = 0, withMe = true) {
  const to = chatRecipients(c, withMe);
  if (!to.length || (to.length === 1 && to[0].id === state.youId && c.kind !== 'g')) throw new Error(`${convName(c)} cannot receive encrypted chat yet`);
  const bytes = await E2E.sealMessage(body, to.map((r) => E2E.unb64(r.key)), myPair);
  await call(`/api/chat/send?to=${encodeURIComponent(to.map((r) => r.id).join(','))}&ttl=${ttl}`, { method: 'POST', body: bytes });
}

const wireConv = (c) => (c.kind === 'all' ? { c: 'all' } : c.kind === 'p' ? { c: 'p', to: c.peer } : { c: c.id });

async function loadChat() {
  if (!E2E || !myPair || !state.session) return;
  if (chatBusy) return chatBusy;
  chatBusy = (async () => {
    try {
      if (chatSession !== state.session) { // a new session: every conversation is gone, on the PC and here
        convs.clear();
        typing.clear();
        chatCursor = 0;
        chatRead = {};
        openConv = null;
        chatLoaded = false;
        chatSession = state.session;
      }
      const res = await (await call('/api/chat?after=' + chatCursor)).json();
      chatLatest = res.latest;
      for (const env of res.envelopes) {
        chatCursor = Math.max(chatCursor, env.seq);
        await receiveEnvelope(env);
      }
      chatLoaded = true;
    } catch { /* next poll */ } finally {
      chatBusy = null;
    }
    renderChatAll();
  })();
  return chatBusy;
}

async function receiveEnvelope(env) {
  let out;
  try {
    out = await E2E.openMessage(E2E.unb64(env.data), myPair);
  } catch (e) {
    if (/swapped/.test(e.message)) chatWarning(env.from);
    return;
  }
  // the PC says who sent it; the key inside must be that device's key, or someone is pretending
  const senderKey = E2E.b64(out.senderRaw);
  const expected = person(env.from).key;
  if (!expected || senderKey !== expected) { chatWarning(env.from); return; }
  const b = out.body, from = env.from, mine = from === state.youId, live = chatLoaded;
  const cid = b.c === 'all' ? 'all' : b.c === 'p' ? 'p:' + (mine ? b.to : from) : b.c;
  if (b.k === 'group') {
    if (!b.m.includes(state.youId)) { convs.delete('g:' + b.g); return; }
    convs.set('g:' + b.g, { ...(convs.get('g:' + b.g) || { msgs: [], lastAt: env.at }), id: 'g:' + b.g, kind: 'g', name: String(b.n).slice(0, 40), members: new Set(b.m), by: from });
    const g = convs.get('g:' + b.g);
    g.msgs.push({ system: true, seq: env.seq, at: env.at, text: mine ? `You made the group "${g.name}"` : `${person(from).name} added you to "${g.name}"` });
    g.lastAt = Math.max(g.lastAt, env.at);
    return;
  }
  if (b.k === 'leave') {
    const g = convs.get('g:' + b.g);
    if (!g) return;
    if (mine) { convs.delete(g.id); if (openConv === g.id) openConv = null; return; }
    g.members.delete(from);
    g.msgs.push({ system: true, seq: env.seq, at: env.at, text: `${person(from).name} left` });
    return;
  }
  const c = conv(cid);
  if (!c || (c.kind === 'g' && !c.members.has(from))) return; // not a conversation we are in
  if (b.k === 'typing') {
    if (!mine && live) {
      if (!typing.has(cid)) typing.set(cid, new Map());
      typing.get(cid).set(from, Date.now() + 5000);
    }
    return;
  }
  if (b.k !== 'msg' || typeof b.t !== 'string') return;
  const msg = { id: out.id, seq: env.seq, at: env.at, from, mine, text: b.t.slice(0, 8000), verified: isVerified(senderKey) };
  c.msgs.push(msg);
  c.lastAt = Math.max(c.lastAt, env.at);
  typing.get(cid)?.delete(from);
  if (mine || !live) return;
  const looking = $('#sheet-notes').open && openConv === cid && !document.hidden;
  if (looking) markConvRead(c);
  else {
    popBubble(c, msg);
    notify(c.kind === 'p' ? person(from).name : `${person(from).name} in ${convName(c)}`, msg.text, 'message');
  }
  // this PC's clipboard: messages for the PC (to everyone, or to it in person) land there, decrypted by this page only
  if (state.local && (c.kind === 'all' || c.kind === 'p')) putOnClipboard(msg.text);
}

function chatWarning(from) {
  chatWarned++;
  const c = conv('all');
  c.msgs.push({ system: true, warn: true, seq: chatCursor, at: Date.now(), text: `A message said to be from ${person(from).name} could not be verified and was thrown away. Someone may be tampering.` });
}

async function putOnClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    pendingClip = null;
  } catch {
    pendingClip = text; // the browser only allows it while this page has focus
  }
}
window.addEventListener('focus', () => { if (pendingClip) putOnClipboard(pendingClip); });

function unreadIn(c) {
  const seen = chatRead[c.id] || 0;
  return c.msgs.filter((m) => !m.mine && !m.system && m.seq > seen).length;
}
function markConvRead(c) {
  const top = c.msgs.reduce((a, m) => Math.max(a, m.seq || 0), 0);
  if (top > (chatRead[c.id] || 0)) { chatRead[c.id] = top; session.set('rooftop-chat-read', JSON.stringify(chatRead)); }
}

/* ---- the city bubble: a new message where nobody is looking ---- */
let bubbleTimer = 0;
function popBubble(c, msg) {
  const b = $('#cityBubble');
  b.replaceChildren(avatar(person(msg.from)), el('span', { className: 'cb-text' },
    el('b', { textContent: c.kind === 'p' ? person(msg.from).name : `${person(msg.from).name} · ${convName(c)}` }),
    el('span', { textContent: msg.text.length > 70 ? msg.text.slice(0, 68) + '…' : msg.text })));
  b.dataset.conv = c.id;
  b.dataset.msg = msg.id;
  b.hidden = false;
  b.classList.remove('pop');
  void b.offsetWidth;
  b.classList.add('pop');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { b.hidden = true; }, 6000);
}
$('#cityBubble').addEventListener('click', (e) => {
  const b = e.currentTarget;
  b.hidden = true;
  openChat(b.dataset.conv, b.dataset.msg);
});

/* ---- the chat sheet: a switcher, a conversation, and a "new group" form ---- */
function showPane(name) {
  $('#convPane').classList.toggle('active', name === 'list');
  $('#threadPane').classList.toggle('active', name === 'thread');
  $('#groupPane').hidden = name !== 'group';
  $('#sheet-notes').dataset.pane = name;
}

function openChat(cid, msgId) {
  const d = $('#sheet-notes');
  if (!d.open) { renderSheets(); d.showModal(); }
  if (cid) {
    const c = cid.startsWith('g:') ? convs.get(cid) : conv(cid);
    if (c) {
      openConv = cid;
      markConvRead(c);
      showPane('thread');
      renderChatAll();
      requestAnimationFrame(() => {
        const target = msgId && $(`#textList [data-id="${CSS.escape(msgId)}"]`);
        if (target) { target.scrollIntoView({ block: 'center' }); target.classList.add('flash'); }
        else $('#textList').scrollTop = $('#textList').scrollHeight;
        if (matchMedia('(pointer: fine)').matches) $('#note').focus();
      });
      return;
    }
  }
  openConv = null;
  showPane('list');
  renderChatAll();
}
document.querySelector('[data-sheet="notes"]').addEventListener('click', () => {
  if (openConv && matchMedia('(min-width: 768px)').matches) openChat(openConv); else openChat(null);
});
$('#threadBack').addEventListener('click', () => { openConv = null; showPane('list'); renderChatAll(); });
$('#sheet-notes').addEventListener('close', () => { if (!matchMedia('(min-width: 768px)').matches) openConv = null; });

function renderChatAll() {
  renderConvList();
  renderThread();
  const unread = [...convs.values()].reduce((a, c) => a + unreadIn(c), 0);
  $('#chatDot').hidden = !unread;
  $('#chatDot').textContent = unread > 9 ? '9+' : unread || '';
  $('#chatBtn').setAttribute('aria-label', unread ? `Chat, ${unread} unread` : 'Chat');
  const forHost = $('#hostChatUnread');
  if (forHost) forHost.textContent = unread ? `${unread} unread` : '';
}

function convFace(c) {
  if (c.kind === 'all') { const a = el('span', { className: 'avatar all', textContent: 'ALL' }); a.setAttribute('aria-hidden', 'true'); return a; }
  if (c.kind === 'g') return avatar({ id: c.id, name: c.name });
  return avatar(person(c.peer));
}

function renderConvList() {
  const list = $('#convList');
  const can = !!(E2E && myKey);
  $('#chatNoKey').hidden = can;
  $('#newGroupBtn').hidden = !can;
  if (!can) { list.replaceChildren(); return; }
  conv('all');
  const byRecent = (a, b) => b.lastAt - a.lastAt;
  const groups = [...convs.values()].filter((c) => c.kind === 'g').sort(byRecent);
  const people = [...convs.values()].filter((c) => c.kind === 'p' && c.msgs.length).sort(byRecent);
  const known = new Set(people.map((c) => c.peer));
  // everyone else in the room, to start a personal chat with
  const others = [...state.devices.filter((d) => d.kind !== 'PC'), ...(state.local ? [] : [{ id: state.meId, name: state.me, key: state.meKey }])]
    .filter((d) => d.id && !known.has(d.id));
  const row = (c) => {
    const last = [...c.msgs].reverse().find((m) => !m.system);
    const n = unreadIn(c);
    const b = el('button', { type: 'button', className: 'conv' + (c.id === openConv ? ' open' : '') },
      convFace(c),
      el('span', { className: 'conv-text' },
        el('span', { className: 'conv-name', textContent: convName(c) }),
        el('span', { className: 'conv-last', textContent: last ? `${last.mine ? 'You' : person(last.from).name}: ${last.text}` : c.kind === 'g' ? `${c.members.size} members` : 'No messages yet' })),
      el('span', { className: 'conv-side' }, el('span', { className: 'conv-time', textContent: last ? clock(last.at) : '' }), n ? el('span', { className: 'badge-n', textContent: String(n) }) : ''));
    b.addEventListener('click', () => openChat(c.id));
    return el('li', {}, b);
  };
  const items = [row(conv('all'))];
  if (groups.length) items.push(el('li', { className: 'conv-head', textContent: 'Groups' }), ...groups.map(row));
  if (people.length) items.push(el('li', { className: 'conv-head', textContent: 'Personal' }), ...people.map(row));
  if (others.length) {
    items.push(el('li', { className: 'conv-head', textContent: 'Start a chat' }));
    for (const d of others) {
      const b = el('button', { type: 'button', className: 'conv', disabled: !d.key }, avatar(d),
        el('span', { className: 'conv-text' }, el('span', { className: 'conv-name', textContent: d.name }),
          el('span', { className: 'conv-last', textContent: d.key ? (isVerified(d.key) ? '✓ verified' : 'not verified') : 'no key, cannot chat yet' })));
      b.addEventListener('click', () => openChat('p:' + d.id));
      items.push(el('li', {}, b));
    }
  }
  list.replaceChildren(...items);
}

const clock = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Text with its links made clickable, built from nodes so nothing in a message can become markup. */
function linkify(text) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(LINK)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push(el('a', { href: m[0], textContent: m[0], target: '_blank', rel: 'noopener noreferrer' }));
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

let threadKey = '';
function renderThread() {
  const c = openConv && (openConv.startsWith('g:') ? convs.get(openConv) : conv(openConv));
  if (!c) { if (openConv) { openConv = null; showPane('list'); } return; }
  $('#threadFace').replaceChildren(convFace(c));
  $('#threadTitle').textContent = convName(c);
  const peer = c.kind === 'p' ? person(c.peer) : null;
  $('#threadSub').textContent = c.kind === 'all' ? `Everyone in the room · end-to-end encrypted`
    : c.kind === 'g' ? [...c.members].map((id) => (id === state.youId ? 'You' : person(id).name)).join(', ')
    : peer.key ? `${isVerified(peer.key) ? '✓ verified' : 'not verified'} · end-to-end encrypted` : 'no key, cannot chat yet';
  $('#leaveGroup').hidden = c.kind !== 'g';
  $('#threadCallBtn').hidden = c.kind !== 'p';
  const now = Date.now();
  const typers = [...(typing.get(c.id) || new Map())].filter(([, until]) => until > now).map(([id]) => person(id).name);
  $('#typingLine').textContent = typers.length ? `${typers.join(', ')} ${typers.length > 1 ? 'are' : 'is'} typing…` : '';
  const key = c.id + c.msgs.length + state.you + chatWarned;
  if (key === threadKey) return;
  threadKey = key;
  const box = $('#textList');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const msgs = c.msgs;
  box.replaceChildren(...msgs.map((m, i) => {
    if (m.system) return el('li', { className: 'msg-system' + (m.warn ? ' warn' : ''), textContent: m.text });
    const prev = msgs[i - 1];
    const first = !prev || prev.system || prev.from !== m.from || m.at - prev.at > 5 * 60 * 1000;
    const copy = el('button', { className: 'icon-btn', type: 'button' }, icon('i-copy'));
    copy.setAttribute('aria-label', 'Copy message');
    copy.addEventListener('click', () => copyText(m.text));
    const who = person(m.from);
    const body = el('div', { className: 'msg-body' });
    if (first) body.append(el('div', { className: 'msg-who' }, m.mine ? 'You' : who.name,
      m.mine ? '' : el('span', { className: 'trust' + (m.verified ? ' ok' : ''), textContent: m.verified ? ' ✓ verified' : ' · not verified' })));
    body.append(el('div', { className: 'bubble' }, ...linkify(m.text)), el('div', { className: 'msg-meta' }, el('span', { textContent: clock(m.at) }), copy));
    const li = el('li', { className: 'msg' + (m.mine ? ' mine' : '') + (first ? ' first' : '') }, first ? avatar(who) : el('span', { className: 'avatar-gap' }), body);
    li.dataset.id = m.id;
    return li;
  }));
  $('#textEmpty').hidden = msgs.length > 0;
  if (stick) box.scrollTop = box.scrollHeight;
  if ($('#sheet-notes').open && !document.hidden) markConvRead(c);
}
setInterval(() => { if ($('#sheet-notes').open && openConv) { threadKey = ''; renderThread(); } }, 1000); // typing line, times

$('#noteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const c = openConv && (openConv.startsWith('g:') ? convs.get(openConv) : conv(openConv));
  const text = $('#note').value.trim();
  const error = $('#noteError');
  if (!c || !text) return;
  error.textContent = '';
  try {
    await sendEnvelope({ k: 'msg', ...wireConv(c), t: text }, c);
    $('#note').value = '';
    lastTypingSent = 0;
    await loadChat();
    $('#textList').scrollTop = $('#textList').scrollHeight;
  } catch (err) {
    if (!(err instanceof PinError)) error.textContent = `Not sent: ${err.message}`;
  }
});
// Enter sends, Shift+Enter starts a new line
$('#note').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#noteForm').requestSubmit();
  }
});
// "Asha is typing…": at most every 3 s, sealed for the people in this conversation only
$('#note').addEventListener('input', () => {
  const c = openConv && (openConv.startsWith('g:') ? convs.get(openConv) : conv(openConv));
  if (!c || !$('#note').value.trim() || Date.now() - lastTypingSent < 3000) return;
  lastTypingSent = Date.now();
  sendEnvelope({ k: 'typing', ...wireConv(c) }, c, 8, false).catch(() => {});
});

$('#leaveGroup').addEventListener('click', async () => {
  const c = convs.get(openConv);
  if (!c || c.kind !== 'g') return;
  try {
    await sendEnvelope({ k: 'leave', g: c.id.slice(2) }, c); // tell the others, and our own copy closes it here
    await loadChat();
    openConv = null;
    showPane('list');
    renderChatAll();
    toast(`You left ${c.name}`);
  } catch (err) {
    if (!(err instanceof PinError)) toast(`Could not leave: ${err.message}`);
  }
});

$('#newGroupBtn').addEventListener('click', () => {
  const people = state.devices.filter((d) => d.kind !== 'PC').concat(state.local ? [] : [{ id: state.meId, name: state.me, key: state.meKey }]);
  $('#groupPeople').replaceChildren(el('legend', { textContent: 'Who is in it' }), ...people.map((d) => {
    const box = el('input', { type: 'checkbox', value: d.id, disabled: !d.key });
    return el('label', { className: 'pick' + (d.key ? '' : ' off') }, box, avatar(d), el('span', { textContent: d.name + (d.key ? '' : ' · no key') }));
  }));
  $('#groupName').value = '';
  $('#groupError').textContent = people.length ? '' : 'Nobody else is here yet.';
  showPane('group');
  $('#groupName').focus();
});
$('#groupBack').addEventListener('click', () => showPane(openConv ? 'thread' : 'list'));
$('#groupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#groupName').value.replace(/\s+/g, ' ').trim().slice(0, 40);
  const picked = [...document.querySelectorAll('#groupPeople input:checked')].map((i) => i.value);
  if (!name) { $('#groupError').textContent = 'Give the group a name.'; return; }
  if (!picked.length) { $('#groupError').textContent = 'Pick at least one person.'; return; }
  const g = E2E.b64(crypto.getRandomValues(new Uint8Array(9)));
  const draft = { id: 'g:' + g, kind: 'g', name, members: new Set([state.youId, ...picked]), msgs: [], lastAt: Date.now() };
  try {
    await sendEnvelope({ k: 'group', g, n: name, m: [...draft.members] }, draft); // name and members travel sealed
    await loadChat();
    openChat('g:' + g);
  } catch (err) {
    if (!(err instanceof PinError)) $('#groupError').textContent = `Could not make the group: ${err.message}`;
  }
});

// Starting a personal chat from Nearby (tap a person) or from Send to (the chat button next to it)
$('#deviceList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) { $('#sheet-nearby').close(); openChat('p:' + li.dataset.id); }
});
$('#sendToChat').addEventListener('click', () => { const to = $('#sendTo').value; if (to !== '*') openChat('p:' + to); });
$('#sendTo').addEventListener('change', () => { $('#sendToChat').hidden = $('#sendTo').value === '*'; });
$('#hostOpenChat')?.addEventListener('click', () => openChat(null));
setInterval(() => { if ($('#sheet-notes').open) loadChat(); }, 1500); // quicker while the chat is open

/* ---- the name screen: asked once, right after "Enter the city" ---- */
const DEFAULT_NAME = /^(iPhone|iPad|Android|Windows browser|Mac browser|Linux browser|Browser) \.\d+$/;
function deviceWord() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'phone' : /Mac OS/.test(ua) ? 'Mac' : 'laptop';
}
function needsName() {
  if (session.get('rooftop-name-skipped')) return false;
  if (state.local) return !state.meNamed;
  const saved = local.get('rooftop-name');
  return !saved || DEFAULT_NAME.test(saved);
}
/** The connected device already using this name (any case), if there is one. */
function takenBy(name) {
  const wanted = name.trim().toLowerCase();
  const others = state.devices.filter((d) => d.id !== state.youId).map((d) => d.name).concat(state.local ? [] : [state.me]);
  return others.find((n) => n.toLowerCase() === wanted);
}
function freeName(name) {
  for (let i = 2; ; i++) if (!takenBy(`${name} ${i}`)) return `${name} ${i}`;
}

let nameAsked = false;
function maybeAskName() {
  if (nameAsked || !state.session || !needsName() || document.body.classList.contains('intro-on') || $('#sheet-pin').open) return;
  nameAsked = true;
  const host = state.local;
  $('#nameGateKicker').textContent = host ? 'This PC' : 'Before you go up';
  $('#nameGateTitle').textContent = host ? 'What should others call this PC?' : 'What should others call you?';
  $('#nameGateInput').value = host ? state.me : '';
  $('#nameGateInput').placeholder = `e.g. Asha's ${host ? 'laptop' : deviceWord()}`;
  $('#nameGateHint').textContent = host
    ? 'Phones see this name in Send to and in the chat. You can change it later in the panel.'
    : `Shown next to your files and messages, like "Asha's ${deviceWord()}". You can change it later in Nearby.`;
  $('#nameGateError').replaceChildren();
  $('#nameGate').hidden = false;
  requestAnimationFrame(() => { $('#nameGateInput').focus(); if (host) $('#nameGateInput').select(); });
}
function closeNameGate() {
  $('#nameGate').classList.add('leaving');
  setTimeout(() => { $('#nameGate').hidden = true; $('#nameGate').classList.remove('leaving'); }, 300);
}

$('#nameGateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const wanted = $('#nameGateInput').value.replace(/\s+/g, ' ').trim();
  const error = $('#nameGateError');
  if (!wanted) { error.replaceChildren('Type a name, or Skip to keep ', el('b', { textContent: state.local ? state.me : state.you })); return; }
  const taken = takenBy(wanted);
  if (taken) {
    const other = freeName(wanted);
    const use = el('button', { type: 'button', className: 'namegate-use', textContent: `Use ${other}` });
    use.addEventListener('click', () => { $('#nameGateInput').value = other; error.replaceChildren(); $('#nameGateInput').focus(); });
    error.replaceChildren(`Someone here is already called ${taken}. `, use);
    return;
  }
  try {
    const name = await saveName(wanted);
    if (!state.local) local.set('rooftop-name', name);
    closeNameGate();
    toast(state.local ? `This PC is now called ${name}` : `Welcome, ${name}`);
    refresh();
  } catch (err) {
    if (!(err instanceof PinError)) error.textContent = 'Could not save that name. Try again.';
  }
});
$('#nameGateSkip').addEventListener('click', () => {
  session.set('rooftop-name-skipped', '1'); // asks again next visit, until a name is saved
  closeNameGate();
});

/* ---- names: each device picks the name others see ---- */
async function saveName(name) {
  const res = await call('/api/name', { method: 'POST', body: name });
  return (await res.json()).name;
}

$('#youName').addEventListener('click', () => { $('#myName').focus(); $('#myName').select(); });

$('#nameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const wanted = $('#myName').value.trim();
  const taken = takenBy(wanted);
  if (taken) { toast(`Someone here is already called ${taken}. Try ${freeName(wanted)}`, 5000); return; }
  try {
    if (!wanted) { local.set('rooftop-name', ''); toast('Name cleared. It shows again after Rooftop restarts'); return; }
    const name = await saveName(wanted);
    local.set('rooftop-name', name);
    $('#myName').value = name;
    toast(`Others now see you as ${name}`);
    refresh();
  } catch (err) {
    if (!(err instanceof PinError)) toast('Could not save that name');
  }
});

$('#hostNameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const name = await saveName($('#hostName').value);
    $('#hostName').value = name;
    $('#hostName').blur();
    toast(`This PC is now called ${name}`);
    refresh();
  } catch {
    toast('Could not save that name');
  }
});

// The PC forgets a phone's name when it restarts or starts a new session; the phone tells it again.
let nameSent = '';
function syncName() {
  const wanted = local.get('rooftop-name');
  if (state.local || !wanted || state.you === wanted || nameSent === wanted + state.you) return;
  nameSent = wanted + state.you;
  saveName(wanted).catch(() => { nameSent = ''; });
}

/* ---- history: every file that went through this PC in this session ---- */
let historyAt = -1;
function showTab(name) {
  const files = name === 'files';
  $('#tabFiles').setAttribute('aria-selected', String(files));
  $('#tabHistory').setAttribute('aria-selected', String(!files));
  $('#panelFiles').hidden = !files;
  $('#panelHistory').hidden = files;
  if (!files) loadHistory();
}
$('#tabFiles').addEventListener('click', () => showTab('files'));
$('#tabHistory').addEventListener('click', () => showTab('history'));
$('#sheet-inbox').addEventListener('keydown', (e) => {
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.target.getAttribute('role') === 'tab') {
    const other = e.target.id === 'tabFiles' ? $('#tabHistory') : $('#tabFiles');
    other.focus();
    other.click();
  }
});

async function loadHistory() {
  historyAt = state.historyAt;
  let entries;
  try {
    entries = await (await call('/api/history')).json();
  } catch {
    return;
  }
  $('#historyList').replaceChildren(...entries.map((h) => {
    const way = h.mine ? 'sent' : h.to === state.you || h.to === 'everyone' ? 'got' : 'passed';
    const arrow = el('span', { className: 'way way-' + way, textContent: way === 'sent' ? '↑' : way === 'got' ? '↓' : '⇄' });
    arrow.setAttribute('aria-label', way === 'sent' ? 'Sent' : way === 'got' ? 'Received' : 'Between other devices');
    const speed = h.ms > 0 ? ` · ${rate(h.size / (h.ms / 1000))}` : '';
    const packed = h.ratio < 0.95 ? ` · compressed to ${Math.max(1, Math.round(h.ratio * 100))}%` : '';
    const meta = `${h.mine ? 'You' : h.from} → ${h.to === 'everyone' ? 'Everyone' : h.to === state.you ? 'You' : h.to} · ${humanSize(h.size)}${speed}${packed} · ${timeAgo(h.at)}`;
    arrow.append(avatar({ id: h.fromId, name: h.from }, 'mini'));
    return el('li', { className: h.ok ? '' : 'failed' }, arrow,
      el('div', {}, el('div', { className: 'name', title: h.name, textContent: h.name }),
        el('div', { className: 'meta', textContent: h.ok ? meta : `Failed: ${h.note} · ${timeAgo(h.at)}` })));
  }));
  $('#historyEmpty').hidden = entries.length > 0;
}

/* ---- notifications: a system notification while Rooftop is in the background, a count in the tab title ---- */
const baseTitle = document.title;
let unseen = 0;
const canNotify = 'Notification' in window && window.isSecureContext;
const notifyOn = () => canNotify && Notification.permission === 'granted' && local.get('rooftop-notify') === 'on';

function notify(title, body, kind = 'message') {
  if (local.get('rooftop-notify') === 'on') chime(kind);
  if (navigator.vibrate && !document.hidden) navigator.vibrate(60);
  if (!document.hidden) return;
  unseen++;
  document.title = `(${unseen}) ${baseTitle}`;
  if (notifyOn()) {
    try { new Notification(title, { body: body.slice(0, 140), tag: 'rooftop-' + Date.now(), silent: true }); } catch { /* Android Chrome wants a service worker; the title count still shows */ }
  }
}

/* ---- the sound: a soft chime, two pure notes going up; messages a little higher than files ---- */
let audio = null;
function wakeAudio() { // browsers only allow sound after a click on the page, so get ready on the first one
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { audio = null; }
}
document.addEventListener('pointerdown', wakeAudio, { once: true, capture: true });
function chime(kind) {
  wakeAudio();
  if (!audio) return;
  const [first, second] = kind === 'file' ? [523.25, 783.99] : [659.25, 880]; // C5 to G5, or E5 to A5
  const start = audio.currentTime + 0.02;
  const out = audio.createGain();
  out.gain.value = 0.3;
  out.connect(audio.destination);
  for (const [freq, at, len] of [[first, 0, 0.9], [second, 0.14, 1.0]]) {
    const osc = audio.createOscillator(), env = audio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t = start + at;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + len);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + len + 0.05);
  }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) { unseen = 0; document.title = baseTitle; } });

function renderNotify() {
  const on = notifyOn();
  for (const b of document.querySelectorAll('[data-notify]')) {
    b.hidden = !canNotify;
    b.setAttribute('aria-pressed', String(on));
    const label = b.querySelector('span');
    if (label) label.textContent = on ? 'Notifications on' : 'Notify me when something arrives';
    b.title = on ? 'Notifications are on. Click to turn them off' : 'Click to turn notifications on';
    if (!label) b.setAttribute('aria-label', on ? 'Turn notifications off' : 'Turn notifications on');
  }
  const note = !canNotify ? 'This browser cannot show notifications here, so new things are counted in the tab title instead.'
    : Notification.permission === 'denied' ? 'Notifications are blocked for this page in the browser settings.'
    : on ? 'You get a notification when a file or message arrives while Rooftop is in the background.' : '';
  for (const p of document.querySelectorAll('[data-notify-note]')) { p.textContent = note; p.hidden = !note; }
  for (const b of document.querySelectorAll('[data-notify-state]')) {
    b.textContent = !canNotify ? 'Not available' : on ? 'On' : 'Off';
    b.classList.toggle('on', on);
  }
  document.querySelector('.notify-art')?.classList.toggle('on', on);
  document.querySelector('.notify-card')?.toggleAttribute('hidden', !canNotify); // e.g. inside the Android app: no card at all
}
document.querySelectorAll('[data-notify]').forEach((b) => b.addEventListener('click', async () => {
  if (notifyOn()) {
    local.set('rooftop-notify', 'off');
    toast('Notifications off');
    renderNotify();
    return;
  }
  let answer = Notification.permission;
  if (answer !== 'granted') {
    try {
      answer = await Notification.requestPermission();
    } catch {
      answer = await new Promise((r) => Notification.requestPermission(r)); // older Safari takes a callback
    }
  }
  local.set('rooftop-notify', answer === 'granted' ? 'on' : 'off');
  if (answer === 'granted') {
    // show one right away, so it is clear they work (the real ones come while Rooftop is in the background)
    chime('message'); // the sound you will hear
    try { new Notification('Rooftop notifications are on', { body: 'You will get one like this when a file or message arrives while Rooftop is in the background.', silent: true }); } catch { /* the toast still says it */ }
    toast('Notifications on. You will get one when something arrives while Rooftop is in the background.', 6000);
  } else if (answer === 'denied') {
    toast('The browser blocked notifications. Click the icon left of the address bar, set Notifications to Allow, then try again.', 9000);
  } else {
    toast('The browser did not ask. Click the icon left of the address bar, set Notifications to Allow, then try again.', 9000);
  }
  renderNotify();
}));

/* ---- PIN ---- */
function askPin(message) {
  clearTimeout(pollTimer);
  $('#pinError').textContent = message || '';
  document.querySelectorAll('dialog[open]').forEach((d) => d.id !== 'sheet-pin' && d.close());
  const d = $('#sheet-pin');
  if (!d.open) d.showModal();
  $('#pinInput').focus();
}

$('#pinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $('#pinInput').value.trim();
  if (!/^\d{6}$/.test(value)) { $('#pinError').textContent = 'The PIN is 6 digits.'; return; }
  pin = value;
  session.set('rooftop-pin', pin);
  $('#sheet-pin').close();
  refresh();
});

/* ---- day / night ---- */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#themeBtn').setAttribute('aria-pressed', String(theme === 'dark'));
  document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#22201d' : '#d4cbbe';
  city.setNight(theme === 'dark');
}
$('#themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  local.set('rooftop-theme', next);
  applyTheme(next);
});
applyTheme(local.get('rooftop-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

/* ---- start ---- */
setTimeout(() => $('#loader')?.classList.add('done'), reduceMotion ? 0 : 1300);

// The opening, on every load: full-screen aerial view, then a frame, then a pill window between big words.
function runIntro() {
  if (reduceMotion) return;
  const intro = $('#intro');
  document.body.classList.add('intro-on');
  intro.hidden = false;
  setTimeout(() => city.tour(), 250); // after the full-screen resize has settled
  setTimeout(() => intro.classList.add('s1'), 120);
  const t2 = setTimeout(() => { intro.classList.add('s2'); document.body.classList.add('intro-s2'); }, 2400);
  const t3 = setTimeout(() => { intro.classList.add('s3'); document.body.classList.add('intro-s3'); }, 4000);
  slideToEnter(() => {
    clearTimeout(t2); clearTimeout(t3);
    intro.classList.add('leaving');
    $('#loader').classList.remove('done');
    setTimeout(() => {
      document.body.classList.remove('intro-on', 'intro-s2', 'intro-s3');
      intro.hidden = true;
    }, 500);
    setTimeout(() => {
      $('#loader').classList.add('done');
      city.arrive();
      maybeAskName();
    }, 1400);
  });
}

/* Slide to enter: drag the knob to the end of the pill. Let go early and it springs back; a plain tap gives a nudge
   to show it slides. Keyboard (Enter or Space on the knob) still enters, for people who cannot drag. */
function slideToEnter(enter) {
  const track = $('#introSlider'), knob = $('#introEnter'), fill = $('#slideFill');
  let startX = 0, x = 0, max = 0, dragging = false, done = false;
  const place = (to) => {
    x = to;
    knob.style.transform = `translateX(${to}px)`;
    fill.style.width = `${to + knob.offsetWidth + 4}px`;
    track.style.setProperty('--p', max ? to / max : 0);
  };
  const finish = () => { if (done) return; done = true; track.classList.add('done'); place(max || track.clientWidth - knob.offsetWidth - 8); enter(); };
  knob.addEventListener('pointerdown', (e) => {
    if (done) return;
    dragging = true;
    max = track.clientWidth - knob.offsetWidth - 8;
    startX = e.clientX - x;
    knob.setPointerCapture(e.pointerId);
    track.classList.add('dragging');
  });
  knob.addEventListener('pointermove', (e) => { if (dragging) place(Math.max(0, Math.min(max, e.clientX - startX))); });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    track.classList.remove('dragging');
    if (x >= max * 0.85) finish();
    else if (x < 4) { track.classList.remove('nudge'); void track.offsetWidth; track.classList.add('nudge'); place(0); }
    else place(0); // springs back (CSS transition)
  };
  knob.addEventListener('pointerup', release);
  knob.addEventListener('pointercancel', release);
  knob.addEventListener('click', (e) => { if (e.detail === 0) finish(); }); // keyboard activation has no pointer
}
runIntro();

// Instead of waiting for the next poll, keep one request open that the PC answers the moment something changes
// (a file finished arriving, a message, a new key). The poll stays as a fallback.
async function watchChanges() {
  let seen = -1;
  for (;;) {
    if (!pin && !isLocal) { await sleep(3000); continue; }
    try {
      const res = await fetch(withPin('/api/wait?v=' + seen), { cache: 'no-store' });
      if (!res.ok) { await sleep(3000); continue; }
      const { v } = await res.json();
      if (seen >= 0 && v !== seen) refresh();
      seen = v;
    } catch {
      await sleep(3000);
    }
  }
}
watchChanges();
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
if (!pin && !isLocal) askPin('');
else refresh();
if (isLocal) {
  document.body.classList.add('is-host');
  $('#host').hidden = false;
  $('#hostMore').hidden = false;
  loadConnect();
  setInterval(loadConnect, 5000); // new Wi-Fi or hotspot means a new address, so a new QR code
}

/* ---------- video call: direct peer-to-peer WebRTC over offline Wi-Fi/Hotspot ---------- */
let callState = 'idle'; // 'idle' | 'calling' | 'incoming' | 'connected'
let callPeerId = null;
let callPeerName = '';
let callLocalStream = null;
let callPc = null;
let callLatestSeq = 0;
let callPollBusy = false;
let callTimer = null;
let callStartTime = 0;
let callMicEnabled = true;
let callCamEnabled = true;
let callFacingMode = 'user';
let ringInterval = null;
let audioCtx = null;
let pendingIceCandidates = [];
let activePollLoop = null;

// Offline sound synthesizer using standard Web Audio API
function playTone(freq1, freq2, duration, type = 'sine') {
  try {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;
    const ctx = audioCtx || (audioCtx = new AudioCtor());
    if (ctx.state === 'suspended') ctx.resume();
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    osc1.type = type;
    osc2.type = type;
    osc1.frequency.value = freq1;
    osc2.frequency.value = freq2;
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);
    osc1.start();
    osc2.start();
    osc1.stop(ctx.currentTime + duration);
    osc2.stop(ctx.currentTime + duration);
  } catch (e) {
    // audio policy may restrict before interaction
  }
}

function startRinging(type) {
  stopRinging();
  if (type === 'incoming') {
    playTone(440, 480, 1.2);
    ringInterval = setInterval(() => playTone(440, 480, 1.2), 2800);
  } else if (type === 'outgoing') {
    playTone(400, 450, 0.8);
    ringInterval = setInterval(() => playTone(400, 450, 0.8), 2400);
  }
}

function stopRinging() {
  if (ringInterval) {
    clearInterval(ringInterval);
    ringInterval = null;
  }
}

function setActiveCallPolling(active) {
  if (active && !activePollLoop) {
    activePollLoop = setInterval(pollCallSignals, 300);
  } else if (!active && activePollLoop) {
    clearInterval(activePollLoop);
    activePollLoop = null;
  }
}

async function sendCallSignal(to, type, dataObj = {}) {
  try {
    const dataStr = JSON.stringify(dataObj);
    await call(`/api/call/signal?to=${encodeURIComponent(to)}&type=${encodeURIComponent(type)}`, {
      method: 'POST',
      body: dataStr,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.warn('Call signal failed:', err);
  }
}

async function pollCallSignals() {
  if (callPollBusy || (!pin && !isLocal)) return;
  callPollBusy = true;
  try {
    const resp = await call(`/api/call/poll?after=${callLatestSeq}`, { method: 'GET' });
    const res = await resp.json();
    if (!res || !res.signals) return;
    for (const sig of res.signals) {
      if (sig.seq) callLatestSeq = Math.max(callLatestSeq, sig.seq);
      try {
        await handleIncomingSignal(sig);
      } catch (e) {
        console.warn('Error handling call signal:', e);
      }
    }
    callLatestSeq = Math.max(callLatestSeq, res.latest || 0);
  } catch (err) {
    // network retry
  } finally {
    callPollBusy = false;
  }
}

async function handleIncomingSignal(sig) {
  let payload = {};
  try { payload = JSON.parse(sig.data || '{}'); } catch {}
  const from = sig.from;
  const type = sig.type;

  if (type === 'invite') {
    if (callState !== 'idle') {
      sendCallSignal(from, 'busy', { reason: 'busy' });
      return;
    }
    callState = 'incoming';
    callPeerId = from;
    callPeerName = payload.fromName || (person(from)?.name) || 'Nearby device';
    setActiveCallPolling(true);
    showIncomingCallCard(callPeerName, from);
    startRinging('incoming');
    notify('Incoming video call', `${callPeerName} is calling you`, 'call');
    return;
  }

  if (type === 'busy') {
    if (callState === 'calling' && callPeerId === from) {
      toast(`${callPeerName} is busy`);
      endCall(false);
    }
    return;
  }

  if (type === 'hangup') {
    if (callPeerId === from) {
      toast(payload.reason === 'declined' ? `${callPeerName} declined call` : 'Call ended');
      endCall(false);
    }
    return;
  }

  if (type === 'accepted') {
    if (callState === 'calling' && callPeerId === from) {
      stopRinging();
      $('#callStatus').textContent = 'Connecting...';
      await createOfferAndSend();
    }
    return;
  }

  if (type === 'offer') {
    if (callPeerId === from) {
      try {
        if (!callPc) initPeerConnection();
        await callPc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: payload.sdp }));
        flushPendingIceCandidates();
        const answer = await callPc.createAnswer();
        await callPc.setLocalDescription(answer);
        await sendCallSignal(from, 'answer', { sdp: answer.sdp });
        $('#callStatus').textContent = 'Connecting...';
      } catch (e) {
        console.error('Failed to handle offer:', e);
        endCall();
      }
    }
    return;
  }

  if (type === 'answer') {
    if (callPeerId === from && callPc) {
      try {
        await callPc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: payload.sdp }));
        flushPendingIceCandidates();
      } catch (e) {
        console.error('Failed to handle answer:', e);
      }
    }
    return;
  }

  if (type === 'candidate') {
    if (callPeerId === from && payload.candidate) {
      if (callPc && callPc.remoteDescription && callPc.remoteDescription.type) {
        try {
          await callPc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch (e) {}
      } else {
        pendingIceCandidates.push(payload.candidate);
      }
    }
    return;
  }
}

function flushPendingIceCandidates() {
  if (!callPc || !pendingIceCandidates.length) return;
  for (const cand of pendingIceCandidates) {
    try {
      callPc.addIceCandidate(new RTCIceCandidate(cand));
    } catch (e) {}
  }
  pendingIceCandidates = [];
}

async function getMediaStream() {
  const constraints = {
    video: { facingMode: callFacingMode },
    audio: true,
  };
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    // fallback without specific facingMode if browser/platform is strict
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  }
}

async function startVideoCall(peerId, peerName) {
  if (callState !== 'idle') {
    toast('Already in a call');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Camera & microphone not supported in this browser context');
    return;
  }
  callPeerId = peerId;
  callPeerName = peerName || person(peerId)?.name || 'Device';
  callState = 'calling';

  try {
    callLocalStream = await getMediaStream();
  } catch (err) {
    callState = 'idle';
    callPeerId = null;
    toast(`Camera/mic permission needed: ${err.message || 'Permission denied'}`);
    return;
  }

  setupCallUI(callPeerName, peerId);
  $('#callStatus').textContent = `Calling ${callPeerName}...`;
  startRinging('outgoing');
  setActiveCallPolling(true);

  await sendCallSignal(callPeerId, 'invite', { fromName: state.you || state.me || 'Device' });
}

async function acceptIncomingCall() {
  stopRinging();
  hideIncomingCallCard();
  if (callState !== 'incoming' || !callPeerId) return;

  try {
    callLocalStream = await getMediaStream();
  } catch (err) {
    toast(`Camera/mic permission needed: ${err.message || 'Permission denied'}`);
    sendCallSignal(callPeerId, 'hangup', { reason: 'permission_denied' });
    endCall(false);
    return;
  }

  callState = 'connected';
  setupCallUI(callPeerName, callPeerId);
  $('#callStatus').textContent = 'Connecting...';

  initPeerConnection();
  await sendCallSignal(callPeerId, 'accepted');
}

function initPeerConnection() {
  if (callPc) {
    try { callPc.close(); } catch {}
  }
  pendingIceCandidates = [];

  // Offline WebRTC: empty iceServers list (direct LAN host candidates only)
  const RTCPeerCtor = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  callPc = new RTCPeerCtor({ iceServers: [] });

  if (callLocalStream) {
    for (const track of callLocalStream.getTracks()) {
      callPc.addTrack(track, callLocalStream);
    }
  }

  callPc.onicecandidate = (event) => {
    if (event.candidate && callPeerId) {
      sendCallSignal(callPeerId, 'candidate', { candidate: event.candidate });
    }
  };

  callPc.ontrack = (event) => {
    const remoteVid = $('#remoteVideo');
    if (event.streams && event.streams[0]) {
      remoteVid.srcObject = event.streams[0];
    } else {
      let inbound = remoteVid.srcObject;
      if (!inbound) {
        inbound = new MediaStream();
        remoteVid.srcObject = inbound;
      }
      inbound.addTrack(event.track);
    }
    $('#remotePlaceholder').hidden = true;
    remoteVid.classList.remove('hidden-video');
    remoteVid.play().catch(() => {});
  };

  const updateConnState = () => {
    const cs = callPc.connectionState;
    const ics = callPc.iceConnectionState;
    if (cs === 'connected' || ics === 'connected' || ics === 'completed') {
      $('#callDot').classList.add('connected');
      $('#callStatus').textContent = 'Connected (Direct Wi-Fi)';
      startCallDurationTimer();
    } else if (cs === 'failed' || ics === 'failed') {
      if (callState !== 'idle') {
        toast('Connection failed');
        endCall(true);
      }
    } else if (cs === 'closed' || ics === 'closed') {
      if (callState !== 'idle') endCall(false);
    }
  };
  callPc.onconnectionstatechange = updateConnState;
  callPc.oniceconnectionstatechange = updateConnState;
}

async function createOfferAndSend() {
  initPeerConnection();
  try {
    const offer = await callPc.createOffer();
    await callPc.setLocalDescription(offer);
    await sendCallSignal(callPeerId, 'offer', { sdp: offer.sdp });
  } catch (e) {
    console.error('Failed to create offer:', e);
    endCall();
  }
}

function endCall(notifyPeer = true) {
  stopRinging();
  hideIncomingCallCard();
  stopCallDurationTimer();
  setActiveCallPolling(false);

  if (notifyPeer && callPeerId) {
    sendCallSignal(callPeerId, 'hangup', { reason: 'ended' });
  }

  if (callPc) {
    try { callPc.close(); } catch {}
    callPc = null;
  }

  if (callLocalStream) {
    callLocalStream.getTracks().forEach((t) => {
      try { t.stop(); } catch {}
    });
    callLocalStream = null;
  }

  const localVid = $('#localVideo');
  if (localVid) localVid.srcObject = null;
  const remoteVid = $('#remoteVideo');
  if (remoteVid) {
    remoteVid.srcObject = null;
    remoteVid.classList.add('hidden-video');
  }

  $('#callOverlay').hidden = true;
  $('#remotePlaceholder').hidden = false;
  $('#callDot').classList.remove('connected');
  $('#callDuration').textContent = '00:00';

  callState = 'idle';
  callPeerId = null;
  callPeerName = '';
  callMicEnabled = true;
  callCamEnabled = true;
  pendingIceCandidates = [];
  updateMediaControlButtons();
}

function setupCallUI(peerName, peerId) {
  document.querySelectorAll('dialog[open]').forEach((d) => {
    try { d.close(); } catch {}
  });
  $('#callOverlay').hidden = false;
  $('#callTopName').textContent = peerName;
  $('#callPeerName').textContent = peerName;
  $('#callAvatar').replaceChildren(avatar({ id: peerId, name: peerName }));
  $('#localVideo').srcObject = callLocalStream;
  $('#remotePlaceholder').hidden = false;
  $('#remoteVideo').classList.add('hidden-video');
  $('#callDot').classList.remove('connected');
  $('#callDuration').textContent = '00:00';
  updateMediaControlButtons();

  // Check if multiple camera devices exist or device is mobile/touch
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      const videoInputs = devices.filter((d) => d.kind === 'videoinput');
      if (videoInputs.length > 1 || ('ontouchstart' in window)) {
        $('#callFlipCam').hidden = false;
      }
    }).catch(() => {});
  }
}

function showIncomingCallCard(callerName, callerId) {
  document.querySelectorAll('dialog[open]').forEach((d) => {
    try { d.close(); } catch {}
  });
  $('#incomingName').textContent = callerName;
  $('#incomingAvatar').replaceChildren(avatar({ id: callerId, name: callerName }));
  $('#incomingCallCard').hidden = false;
}

function hideIncomingCallCard() {
  $('#incomingCallCard').hidden = true;
}

function startCallDurationTimer() {
  stopCallDurationTimer();
  callStartTime = Date.now();
  callTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    $('#callDuration').textContent = `${mins}:${secs}`;
  }, 1000);
}

function stopCallDurationTimer() {
  if (callTimer) {
    clearInterval(callTimer);
    callTimer = null;
  }
}

function toggleCallMic() {
  if (!callLocalStream) return;
  callMicEnabled = !callMicEnabled;
  callLocalStream.getAudioTracks().forEach((t) => (t.enabled = callMicEnabled));
  updateMediaControlButtons();
}

function toggleCallCam() {
  if (!callLocalStream) return;
  callCamEnabled = !callCamEnabled;
  callLocalStream.getVideoTracks().forEach((t) => (t.enabled = callCamEnabled));
  $('#localVideo').hidden = !callCamEnabled;
  updateMediaControlButtons();
}

async function flipCallCamera() {
  if (!callLocalStream) return;
  callFacingMode = callFacingMode === 'user' ? 'environment' : 'user';
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: callFacingMode },
      audio: true,
    });
    const newVideoTrack = newStream.getVideoTracks()[0];
    const oldVideoTrack = callLocalStream.getVideoTracks()[0];
    if (callPc) {
      const sender = callPc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) sender.replaceTrack(newVideoTrack);
    }
    if (oldVideoTrack) oldVideoTrack.stop();
    callLocalStream.removeTrack(oldVideoTrack);
    callLocalStream.addTrack(newVideoTrack);
    $('#localVideo').srcObject = callLocalStream;
  } catch (err) {
    toast('Could not switch camera');
  }
}

function updateMediaControlButtons() {
  const micBtn = $('#callToggleMic');
  const camBtn = $('#callToggleCam');
  if (micBtn) {
    micBtn.classList.toggle('off', !callMicEnabled);
    $('#callMicIcon use')?.setAttribute('href', callMicEnabled ? '#i-mic' : '#i-mic-off');
  }
  if (camBtn) {
    camBtn.classList.toggle('off', !callCamEnabled);
    $('#callCamIcon use')?.setAttribute('href', callCamEnabled ? '#i-video' : '#i-video-off');
  }
}

// Wire call control buttons
$('#incomingAccept')?.addEventListener('click', acceptIncomingCall);
$('#incomingDecline')?.addEventListener('click', () => {
  stopRinging();
  hideIncomingCallCard();
  if (callPeerId) sendCallSignal(callPeerId, 'hangup', { reason: 'declined' });
  endCall(false);
});
$('#callHangup')?.addEventListener('click', () => endCall(true));
$('#callToggleMic')?.addEventListener('click', toggleCallMic);
$('#callToggleCam')?.addEventListener('click', toggleCallCam);
$('#callFlipCam')?.addEventListener('click', flipCallCamera);

// In personal 1-on-1 chat: Header Video Call button
$('#threadCallBtn')?.addEventListener('click', () => {
  if (openConv && !openConv.startsWith('g:')) {
    const c = conv(openConv);
    if (c && c.kind === 'p') {
      const p = person(c.peer);
      startVideoCall(c.peer, p?.name || 'Device');
    }
  }
});

// Main navbar Video Call button
$('#mainCallBtn')?.addEventListener('click', () => {
  renderCallSheet();
  const d = $('#sheet-call');
  if (d) { renderSheets(); d.showModal(); }
});

// Clean teardown on page exit
window.addEventListener('beforeunload', () => {
  if (callState !== 'idle' && callPeerId) {
    navigator.sendBeacon?.(withPin(`/api/call/signal?to=${encodeURIComponent(callPeerId)}&type=hangup`), JSON.stringify({ reason: 'closed' }));
  }
});

// Periodic fallback polling for call signals (instant notification loop triggers on active calls)
setInterval(pollCallSignals, 2000);


