// Materials per theme shader: 'toon' (cel shading), 'flat' (faceted, simple light), 'pbr'.
import * as THREE from 'three';

let toonRamp;
function rampTexture() {
  if (toonRamp) return toonRamp;
  // Three hard light bands give the cel-shaded look.
  const data = new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]);
  toonRamp = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  toonRamp.minFilter = toonRamp.magFilter = THREE.NearestFilter;
  toonRamp.needsUpdate = true;
  return toonRamp;
}

export function createMaterials(theme) {
  const cache = new Map();
  const outline = new THREE.MeshBasicMaterial({ color: 0x1a1020, side: THREE.BackSide });

  function make(color, { shiny = false, double = false } = {}) {
    const key = `${color}|${shiny}|${double}`;
    if (cache.has(key)) return cache.get(key);
    let m;
    if (shiny) m = new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.15 });
    else if (theme.shader === 'toon') m = new THREE.MeshToonMaterial({ color, gradientMap: rampTexture() });
    else if (theme.shader === 'flat') m = new THREE.MeshLambertMaterial({ color, flatShading: !!theme.lowPoly });
    else m = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
    if (double) m.side = THREE.DoubleSide;
    cache.set(key, m);
    return m;
  }

  return { make, outline, outlines: !!theme.outline };
}
