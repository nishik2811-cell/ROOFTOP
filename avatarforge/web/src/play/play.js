// "Play" mode: drop the avatar into a small walkable scene in the game's style,
// to show it is game-ready. Also exports the avatar as a GLB file.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { animate, buildFigure } from '../render/figures.js';
import { createStage, disposeTree } from '../render/preview.js';

export function openPlay({ overlay, canvas, title, profile, adapted }) {
  const stage = createStage(canvas, profile.theme, { ground: false });
  const { renderer, scene, camera, sun } = stage;
  const theme = profile.theme;
  const lowPoly = !!theme.lowPoly;

  // Ground and a few props in the game's colours.
  const pal = theme.palette?.length ? theme.palette : ['#7fb069', '#e6aa68', '#ca3c25', '#1d1a05', '#5e8c61'];
  const groundColor = new THREE.Color(theme.background).offsetHSL(0, 0, theme.shader === 'toon' ? -0.12 : 0.1);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40, 1, 1), new THREE.MeshLambertMaterial({ color: groundColor }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(40, 40, 0x000000, 0x000000);
  grid.material.opacity = 0.12;
  grid.material.transparent = true;
  scene.add(grid);

  const rand = mulberry32(7);
  const props = [];
  for (let i = 0; i < 26; i++) {
    const c = pal[Math.floor(rand() * pal.length)];
    const s = 0.4 + rand() * 1.2;
    const geo = rand() > 0.5 ? new THREE.BoxGeometry(s, s * (0.6 + rand()), s) : new THREE.CylinderGeometry(s * 0.4, s * 0.5, s * 1.4, lowPoly ? 6 : 20);
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: c, flatShading: lowPoly }));
    const a = rand() * Math.PI * 2;
    const d = 4 + rand() * 12;
    m.position.set(Math.cos(a) * d, geo.parameters.height / 2, Math.sin(a) * d);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    props.push(m);
  }

  const figure = buildFigure(adapted, profile);
  scene.add(figure.root);
  sun.target = figure.root;

  title.textContent = `${profile.name}: walk with WASD or the arrow keys`;
  overlay.hidden = false;
  stage.resize();

  const keys = new Set();
  const onKey = (e) => {
    if (e.key === 'Escape') return close();
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      e.preventDefault();
      if (e.type === 'keydown') keys.add(k);
      else keys.delete(k);
    }
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('resize', stage.resize);

  // Touch / mouse: hold the pointer on the canvas to walk toward it.
  let pointer = null;
  canvas.onpointerdown = (e) => (pointer = e);
  canvas.onpointermove = (e) => pointer && (pointer = e);
  canvas.onpointerup = () => (pointer = null);

  let phase = 0;
  let walk = 0;
  let heading = 0;
  let last = performance.now();
  let raf = requestAnimationFrame(loop);

  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const dir = new THREE.Vector3();
    if (keys.has('w') || keys.has('arrowup')) dir.z -= 1;
    if (keys.has('s') || keys.has('arrowdown')) dir.z += 1;
    if (keys.has('a') || keys.has('arrowleft')) dir.x -= 1;
    if (keys.has('d') || keys.has('arrowright')) dir.x += 1;
    if (pointer) {
      const r = canvas.getBoundingClientRect();
      dir.x += ((pointer.clientX - r.left) / r.width - 0.5) * 2;
      dir.z += ((pointer.clientY - r.top) / r.height - 0.6) * 2;
    }
    const moving = dir.lengthSq() > 0.01;
    walk += ((moving ? 1 : 0) - walk) * Math.min(1, dt * 8);
    if (moving) {
      dir.normalize();
      const speed = 1.6 * Math.max(0.8, figure.height / 1.7);
      figure.root.position.addScaledVector(dir, speed * dt);
      figure.root.position.clampLength(0, 19);
      const target = Math.atan2(dir.x, dir.z);
      let diff = target - heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      heading += diff * Math.min(1, dt * 10);
      phase += dt * 9;
    }
    figure.root.rotation.y = heading;
    animate(figure.rig, phase, walk, now / 1000);

    const h = figure.height;
    const p = figure.root.position;
    camera.position.lerp(new THREE.Vector3(p.x, p.y + h * 1.4 + 1, p.z + h * 2.2 + 2.2), Math.min(1, dt * 4));
    camera.lookAt(p.x, p.y + h * 0.5, p.z);
    sun.position.set(p.x + 2, 5, p.z + 3);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }

  function close() {
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKey);
    window.removeEventListener('resize', stage.resize);
    disposeTree(scene);
    renderer.dispose();
    overlay.hidden = true;
  }

  return { close };
}

/** Download the avatar for a game as a .glb file (outline shells are left out). */
export async function exportGlb(profile, adapted) {
  const figure = buildFigure(adapted, profile);
  const drop = [];
  figure.root.traverse((o) => o.userData.outline && drop.push(o));
  drop.forEach((o) => o.removeFromParent());
  figure.root.name = `avatarforge-${profile.id}`;
  figure.root.userData = { avatarforge: { profile: profile.id, options: adapted.options, params: adapted.params } };
  const glb = await new GLTFExporter().parseAsync(figure.root, { binary: true });
  const url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `avatar-${profile.id}.glb` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  disposeTree(figure.root);
}

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
