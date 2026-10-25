// Builds an avatar from adapted parameters (see adapter/adapt.js) out of simple shapes.
// This is the procedural stand-in for the MakeHuman base mesh: the same parameters
// will later drive morph targets instead of these shapes.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { createMaterials } from './materials.js';

const lerp = (a, b, t) => a + (b - a) * t;

function shade(hex, f) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(f);
  return `#${c.getHexString()}`;
}

/**
 * @param adapted result of adapt()
 * @param profile the game profile (for figure type and theme)
 * @returns { root, rig: { legL, legR, armL, armR, body }, height }
 */
export function buildFigure(adapted, profile) {
  const theme = profile.theme;
  const mats = createMaterials(theme);
  const seg = theme.lowPoly ? { s: 7, r: 5, c: 6 } : { s: 28, r: 20, c: 24 };
  const p = (k) => adapted.params[k] ?? 0.5;
  const color = (k, fallback) => adapted.params[k] ?? fallback;

  function mesh(geo, mat, { outline = true } = {}) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    if (outline && mats.outlines) {
      const o = new THREE.Mesh(geo, mats.outline);
      o.scale.setScalar(1.06);
      o.userData.outline = true;
      m.add(o);
    }
    return m;
  }
  const sphere = (r) => new THREE.SphereGeometry(r, seg.s, seg.r);
  const capsule = (r, len) => new THREE.CapsuleGeometry(r, len, Math.max(2, seg.r / 4), seg.c);

  const ctx = { p, color, mats, mesh, sphere, capsule, seg, theme, options: adapted.options };
  return profile.figure === 'bean' ? buildBean(ctx) : buildHuman(ctx);
}

// ---------------------------------------------------------------------------
// Human

function buildHuman(ctx) {
  const { p, color, mats, mesh, sphere, capsule, seg, theme, options } = ctx;
  const root = new THREE.Group();
  const skin = mats.make(color('colors.skin', '#c68e6a'));
  const top = mats.make(color('colors.primary', '#c0392b'));
  const pants = mats.make(color('colors.secondary', '#1c1c1c'));
  const shoes = mats.make(shade(color('colors.secondary', '#1c1c1c'), 0.5));

  const scale = lerp(0.85, 1.15, p('body.height'));
  const legLen = 0.82 * lerp(0.82, 1.18, p('body.legLength'));
  const torsoLen = 0.56 * lerp(0.85, 1.15, p('body.torsoLength'));
  const armLen = 0.62 * lerp(0.85, 1.15, p('body.armLength'));
  const shoulder = 0.2 * lerp(0.78, 1.25, p('body.shoulderWidth'));
  const hip = 0.15 * lerp(0.8, 1.3, p('body.hipWidth'));
  const bulk = lerp(0.85, 1.25, p('body.muscle')) * lerp(0.9, 1.25, p('body.bodyFat'));
  const limbR = 0.055 * bulk;
  const depth = lerp(0.55, 0.85, p('body.bodyFat'));

  const body = new THREE.Group();
  body.position.y = legLen;
  root.add(body);

  // Torso: wider at the shoulders, narrower at the hips.
  const torso = mesh(new THREE.CylinderGeometry(shoulder, hip, torsoLen, seg.c), top);
  torso.scale.z = depth;
  torso.position.y = torsoLen / 2;
  body.add(torso);
  const belly = mesh(sphere(hip * 1.02), top);
  belly.scale.set(1, 0.6, depth * lerp(1, 1.5, p('body.bodyFat')));
  body.add(belly);
  const chest = mesh(sphere(shoulder * 0.96), top);
  chest.scale.set(1, 0.45 * lerp(0.9, 1.2, p('body.muscle')), depth * lerp(1, 1.25, p('body.muscle')));
  chest.position.y = torsoLen;
  body.add(chest);

  // Limbs hang from pivots so the play mode can swing them.
  function limb(x, y, len, r, mat, endMat, parent) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const l = mesh(capsule(r, len), mat);
    l.position.y = -len / 2 - r * 0.5;
    pivot.add(l);
    const end = mesh(sphere(r * 1.15), endMat);
    end.position.y = -len - r;
    end.scale.z = endMat === shoes ? 1.8 : 1;
    if (endMat === shoes) end.position.z = r * 0.5;
    pivot.add(end);
    parent.add(pivot);
    return pivot;
  }
  const legL = limb(-hip * 0.55, legLen, legLen - limbR * 2.3, limbR * 1.25, pants, shoes, root);
  const legR = limb(hip * 0.55, legLen, legLen - limbR * 2.3, limbR * 1.25, pants, shoes, root);
  const armL = limb(-shoulder - limbR * 0.6, torsoLen, armLen, limbR, top, skin, body);
  const armR = limb(shoulder + limbR * 0.6, torsoLen, armLen, limbR, top, skin, body);
  armL.rotation.z = -0.12;
  armR.rotation.z = 0.12;

  const neck = mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.1, seg.c), skin);
  neck.position.y = torsoLen + 0.07;
  body.add(neck);

  const head = buildHead(ctx, theme.headScale ?? 1);
  head.position.y = torsoLen + 0.13;
  body.add(head);

  humanOptions(ctx, { body, head, torsoLen, shoulder, hip, depth, legLen, root });

  root.scale.setScalar(scale);
  const height = (legLen + torsoLen + 0.4) * scale;
  return { root, rig: { legL, legR, armL, armR, body, head }, height };
}

function buildHead(ctx, headScale) {
  const { p, color, mats, mesh, sphere, seg } = ctx;
  const head = new THREE.Group();
  const r = 0.11 * headScale;
  const skinHex = color('colors.skin', '#c68e6a');
  const skin = mats.make(skinHex);
  const faceLen = lerp(0.9, 1.12, p('face.faceLength'));

  // Cranium, shaped by the forehead sliders.
  const cranium = mesh(sphere(r), skin);
  cranium.scale.set(lerp(0.9, 1.08, p('face.foreheadWidth')), faceLen * lerp(0.95, 1.08, p('face.foreheadHeight')), 1.02);
  cranium.position.y = r * 1.05;
  head.add(cranium);

  // Jaw: a tapered cylinder; a sharper jaw has a narrower bottom.
  const jawH = r * lerp(0.55, 0.9, p('face.chinLength')) * faceLen;
  const jaw = mesh(new THREE.CylinderGeometry(r * 0.9, r * lerp(0.62, 0.22, p('face.jawSharpness')), jawH, seg.c), skin);
  jaw.scale.z = 0.92;
  jaw.position.y = r * 0.75 - jawH / 2 + r * 0.15;
  jaw.position.z = r * 0.05;
  head.add(jaw);
  const chin = mesh(sphere(r * lerp(0.3, 0.16, p('face.jawSharpness'))), skin, { outline: false });
  chin.position.set(0, jaw.position.y - jawH / 2 + r * 0.05, r * 0.32);
  head.add(chin);

  const cheek = p('face.cheekbones');
  for (const side of [-1, 1]) {
    const c = mesh(sphere(r * lerp(0.18, 0.3, cheek)), skin, { outline: false });
    c.position.set(side * r * lerp(0.6, 0.72, cheek), r * 0.85, r * 0.62);
    head.add(c);
  }

  const face = new THREE.Group();
  face.position.set(0, r * 1.0, r * 0.86);
  head.add(face);

  // Eyes.
  const eyeR = r * lerp(0.1, 0.24, p('face.eyeSize'));
  const eyeX = r * lerp(0.26, 0.46, p('face.eyeSpacing'));
  const white = mats.make('#fbfbfb');
  const iris = mats.make(color('colors.eyes', '#4a3020'));
  const pupil = mats.make('#0b0b0b');
  for (const side of [-1, 1]) {
    const e = mesh(sphere(eyeR), white, { outline: false });
    e.scale.set(1, ctx.theme.shader === 'toon' ? 1.25 : 0.85, 0.5);
    e.position.set(side * eyeX, 0, 0.0);
    face.add(e);
    const i = mesh(sphere(eyeR * 0.62), iris, { outline: false });
    i.scale.set(1, ctx.theme.shader === 'toon' ? 1.35 : 1, 0.5);
    i.position.set(side * eyeX, -eyeR * 0.05, eyeR * 0.3);
    face.add(i);
    const pu = mesh(sphere(eyeR * 0.3), pupil, { outline: false });
    pu.scale.z = 0.5;
    pu.position.set(side * eyeX, -eyeR * 0.05, eyeR * 0.45);
    face.add(pu);
    // Brows.
    const brow = mesh(new THREE.BoxGeometry(eyeR * 2.2, r * 0.06, r * 0.06), mats.make(color('hair.color', '#3b2a1e')), { outline: false });
    brow.position.set(side * eyeX, eyeR + r * lerp(0.08, 0.26, p('face.browHeight')), eyeR * 0.15);
    brow.rotation.z = side * -0.12;
    face.add(brow);
  }

  // Nose.
  const nose = mesh(new THREE.ConeGeometry(r * lerp(0.07, 0.17, p('face.noseWidth')), r * 0.32, Math.max(4, seg.c / 3)), mats.make(shade(skinHex, 0.95)), { outline: false });
  nose.rotation.x = lerp(1.15, 0.75, p('face.noseBridge'));
  nose.position.set(0, -r * 0.24, r * lerp(0.04, 0.12, p('face.noseBridge')));
  face.add(nose);

  // Lips.
  const lips = mesh(new THREE.CapsuleGeometry(r * lerp(0.025, 0.07, p('face.lipFullness')), r * 0.22, 2, 8), mats.make(shade(skinHex, 0.75)), { outline: false });
  lips.rotation.z = Math.PI / 2;
  lips.position.set(0, -r * 0.55, -r * 0.05);
  face.add(lips);

  buildHair(ctx, head, r, cranium);
  head.userData.radius = r;
  return head;
}

function buildHair(ctx, head, r, cranium) {
  const { p, color, mats, mesh, sphere, seg } = ctx;
  if (!ctx.color('hair.style', null)) return; // hair hidden by this game
  const style = color('hair.style', 'short');
  const hair = mats.make(color('hair.color', '#3b2a1e'));
  const vol = lerp(1.0, 1.14, p('hair.volume'));
  const len = p('hair.length');
  const group = new THREE.Group();
  group.position.copy(cranium.position);
  group.scale.copy(cranium.scale);
  head.add(group);

  const cap = (scale, thetaLength) => {
    const g = new THREE.SphereGeometry(r * scale, seg.s, seg.r, 0, Math.PI * 2, 0, thetaLength);
    const m = mesh(g, hair);
    // Tilt the hairline up at the front so the forehead and eyes stay visible.
    m.rotation.x = -0.55;
    group.add(m);
    return m;
  };

  switch (style) {
    case 'buzz':
      cap(1.025, Math.PI * 0.5);
      break;
    case 'short':
      cap(1.06 * vol, Math.PI * 0.5);
      break;
    case 'slick-back': {
      const c = cap(1.05 * vol, Math.PI * 0.52);
      c.scale.z = 1.2;
      c.position.z = -r * 0.08;
      c.rotation.x = -0.7;
      break;
    }
    case 'spiky': {
      cap(1.04, Math.PI * 0.48);
      const spikeLen = r * lerp(0.15, 0.7, p('hair.spikiness')) * lerp(0.6, 1.3, len) * vol;
      const n = ctx.theme.lowPoly ? 9 : 16;
      for (let i = 0; i < n; i++) {
        // Spread spikes over the top and back of the head with a golden-angle spiral.
        const t = (i + 0.5) / n;
        const polar = Math.acos(1 - t * 0.9);
        const az = i * 2.39996;
        const dir = new THREE.Vector3(Math.sin(polar) * Math.cos(az), Math.cos(polar), Math.sin(polar) * Math.sin(az));
        if (dir.z > 0.55) dir.z = 0.55; // keep spikes out of the face
        dir.normalize();
        const cone = mesh(new THREE.ConeGeometry(r * 0.2, spikeLen, Math.max(4, seg.c / 4)), hair);
        cone.position.copy(dir.clone().multiplyScalar(r * 0.95 + spikeLen / 2));
        cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        group.add(cone);
      }
      break;
    }
    case 'curly': {
      const n = ctx.theme.lowPoly ? 18 : 42;
      const cr = r * lerp(0.2, 0.3, p('hair.volume'));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const polar = Math.acos(1 - t * 1.15);
        const az = i * 2.39996;
        const dir = new THREE.Vector3(Math.sin(polar) * Math.cos(az), Math.cos(polar), Math.sin(polar) * Math.sin(az));
        if (dir.z > 0.6 && dir.y < 0.5) continue;
        const ball = mesh(sphere(cr), hair, { outline: i % 3 === 0 });
        ball.position.copy(dir.multiplyScalar(r * vol * lerp(0.98, 1.1, len)));
        group.add(ball);
      }
      break;
    }
    case 'long': {
      cap(1.06 * vol, Math.PI * 0.58);
      const backLen = r * lerp(1.2, 4.2, len);
      const back = mesh(new THREE.BoxGeometry(r * 1.9 * vol, backLen, r * 0.35), hair);
      back.position.set(0, -backLen / 2 + r * 0.4, -r * 0.72);
      group.add(back);
      for (const side of [-1, 1]) {
        const lock = mesh(new THREE.BoxGeometry(r * 0.32, backLen * 0.7, r * 0.5), hair);
        lock.position.set(side * r * 0.95 * vol, -backLen * 0.35 + r * 0.3, -r * 0.2);
        group.add(lock);
      }
      break;
    }
  }
}

function humanOptions(ctx, { body, head, torsoLen, shoulder, hip, depth }) {
  const { options, mats, mesh, sphere, seg, color } = ctx;
  const r = head.userData.radius ?? 0.11;
  const primary = color('colors.primary', '#c0392b');

  // Anime RPG
  if (options.outfit === 'mage-robe') {
    const robe = mesh(new THREE.ConeGeometry(hip * 2.1, 0.55, seg.c, 1, true), mats.make(primary, { double: true }));
    robe.position.y = -0.18;
    body.add(robe);
  } else if (options.outfit === 'adventurer') {
    const belt = mesh(new THREE.TorusGeometry(hip * 1.02, 0.018, 6, seg.c), mats.make('#6b4423'), { outline: false });
    belt.rotation.x = Math.PI / 2;
    belt.scale.y = depth;
    belt.position.y = 0.04;
    body.add(belt);
  } else if (options.outfit === 'school-uniform') {
    const collar = mesh(new THREE.ConeGeometry(shoulder * 0.75, 0.12, seg.c, 1, true), mats.make('#f4f4f4', { double: true }));
    collar.position.y = torsoLen - 0.01;
    collar.scale.z = depth;
    body.add(collar);
    const tie = mesh(new THREE.BoxGeometry(0.035, 0.16, 0.01), mats.make('#2c3e8f'), { outline: false });
    tie.position.set(0, torsoLen - 0.12, shoulder * depth + 0.01);
    body.add(tie);
  }
  if (options.accessory === 'headband') {
    const band = mesh(new THREE.TorusGeometry(r * 1.04, r * 0.08, 6, seg.c), mats.make('#e23b3b'), { outline: false });
    band.rotation.x = Math.PI / 2 - 0.25;
    band.position.y = r * 1.35;
    head.add(band);
  } else if (options.accessory === 'earring') {
    for (const side of [-1, 1]) {
      const e = mesh(sphere(r * 0.07), mats.make('#f2c94c', { shiny: true }), { outline: false });
      e.position.set(side * r * 0.93, r * 0.62, 0);
      head.add(e);
    }
  }

  // Retro shooter
  const metal = mats.make('#5f574f');
  if (options.armor === 'heavy' || options.armor === 'light') {
    const heavy = options.armor === 'heavy';
    const plate = mesh(new THREE.BoxGeometry(shoulder * 1.5, torsoLen * 0.55, 0.04), metal);
    plate.position.set(0, torsoLen * 0.62, shoulder * depth * 0.95);
    body.add(plate);
    if (heavy) {
      for (const side of [-1, 1]) {
        const pad = mesh(new THREE.BoxGeometry(0.13, 0.07, 0.15), metal);
        pad.position.set(side * (shoulder + 0.03), torsoLen + 0.02, 0);
        body.add(pad);
      }
    }
  }
  if (options.helmet === 'visor') {
    const v = mesh(new THREE.BoxGeometry(r * 1.8, r * 0.32, r * 0.25), mats.make('#29adff', { shiny: true }), { outline: false });
    v.position.set(0, r * 1.02, r * 0.86);
    head.add(v);
  } else if (options.helmet === 'full') {
    const h = mesh(new THREE.SphereGeometry(r * 1.22, seg.s, seg.r, 0, Math.PI * 2, 0, Math.PI * 0.62), metal);
    h.position.y = r * 1.05;
    head.add(h);
    const slit = mesh(new THREE.BoxGeometry(r * 1.4, r * 0.18, r * 0.2), mats.make('#ff004d', { shiny: true }), { outline: false });
    slit.position.set(0, r * 1.0, r * 1.05);
    head.add(slit);
  }
}

// ---------------------------------------------------------------------------
// Bean (Among Us-style concept): our own simple model, not Innersloth's art.

const VISORS = { classic: '#93c9df', cyan: '#38fedc', gold: '#e8c547' };

// The bean shape: a lathe profile gives a rounded top, straight sides and a softly
// rounded bottom, closer to a crewmate than a plain capsule.
function beanBodyGeometry(w, tall, segments) {
  const pts = [];
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    // Bottom: a shallow rounded base.
    const a = (i / steps) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.sin(a) * w, w * 0.35 - Math.cos(a) * w * 0.35));
  }
  for (let i = 1; i <= steps; i++) {
    // Top: a full dome.
    const a = (i / steps) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.cos(a) * w, w * 0.35 + tall + Math.sin(a) * w * 1.02));
  }
  pts[pts.length - 1].x = 0;
  // Centred on its origin so the outline shell (a scaled copy) is even all round.
  const height = w * 1.37 + tall;
  return new THREE.LatheGeometry(pts, segments).translate(0, -height / 2, 0);
}

function buildBean(ctx) {
  const { p, color, mats, mesh, sphere, capsule, seg, options } = ctx;
  const root = new THREE.Group();
  const suitHex = color('colors.primary', '#c51111');
  const suit = mats.make(suitHex);
  const dark = mats.make(shade(suitHex, 0.72));

  const w = 0.3 * lerp(0.88, 1.18, p('body.bodyFat'));
  const tall = 0.36 * lerp(0.75, 1.3, p('body.height'));
  const legH = 0.2;

  // Legs: short and stubby, the body sits right on top of them.
  function leg(x) {
    const pivot = new THREE.Group();
    pivot.position.set(x, legH, -w * 0.05);
    const l = mesh(new RoundedBoxGeometry(w * 0.78, legH + w * 0.25, w * 1.2, 4, w * 0.3), suit);
    l.position.y = -legH / 2 + w * 0.02;
    pivot.add(l);
    root.add(pivot);
    return pivot;
  }
  const legL = leg(-w * 0.44);
  const legR = leg(w * 0.44);

  const body = new THREE.Group();
  body.position.y = legH * 0.75;
  root.add(body);
  const torso = mesh(beanBodyGeometry(w, tall, seg.c * 2), suit);
  torso.position.y = (w * 1.37 + tall) / 2;
  torso.scale.z = 0.92;
  body.add(torso);

  // Backpack: a rounded block on the back.
  const pack = mesh(new RoundedBoxGeometry(w * 1.25, tall + w * 0.55, w * 0.7, 4, w * 0.22), dark);
  pack.position.set(0, w * 0.35 + tall * 0.55, -w * 0.88);
  body.add(pack);

  // Visor: wide, glossy and sticking out of the front, with a light top band and a highlight.
  const visorY = w * 0.35 + tall + w * 0.18;
  const visorHex = VISORS[options.visor] ?? VISORS.classic;
  const visor = mesh(sphere(1), mats.make(visorHex, { shiny: true }));
  visor.scale.set(w * 0.72, w * 0.36, w * 0.46);
  visor.position.set(0, visorY, w * 0.62);
  body.add(visor);
  const band = mesh(sphere(1), mats.make(shade(visorHex, 1.25), { shiny: true }), { outline: false });
  band.scale.set(w * 0.52, w * 0.16, w * 0.18);
  band.position.set(w * 0.04, visorY + w * 0.13, w * 0.92);
  body.add(band);
  const shine = mesh(sphere(1), mats.make('#ffffff'), { outline: false });
  shine.scale.set(w * 0.2, w * 0.08, w * 0.05);
  shine.position.set(w * 0.22, visorY + w * 0.17, w * 1.04);
  body.add(shine);

  const topY = legH * 0.75 + w * 0.35 + tall + w * 1.0;
  beanHat(ctx, body, options.hat, topY - legH * 0.75, w);

  if (options.pet && options.pet !== 'none') {
    const pet = new THREE.Group();
    if (options.pet === 'mini-bean') {
      const pb = mesh(beanBodyGeometry(0.07, 0.05, seg.c), suit);
      pb.position.y = (0.07 * 1.37 + 0.05) / 2;
      pet.add(pb);
      const pv = mesh(sphere(1), mats.make(VISORS.classic, { shiny: true }));
      pv.scale.set(0.055, 0.03, 0.035);
      pv.position.set(0, 0.13, 0.055);
      pet.add(pv);
    } else {
      const box = mesh(new RoundedBoxGeometry(0.16, 0.14, 0.14, 3, 0.03), mats.make('#c2c3c7'));
      box.position.y = 0.1;
      pet.add(box);
      const eye = mesh(new THREE.BoxGeometry(0.1, 0.03, 0.01), mats.make('#38fedc', { shiny: true }), { outline: false });
      eye.position.set(0, 0.12, 0.075);
      pet.add(eye);
      const ant = mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.08, 4), mats.make('#5f574f'), { outline: false });
      ant.position.y = 0.21;
      pet.add(ant);
    }
    pet.position.set(w * 2.1, 0, w * 0.4);
    root.add(pet);
  }

  return { root, rig: { legL, legR, armL: null, armR: null, body, head: visor }, height: topY };
}

function beanHat(ctx, body, hat, topY, w) {
  const { mats, mesh, sphere, seg } = ctx;
  if (!hat || hat === 'none') return;
  const g = new THREE.Group();
  g.position.y = topY - w * 0.12;
  body.add(g);
  if (hat === 'cap') {
    const c = mesh(new THREE.SphereGeometry(w * 0.75, seg.s, seg.r, 0, Math.PI * 2, 0, Math.PI / 2), mats.make('#132ed1'));
    g.add(c);
    const brim = mesh(new THREE.CylinderGeometry(w * 0.5, w * 0.5, 0.02, seg.c, 1, false, -Math.PI / 2, Math.PI), mats.make('#132ed1'));
    brim.position.set(0, 0.01, w * 0.45);
    g.add(brim);
  } else if (hat === 'crown') {
    const gold = mats.make('#f2c94c', { shiny: true });
    const band = mesh(new THREE.CylinderGeometry(w * 0.55, w * 0.55, w * 0.25, seg.c, 1, true), mats.make('#f2c94c', { shiny: true, double: true }));
    band.position.y = w * 0.12;
    g.add(band);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const pt = mesh(new THREE.ConeGeometry(w * 0.1, w * 0.25, 5), gold);
      pt.position.set(Math.sin(a) * w * 0.55, w * 0.36, Math.cos(a) * w * 0.55);
      g.add(pt);
    }
  } else if (hat === 'spiky-hat') {
    const m = mats.make('#f5f557');
    const base = mesh(new THREE.SphereGeometry(w * 0.7, seg.s, seg.r, 0, Math.PI * 2, 0, Math.PI / 2), m);
    base.scale.y = 0.5;
    g.add(base);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const sp = mesh(new THREE.ConeGeometry(w * 0.13, w * 0.5, 5), m);
      sp.position.set(Math.sin(a) * w * 0.38, w * 0.3, Math.cos(a) * w * 0.38);
      sp.rotation.set(Math.cos(a) * 0.5, 0, -Math.sin(a) * 0.5);
      g.add(sp);
    }
  } else if (hat === 'flower') {
    const center = mesh(sphere(w * 0.14), mats.make('#f5f557'));
    center.position.y = w * 0.1;
    g.add(center);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const pet = mesh(sphere(w * 0.13), mats.make('#ed54ba'));
      pet.position.set(Math.sin(a) * w * 0.22, w * 0.1, Math.cos(a) * w * 0.22);
      g.add(pet);
    }
  } else if (hat === 'beanie') {
    const m = mats.make('#117f2d');
    g.add(mesh(new THREE.SphereGeometry(w * 0.72, seg.s, seg.r, 0, Math.PI * 2, 0, Math.PI / 2), m));
    const pom = mesh(sphere(w * 0.16), mats.make('#d6e0f0'));
    pom.position.y = w * 0.72;
    g.add(pom);
  }
}

/** Simple walk cycle; `phase` advances with distance walked, `amount` 0..1 blends idle to walk. */
export function animate(rig, phase, amount, t) {
  const swing = Math.sin(phase) * 0.7 * amount;
  if (rig.legL) rig.legL.rotation.x = swing;
  if (rig.legR) rig.legR.rotation.x = -swing;
  if (rig.armL) rig.armL.rotation.x = -swing * 0.8;
  if (rig.armR) rig.armR.rotation.x = swing * 0.8;
  if (rig.body) {
    rig.body.userData.baseY ??= rig.body.position.y;
    rig.body.position.y = rig.body.userData.baseY + Math.abs(Math.sin(phase)) * 0.03 * amount + Math.sin(t * 2) * 0.004;
  }
}
