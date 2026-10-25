import { describe, expect, it } from 'vitest';
import { averageLandmarks, FACE, faceRatios, landmarksToPatch, POSE, SAFE } from '../src/capture/ratios.js';
import { sanitizePatch } from '../src/avatar/spec.js';

// A synthetic face: 478 points at the centre, with the measured ones placed by hand.
function face(over = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  const set = (i, x, y) => (lm[i] = { x, y });
  const o = { faceW: 0.4, faceH: 0.52, jawW: 0.31, eyeIn: 0.104, eyeW: 0.084, noseW: 0.104, lipH: 0.044, ...over };
  set(FACE.left, 0.5 - o.faceW / 2, 0.5); set(FACE.right, 0.5 + o.faceW / 2, 0.5);
  set(FACE.top, 0.5, 0.24); set(FACE.chin, 0.5, 0.24 + o.faceH);
  set(FACE.jawL, 0.5 - o.jawW / 2, 0.66); set(FACE.jawR, 0.5 + o.jawW / 2, 0.66);
  set(FACE.eyeInnerR, 0.5 - o.eyeIn / 2, 0.42); set(FACE.eyeInnerL, 0.5 + o.eyeIn / 2, 0.42);
  set(FACE.eyeOuterR, 0.5 - o.eyeIn / 2 - o.eyeW, 0.42); set(FACE.eyeOuterL, 0.5 + o.eyeIn / 2 + o.eyeW, 0.42);
  set(FACE.eyeTopR, 0.42, 0.41); set(FACE.eyeTopL, 0.58, 0.41);
  set(FACE.browR, 0.42, 0.37); set(FACE.browL, 0.58, 0.37);
  set(FACE.noseL, 0.5 - o.noseW / 2, 0.55); set(FACE.noseR, 0.5 + o.noseW / 2, 0.55);
  set(FACE.lipTop, 0.5, 0.63); set(FACE.lipBottom, 0.5, 0.63 + o.lipH);
  set(FACE.foreheadL, 0.36, 0.3); set(FACE.foreheadR, 0.64, 0.3);
  return lm;
}

function pose(shoulderW, hipW, visibility = 0.9) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility }));
  lm[POSE.shoulderL] = { x: 0.5 + shoulderW / 2, y: 0.4, visibility };
  lm[POSE.shoulderR] = { x: 0.5 - shoulderW / 2, y: 0.4, visibility };
  lm[POSE.hipL] = { x: 0.5 + hipW / 2, y: 0.7, visibility };
  lm[POSE.hipR] = { x: 0.5 - hipW / 2, y: 0.7, visibility };
  return lm;
}

describe('faceRatios', () => {
  it('measures relative to face size', () => {
    const r = faceRatios(face());
    expect(r.faceLength).toBeCloseTo(1.3);
    expect(r.jawWidth).toBeCloseTo(0.775);
  });

  it('does not change when the face is closer to the camera', () => {
    const near = face().map((p) => ({ x: 0.5 + (p.x - 0.5) * 1.5, y: 0.5 + (p.y - 0.5) * 1.5 }));
    const a = faceRatios(face());
    const b = faceRatios(near);
    for (const k of Object.keys(a)) expect(b[k]).toBeCloseTo(a[k]);
  });
});

describe('landmarksToPatch', () => {
  it('produces valid, safe slider values only', () => {
    const p = landmarksToPatch(face(), null);
    expect(Object.keys(p).length).toBe(10);
    expect(sanitizePatch(p)).toEqual(p);
    for (const v of Object.values(p)) {
      expect(v).toBeGreaterThanOrEqual(SAFE[0]);
      expect(v).toBeLessThanOrEqual(SAFE[1]);
    }
  });

  it('reads a narrow jaw as sharper', () => {
    const wide = landmarksToPatch(face({ jawW: 0.35 }), null)['face.jawSharpness'];
    const narrow = landmarksToPatch(face({ jawW: 0.28 }), null)['face.jawSharpness'];
    expect(narrow).toBeGreaterThan(wide);
  });

  it('clamps extreme faces into the safe range', () => {
    expect(landmarksToPatch(face({ eyeW: 0.3 }), null)['face.eyeSize']).toBe(SAFE[1]);
  });

  it('measures shoulders against hips when the body is visible', () => {
    const p = landmarksToPatch(null, pose(0.4, 0.25));
    expect(p['body.shoulderWidth']).toBeGreaterThan(p['body.hipWidth']);
  });

  it('skips the body when it is not clearly visible', () => {
    expect(landmarksToPatch(null, pose(0.4, 0.25, 0.3))).toEqual({});
  });
});

describe('averageLandmarks', () => {
  it('averages frames and skips empty ones', () => {
    const avg = averageLandmarks([[{ x: 0.2, y: 0.4 }], null, [{ x: 0.4, y: 0.6 }]]);
    expect(avg[0].x).toBeCloseTo(0.3);
    expect(avg[0].y).toBeCloseTo(0.5);
    expect(averageLandmarks([null])).toBeNull();
  });
});
