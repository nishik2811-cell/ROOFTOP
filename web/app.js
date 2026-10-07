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

const withPin = (path) => (isLocal ? path : path + (path.includes('?') ? '&' : '?') + 'pin=' + encodeURIComponent(pin));
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
  const CANAL_J = 1;                              // the street after block row 1 is a canal
  const CANAL = [bz(CANAL_J) + BD, bz(CANAL_J + 1)];
  const PLAZA = { x0: bx(2), x1: bx(3) + BW, z0: bz(3), z1: bz(4) + BD };
  // Towards the horizon the city ends at a beach and the sea runs out to the sky. On this projection
  // screen height depends only on x + z, so the shoreline is a straight horizontal line on screen.
  const SHORE = 8, LAND = SHORE + 2.5;            // x + z where the water stops, and where the sand stops
  const onLand = (x, z, margin = 0) => x + z >= LAND + margin;
  const shoreY = SHORE * 0.5 * U, landY = LAND * 0.5 * U;
  const AVENUES = [];
  for (let i = -3; i <= 7; i++) AVENUES.push([bx(i) + BW, bx(i + 1)]);
  const ROADS_Z = [];
  for (let j = -3; j <= 8; j++) if (j !== CANAL_J) ROADS_Z.push(bz(j) + BD + ST / 2);
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
    if (z > CANAL[0] - 1 && z < CANAL[1] + 1) continue;
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

  /* ---- moving life: cars on the avenues, boats on the canal, people in the plaza ---- */
  const life = rng(99);
  const CAR_COLORS = ['#e2483d', '#f2b632', '#2f86d6', '#f6ece0', '#3a2a26', '#2f9e66'];
  const cars = [];
  for (const z of CAR_ROADS_Z) for (let k = 0; k < 2; k++) cars.push({ axis: 'x', lane: z + (k % 2 ? 0.6 : -0.6), dir: k % 2 ? -1 : 1, t: -40 + life() * 136, speed: 0.0016 + life() * 0.0012, color: CAR_COLORS[Math.floor(life() * 6)] });
  for (const [a, b] of AVENUES.filter((_, n) => n % 2 === 0)) for (let k = 0; k < 2; k++) cars.push({ axis: 'z', lane: (a + b) / 2 + (k % 2 ? 0.6 : -0.6), dir: k % 2 ? -1 : 1, t: -34 + life() * 100, speed: 0.0016 + life() * 0.0012, color: CAR_COLORS[Math.floor(life() * 6)] });
  const boats = [0, 1, 2].map((k) => ({ t: -40 + life() * 136, speed: 0.0009 + life() * 0.0006, dir: k % 2 ? -1 : 1, lane: CANAL[0] + 0.5 + k * 0.5, color: CAR_COLORS[k * 2] }));
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
    // canal with stone edges and two bridges; it runs across the sand into the sea
    c.save();
    c.beginPath(); c.rect(x0, shoreY - 3, w, view.y1 - shoreY + 200); c.clip();
    poly(c, [iso(-20, 0, CANAL[0]), iso(66, 0, CANAL[0]), iso(66, 0, CANAL[1]), iso(-20, 0, CANAL[1])], p.water);
    c.strokeStyle = p.ripple;
    c.lineWidth = 1;
    for (let i = 0; i < 70; i++) {
      const [sx, sy] = iso(-4 + r() * 54, 0, CANAL[0] + 0.3 + r() * 2.4);
      c.beginPath(); c.moveTo(sx, sy); c.lineTo(sx + 10, sy - 5); c.stroke();
    }
    for (const z of CANAL) inked(c, [iso(-20, 0, z), iso(66, 0, z), iso(66, 0.25, z), iso(-20, 0.25, z)], r, p.ink, 0.8);
    for (const [a, b] of AVENUES) {
      poly(c, [iso(a, 0.3, CANAL[0] - 0.3), iso(b, 0.3, CANAL[0] - 0.3), iso(b, 0.3, CANAL[1] + 0.3), iso(a, 0.3, CANAL[1] + 0.3)], p.road);
      inked(c, [iso(a, 0.3, CANAL[0] - 0.3), iso(a, 0.3, CANAL[1] + 0.3), iso(a, 0.6, CANAL[1] + 0.3), iso(a, 0.6, CANAL[0] - 0.3)], r, p.ink, 0.8);
      inked(c, [iso(b, 0.3, CANAL[0] - 0.3), iso(b, 0.3, CANAL[1] + 0.3), iso(b, 0.6, CANAL[1] + 0.3), iso(b, 0.6, CANAL[0] - 0.3)], r, p.ink, 0.8);
    }
    c.restore();
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
      drawCar(x, car.axis === 'z' && z > CANAL[0] - 0.4 && z < CANAL[1] + 0.4 ? 0.3 : 0, z, car, p);
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
    for (const boat of boats) {
      boat.t += boat.dir * boat.speed * dt;
      if (boat.t > 96) boat.t = -40; else if (boat.t < -40) boat.t = 96;
      const pt = iso(boat.t, 0, boat.lane);
      if (hidden(pt, boat.t + boat.lane * 2)) continue;
      ctx.fillStyle = boat.color;
      ctx.beginPath(); ctx.ellipse(pt[0], pt[1], 11, 4.5, -0.47, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fbf3e6';
      ctx.fillRect(pt[0] - 3, pt[1] - 8, 6, 5);
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
  const fresh = knownFiles ? files.find((f) => !knownFiles.has(f.name) && f.from !== state.you) : null;
  knownFiles = new Set(files.map((f) => f.name));
  return fresh;
}

/** Pops the "incoming transmission" card for a message from another device. */
function announceText(texts) {
  const newest = texts[0];
  if (lastTextAt !== null && newest && newest.at > lastTextAt && newest.from !== state.you) transmission(null, newest);
  lastTextAt = newest ? newest.at : 0;
}

let txTimer = 0;
function transmission(file, message) {
  const box = $('#transmission');
  const open = $('#txOpen');
  const copy = $('#txCopy');
  if (file) {
    $('#txBody').textContent = `${file.name} from ${file.from}`;
    open.href = saveUrl(file.name);
    open.download = file.name;
  } else {
    $('#txBody').textContent = `"${message.text}" from ${message.from}`;
    copy.onclick = () => copyText(message.text);
  }
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
  const who = (n) => (n === state.you ? 'You' : n);
  return `${who(f.from)} → ${f.to ? who(f.to) : 'Everyone'}`;
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
function renderRecipients() {
  const select = $('#sendTo');
  const keep = select.value;
  const options = [['*', 'Everyone']];
  if (!state.local && state.meId) options.push([state.meId, state.me + ' (PC)']);
  for (const d of state.devices) if (d.kind !== 'PC' && d.id) options.push([d.id, d.name]);
  select.replaceChildren(...options.map(([value, text]) => el('option', { value, textContent: text })));
  select.value = options.some(([v]) => v === keep) ? keep : '*';
}

/* ---- uploads ---- */
const picker = $('#picker');
picker.addEventListener('change', () => {
  const chosen = [...picker.files];
  picker.value = '';
  upload(chosen);
});

let uploading = false;
async function upload(list) {
  if (!list.length) return;
  if (uploading) { toast('Still sending, one batch at a time'); return; }
  const target = $('#sendTo').value;
  if (target !== '*' && target !== state.meId && !sealedTarget()) {
    toast('That device cannot receive private files yet. Ask them to reload Rooftop, or send to Everyone.', 6000);
    return;
  }
  uploading = true;
  const label = $('#sendLabel');
  const fill = $('#sendFill');
  let sent = 0;
  try {
    for (let i = 0; i < list.length; i++) {
      city.startFlight(list[i].name);
      const send = sealedTarget() ? sendSealed : sendOne;
      await send(list[i], (p) => {
        label.textContent = list.length > 1 ? `${i + 1} of ${list.length}  ${Math.round(p * 100)}%` : `Sending ${Math.round(p * 100)}%`;
        fill.style.transform = `scaleX(${p})`;
        city.flightProgress(p);
      });
      sent++;
    }
    const sealedTo = sealedTarget();
    if (sealedTo) {
      const code = await safetyCodeFor(sealedTo.key);
      toast(`Sent privately to ${sealedTo.name}. Safety code ${code}: it should show the same on their screen.`, 10000);
    } else toast(sent > 1 ? `${sent} files sent to ${state.me}` : `Sent to ${state.me}`);
  } catch (e) {
    if (!(e instanceof PinError)) toast(`Upload failed: ${e.message}`, 5000);
  } finally {
    uploading = false;
    label.textContent = 'Send files';
    fill.style.transform = 'scaleX(0)';
    city.endFlight();
    knownFiles = null; // our own files are not "incoming"
    await refresh();
    if (sent) {
      const name = list[sent - 1].name;
      const index = city.murals().findIndex((m) => m.file.name === name || m.file.from === state.you);
      if (index >= 0) { select(index, true, false); city.celebrate(index); }
    }
  }
}

// Files go up in 4 MB pieces. If the Wi-Fi drops, each piece is retried; the PC keeps what already arrived,
// so retrying (or sending the same file again later) carries on from there instead of starting over.
const PIECE = 4 * 1024 * 1024;
const RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendOne(file, onProgress) {
  const key = `${file.name}|${file.size}|${file.lastModified}`;
  let offset = 0, failures = 0;
  for (;;) {
    const end = Math.min(file.size, offset + PIECE);
    let res;
    try {
      res = await sendPiece(file, key, offset, end, (loaded) => onProgress(file.size ? (offset + loaded) / file.size : 1));
    } catch (e) {
      if (e instanceof PinError || e.fatal) throw e;
      if (++failures > RETRIES) throw new Error('connection lost. Send the same file again to continue where it stopped');
      toast(`Connection hiccup, retrying (${failures} of ${RETRIES})`);
      await sleep(1000 * failures);
      continue; // same offset; if the PC got more than we think, it answers 409 with the right place
    }
    failures = 0;
    if (res.done) return res;
    if (res.status === 409 && res.offset > offset) toast('Resuming where it stopped');
    offset = res.offset;
  }
}

function sendPiece(file, key, offset, end, onLoaded) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    const q = `?name=${encodeURIComponent(file.name)}&size=${file.size}&key=${encodeURIComponent(key)}&offset=${offset}&to=${encodeURIComponent($('#sendTo').value)}`;
    x.open('POST', withPin('/api/upload' + q));
    x.upload.onprogress = (e) => onLoaded(e.loaded);
    x.onload = () => {
      let body = {};
      try { body = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status === 200) resolve(body);
      else if (x.status === 409) resolve({ offset: body.offset, status: 409 }); // the PC tells us where to carry on
      else if (x.status === 403) { askPin('That PIN did not work.'); reject(new PinError()); }
      else if (x.status >= 500) reject(new Error('the PC had a problem'));
      else reject(Object.assign(new Error(x.responseText || 'HTTP ' + x.status), { fatal: true }));
    };
    x.onerror = () => reject(new Error('connection lost'));
    x.ontimeout = () => reject(new Error('timed out'));
    x.timeout = 120000;
    x.send(file.slice(offset, end));
  });
}

/* ---- end-to-end encryption for files sent to one device (crypto in e2e.js) ----
   Each browser keeps a P-256 key pair in IndexedDB; the private half cannot be read out, not even by this page.
   The PC only relays sealed bytes and deletes them once the recipient confirms it saved the file. */
const E2E = window.RooftopE2E && window.crypto?.subtle ? window.RooftopE2E : null;
let myPair = null, myRaw = null, myKey = '';

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

async function loadKeys() {
  if (!E2E) return;
  try {
    myPair = await keyStore('readonly', (s) => s.get('me'));
  } catch { /* private browsing: a key for this visit only */ }
  if (!myPair) {
    myPair = await E2E.newKeyPair();
    try { await keyStore('readwrite', (s) => s.put(myPair, 'me')); } catch { /* kept in memory */ }
  }
  myRaw = await E2E.publicRaw(myPair);
  myKey = E2E.b64(myRaw);
}
const keysReady = loadKeys().catch(() => { myPair = null; });

async function registerKey() {
  await keysReady;
  if (myKey && state.youKey !== myKey) await call('/api/key', { method: 'POST', body: myKey }).catch(() => {});
}

const safetyCodeFor = (theirKey) => E2E.safetyCode(myRaw, E2E.unb64(theirKey));

/** The device chosen in "Send to", if it is one browser that can receive sealed files. */
function sealedTarget() {
  const to = $('#sendTo').value;
  if (!E2E || !myPair || to === '*' || to === state.meId) return null;
  const d = state.devices.find((x) => x.id === to);
  return d && d.key ? d : null;
}

async function sendSealed(file, onProgress) {
  const target = sealedTarget();
  const key = E2E.b64(crypto.getRandomValues(new Uint8Array(12))); // a new id per send: one-time keys never mix
  const pieces = E2E.seal(file, file.name, E2E.unb64(target.key), myRaw);
  let offset = 0, total = 0;
  for await (const piece of pieces) {
    if (!total) total = E2E.sealedSize(file.size, piece.length - 8);
    for (let failures = 0; ;) {
      try {
        const res = await postSealed(piece, key, offset, total, target.id, (loaded) => onProgress((offset + loaded) / total));
        if (res.offset === offset + piece.length) break;
        if (res.offset !== offset) throw Object.assign(new Error('the PC lost track of this file'), { fatal: true });
      } catch (e) {
        if (e instanceof PinError || e.fatal || ++failures > RETRIES) throw e;
        toast(`Connection hiccup, retrying (${failures} of ${RETRIES})`);
        await sleep(1000 * failures);
      }
    }
    offset += piece.length;
  }
}

function postSealed(piece, key, offset, total, to, onLoaded) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', withPin(`/api/sealed/upload?key=${key}&offset=${offset}&size=${total}&to=${encodeURIComponent(to)}`));
    x.upload.onprogress = (e) => onLoaded(e.loaded);
    x.onload = () => {
      let body = {};
      try { body = JSON.parse(x.responseText); } catch { /* not JSON */ }
      if (x.status === 200 || x.status === 409) resolve(body);
      else if (x.status === 403) { askPin('That PIN did not work.'); reject(new PinError()); }
      else reject(Object.assign(new Error(x.responseText || 'HTTP ' + x.status), { fatal: x.status < 500 }));
    };
    x.onerror = () => reject(new Error('connection lost'));
    x.send(piece);
  });
}

// Receiving: one card at a time. Open = download + decrypt here; Save = keep it; then the PC deletes its copy.
let sealedShowing = null;
const sealedDone = new Set();
function offerSealed(list) {
  if (sealedShowing || !myPair) return;
  const next = list.find((s) => !sealedDone.has(s.id));
  if (!next) return;
  sealedShowing = next;
  $('#sealedBody').textContent = `${humanSize(next.size)} waiting for you. Only this device can open it.`;
  $('#sealedCode').textContent = '';
  $('#sealedOpen').hidden = false;
  $('#sealedOpen').disabled = false;
  $('#sealedOpen').textContent = 'Open';
  $('#sealedSave').hidden = true;
  $('#sealedCard').hidden = false;
}

$('#sealedOpen').addEventListener('click', async () => {
  const item = sealedShowing;
  const btn = $('#sealedOpen');
  btn.disabled = true;
  try {
    const res = await call('/api/sealed/' + item.id);
    const out = await E2E.open(res.body.getReader(), myPair.privateKey,
      (got) => { btn.textContent = `${Math.round((got / item.size) * 100)}%`; });
    const sender = state.devices.find((d) => d.key === E2E.b64(out.senderRaw));
    const code = await E2E.safetyCode(myRaw, out.senderRaw);
    const url = URL.createObjectURL(new Blob(out.parts));
    const save = $('#sealedSave');
    save.href = url;
    save.download = out.name;
    save.textContent = 'Save';
    save.hidden = false;
    btn.hidden = true;
    $('#sealedBody').textContent = `${out.name} from ${sender ? sender.name : 'a device that has left'}`;
    $('#sealedCode').replaceChildren('Safety code ', el('b', { textContent: code }), '. It should match the sender\'s screen.');
    save.onclick = () => setTimeout(async () => {
      await call(`/api/sealed/${item.id}/ack`, { method: 'POST' }).catch(() => {});
      sealedDone.add(item.id);
      URL.revokeObjectURL(url);
      $('#sealedCard').hidden = true;
      sealedShowing = null;
      toast('Saved. The PC has deleted its encrypted copy.');
      refresh();
    }, 1500);
  } catch (e) {
    if (e instanceof PinError) return;
    btn.disabled = false;
    btn.textContent = 'Try again';
    $('#sealedBody').textContent = 'Could not open it: it was damaged, or it was sealed for a key this browser no longer has.';
  }
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

  $('#textList').replaceChildren(...state.texts.map((t) => {
    const b = el('button', { type: 'button', textContent: t.text });
    b.addEventListener('click', () => { $('#note').value = t.text; $('#note').focus(); $('#note').select(); });
    return el('li', {}, b);
  }));
  $('#textEmpty').hidden = state.texts.length > 0;

  $('.you').hidden = state.local;
  $('#youName').textContent = state.you || 'this device';
  $('#pcName').textContent = state.me || 'the PC';
  $('#deviceList').replaceChildren(...state.devices.map((d) => {
    const li = el('li', {}, el('span', { textContent: d.name }), el('span', { className: 'kind', textContent: d.kind }));
    if (d.key && myKey) safetyCodeFor(d.key).then((code) => li.append(el('span', { className: 'code', textContent: `code ${code}` })));
    return li;
  }));
  $('#deviceList').hidden = !state.devices.length;
  $('#deviceEmpty').hidden = state.devices.length > 0;
  if (isLocal) renderHost();
}

/* ---- the PC's own console ---- */
function renderHost() {
  $('#hostCount').textContent = state.devices.length;
  $('#hostDevices').replaceChildren(...state.devices.map((d) =>
    el('li', {}, el('span', { textContent: d.name }), el('span', { className: 'kind', textContent: d.kind }))));
  $('#hostDevices').hidden = !state.devices.length;
  $('#hostDevicesEmpty').hidden = state.devices.length > 0;

  const first = seenTexts.size === 0;
  $('#hostMessages').replaceChildren(...state.texts.map((t) => {
    const key = t.at + t.from;
    const copy = el('button', { className: 'icon-btn', type: 'button' }, icon('i-copy'));
    copy.setAttribute('aria-label', 'Copy message');
    copy.addEventListener('click', () => copyText(t.text));
    const li = el('li', {}, el('span', { className: 'msg', textContent: t.text }),
      el('span', { className: 'meta', textContent: `${t.from}, ${timeAgo(t.at)}` }), copy);
    if (!first && !seenTexts.has(key)) li.classList.add('fresh');
    return li;
  }));
  seenTexts = new Set(state.texts.map((t) => t.at + t.from));
  if (first && !state.texts.length) seenTexts.add('none');
  $('#hostMessages').hidden = !state.texts.length;
  $('#hostMessagesEmpty').hidden = state.texts.length > 0;
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

/* ---- text and clipboard ---- */
$('#noteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#note').value;
  const error = $('#noteError');
  if (!text.trim()) { error.textContent = 'Type or paste something first.'; return; }
  error.textContent = '';
  try {
    await call('/api/text', { method: 'POST', body: text });
    toast(`Text is on ${state.me}'s clipboard`);
    refresh();
  } catch (err) {
    if (!(err instanceof PinError)) error.textContent = 'Could not reach the PC. Try again.';
  }
});

$('#pullClip').addEventListener('click', async () => {
  try {
    const text = await (await call('/api/clip')).text();
    $('#note').value = text;
    $('#noteError').textContent = '';
    toast(text ? 'Got the PC clipboard' : 'The PC clipboard is empty');
  } catch (err) {
    if (!(err instanceof PinError)) $('#noteError').textContent = 'Could not reach the PC. Try again.';
  }
});

$('#copyNote').addEventListener('click', async () => {
  const note = $('#note');
  try {
    await navigator.clipboard.writeText(note.value);
  } catch {
    note.focus();
    note.select();
    document.execCommand('copy'); // older browsers
  }
  toast('Copied');
});

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
  $('#introEnter').addEventListener('click', () => {
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
    }, 1400);
  }, { once: true });
}
runIntro();
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
if (!pin && !isLocal) askPin('');
else refresh();
if (isLocal) {
  document.body.classList.add('is-host');
  $('#host').hidden = false;
  loadConnect();
  setInterval(loadConnect, 5000); // new Wi-Fi or hotspot means a new address, so a new QR code
}
