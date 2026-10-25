// Turns MediaPipe landmarks into avatar slider values.
// Only these numbers leave the camera code: no image is stored, sent or used as a texture.

// MediaPipe Face Mesh landmark indices.
export const FACE = {
  top: 10, chin: 152, left: 234, right: 454,
  jawL: 172, jawR: 397,
  eyeOuterR: 33, eyeInnerR: 133, eyeInnerL: 362, eyeOuterL: 263,
  eyeTopR: 159, eyeTopL: 386,
  browR: 105, browL: 334,
  noseL: 98, noseR: 327,
  lipTop: 0, lipBottom: 17,
  foreheadL: 54, foreheadR: 284,
};
// MediaPipe Pose landmark indices.
export const POSE = { shoulderL: 11, shoulderR: 12, hipL: 23, hipR: 24 };

// Slider limits for measured values, so a camera result never looks extreme.
export const SAFE = [0.2, 0.8];

// [low, high] of each ratio across typical faces; low maps to 0, high to 1.
const RANGES = {
  faceLength: [1.1, 1.5],
  jawWidth: [0.68, 0.9],
  eyeSpacing: [0.2, 0.32],
  eyeSize: [0.17, 0.25],
  noseWidth: [0.2, 0.32],
  lipFullness: [0.05, 0.12],
  foreheadHeight: [0.18, 0.32],
  foreheadWidth: [0.58, 0.82],
  chinLength: [0.1, 0.2],
  browHeight: [0.04, 0.1],
  shoulderToHip: [1.15, 1.7],
};

const norm = (v, [lo, hi]) => (v - lo) / (hi - lo);
const safe = (v) => Math.round(Math.min(SAFE[1], Math.max(SAFE[0], v)) * 100) / 100;
const round = (v) => Math.round(v * 1000) / 1000;

function dist(a, b, aspect) {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}
function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** The raw ratios (useful for calibration and for tests). */
export function faceRatios(lm, aspect = 1) {
  const d = (i, j) => dist(lm[i], lm[j], aspect);
  const faceW = d(FACE.left, FACE.right);
  const faceH = d(FACE.top, FACE.chin);
  const browMid = mid(lm[FACE.browR], lm[FACE.browL]);
  const eyeTopMid = mid(lm[FACE.eyeTopR], lm[FACE.eyeTopL]);
  return {
    faceLength: faceH / faceW,
    jawWidth: d(FACE.jawL, FACE.jawR) / faceW,
    eyeSpacing: d(FACE.eyeInnerR, FACE.eyeInnerL) / faceW,
    eyeSize: (d(FACE.eyeOuterR, FACE.eyeInnerR) + d(FACE.eyeInnerL, FACE.eyeOuterL)) / 2 / faceW,
    noseWidth: d(FACE.noseL, FACE.noseR) / faceW,
    lipFullness: d(FACE.lipTop, FACE.lipBottom) / faceH,
    foreheadHeight: dist(lm[FACE.top], browMid, aspect) / faceH,
    foreheadWidth: d(FACE.foreheadL, FACE.foreheadR) / faceW,
    chinLength: d(FACE.lipBottom, FACE.chin) / faceH,
    browHeight: dist(browMid, eyeTopMid, aspect) / faceH,
  };
}

/**
 * @param face   478 face landmarks ({x, y} normalised to the image), or null
 * @param pose   33 pose landmarks (with `visibility`), or null
 * @param aspect image width / height
 * @returns a patch of flat avatar keys
 */
export function landmarksToPatch(face, pose, aspect = 1) {
  const patch = {};
  if (face?.length >= 468) {
    const r = faceRatios(face, aspect);
    patch['face.faceLength'] = safe(norm(r.faceLength, RANGES.faceLength));
    // A narrower jaw (relative to the cheeks) reads as a sharper jawline.
    patch['face.jawSharpness'] = safe(1 - norm(r.jawWidth, RANGES.jawWidth));
    patch['face.eyeSpacing'] = safe(norm(r.eyeSpacing, RANGES.eyeSpacing));
    patch['face.eyeSize'] = safe(norm(r.eyeSize, RANGES.eyeSize));
    patch['face.noseWidth'] = safe(norm(r.noseWidth, RANGES.noseWidth));
    patch['face.lipFullness'] = safe(norm(r.lipFullness, RANGES.lipFullness));
    patch['face.foreheadHeight'] = safe(norm(r.foreheadHeight, RANGES.foreheadHeight));
    patch['face.foreheadWidth'] = safe(norm(r.foreheadWidth, RANGES.foreheadWidth));
    patch['face.chinLength'] = safe(norm(r.chinLength, RANGES.chinLength));
    patch['face.browHeight'] = safe(norm(r.browHeight, RANGES.browHeight));
  }
  const visible = (i) => (pose?.[i]?.visibility ?? 0) > 0.6;
  if (pose?.length >= 33 && Object.values(POSE).every(visible)) {
    const shoulders = dist(pose[POSE.shoulderL], pose[POSE.shoulderR], aspect);
    const hips = dist(pose[POSE.hipL], pose[POSE.hipR], aspect);
    const t = norm(shoulders / hips, RANGES.shoulderToHip);
    patch['body.shoulderWidth'] = safe(t);
    patch['body.hipWidth'] = safe(1 - t);
  }
  return patch;
}

/** Average several frames' landmarks to steady the measurement. */
export function averageLandmarks(frames) {
  const ok = frames.filter(Boolean);
  if (!ok.length) return null;
  return ok[0].map((_, i) => {
    const pts = ok.map((f) => f[i]);
    return {
      x: round(pts.reduce((s, p) => s + p.x, 0) / pts.length),
      y: round(pts.reduce((s, p) => s + p.y, 0) / pts.length),
      visibility: pts.reduce((s, p) => s + (p.visibility ?? 1), 0) / pts.length,
    };
  });
}
