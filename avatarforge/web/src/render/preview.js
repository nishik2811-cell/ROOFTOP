// One live preview per game profile: its own renderer, scene and art style.
import * as THREE from 'three';
import { animate, buildFigure } from './figures.js';

export function disposeTree(obj) {
  obj.traverse((o) => o.geometry?.dispose());
}

export function createStage(canvas, theme, { ground = true } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: (theme.pixelSize ?? 1) <= 1 });
  renderer.shadowMap.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(theme.background ?? '#202030');

  scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, theme.shader === 'toon' ? 1.6 : 1.3));
  const sun = new THREE.DirectionalLight(0xffffff, theme.shader === 'toon' ? 2.2 : 1.8);
  sun.position.set(2, 4, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun);

  if (ground) {
    const floorColor = new THREE.Color(theme.background ?? '#202030').offsetHSL(0, -0.05, theme.shader === 'toon' ? -0.08 : 0.08);
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(1.2, theme.lowPoly ? 8 : 48),
      new THREE.MeshLambertMaterial({ color: floorColor }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
  }

  if (theme.stars) {
    // A starfield behind the scene, for space-themed games.
    const pos = [];
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 600; i++) {
      const a = rnd() * Math.PI * 2;
      const y = rnd() * 2 - 0.6;
      pos.push(Math.cos(a) * 30, y * 20, Math.sin(a) * 30);
    }
    const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.12, sizeAttenuation: true })));
  }

  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);

  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    // The retro look comes from rendering at a fraction of the size and scaling up with
    // nearest-neighbour filtering (image-rendering: pixelated in CSS).
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) / (theme.pixelSize ?? 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  canvas.classList.toggle('pixelated', (theme.pixelSize ?? 1) > 1);

  return { renderer, scene, camera, sun, resize };
}

export function createPreview(canvas, profile) {
  const stage = createStage(canvas, profile.theme);
  const { renderer, scene, camera } = stage;
  let figure = null;
  let yaw = 0.35;
  let baseYaw = 0.25; // where the player last left it; the idle sway centres on this
  let dragging = null;
  let closeUp = false;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = e.clientX;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging === null) return;
    yaw += (e.clientX - dragging) * 0.01;
    baseYaw = yaw;
    dragging = e.clientX;
  });
  canvas.addEventListener('pointerup', () => (dragging = null));

  function update(adapted) {
    if (figure) {
      scene.remove(figure.root);
      disposeTree(figure.root);
    }
    figure = buildFigure(adapted, profile);
    scene.add(figure.root);
    frameCamera();
  }

  function frameCamera() {
    if (!figure) return;
    const h = figure.height;
    if (closeUp) {
      // Face close-up: aim at the head (the visor for the bean).
      figure.root.updateMatrixWorld(true);
      const head = new THREE.Vector3();
      figure.rig.head.getWorldPosition(head);
      const bean = profile.figure === 'bean';
      const hr = bean ? 0.3 : 0.11 * (profile.theme.headScale ?? 1) * figure.root.scale.y;
      const y = head.y + (bean ? -0.05 : hr * 1.05);
      // Fit about 3 head-widths across and 3.6 head-heights down, whatever the card's shape.
      const vfov = THREE.MathUtils.degToRad(camera.fov);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      const dist = Math.max((hr * 2.6) / Math.tan(vfov / 2), (hr * 2.2) / Math.tan(hfov / 2));
      camera.position.set(0, y + hr * 0.3, dist);
      camera.lookAt(0, y, 0);
    } else {
      // Fit the whole figure (plus a little room) in height and width.
      const vfov = THREE.MathUtils.degToRad(camera.fov);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      const dist = Math.max((h * 0.66) / Math.tan(vfov / 2), (h * 0.45) / Math.tan(hfov / 2)) + 0.3;
      camera.position.set(0, h * 0.6, dist);
      camera.lookAt(0, h * 0.5, 0);
    }
  }

  /** Switch between full body and face close-up; returns the new state. */
  function toggleCloseUp() {
    closeUp = !closeUp;
    frameCamera();
    return closeUp;
  }

  function frame(t) {
    if (!figure) return;
    if (dragging === null) {
      // A gentle sway keeps the front in view; drag to turn the character.
      yaw += (baseYaw + Math.sin(t * 0.6) * 0.45 - yaw) * 0.04;
    }
    figure.root.rotation.y = yaw;
    animate(figure.rig, 0, 0, t);
    renderer.render(scene, camera);
  }

  function resize() {
    stage.resize();
    frameCamera();
  }

  function dispose() {
    if (figure) disposeTree(figure.root);
    disposeTree(scene);
    renderer.dispose();
  }

  return { update, frame, toggleCloseUp, resize, dispose, getFigure: () => figure };
}
