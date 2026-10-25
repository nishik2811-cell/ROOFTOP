// Turns the player's avatar into one game's version of it, following that game's profile.
// Plain code on purpose: predictable, testable, and the part a studio integrates.
import { clamp01, DEFAULTS } from '../avatar/spec.js';

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// sRGB hex -> OKLab, so palette snapping matches how different colours look to people
// (OKLab handles blues much better than CIE Lab).
function toLab(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Perceptual difference between two colours in OKLab (0 = same, ~1 = black vs white). */
export function colorDistance(a, b) {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  // Hue and colourfulness count double: a palette match should keep "brown" brown.
  return Math.hypot(l1 - l2, 2 * (a1 - a2), 2 * (b1 - b2));
}

export function nearestColor(hex, palette) {
  let best = palette[0];
  let bestD = Infinity;
  for (const p of palette) {
    const d = colorDistance(hex, p);
    if (d < bestD) [best, bestD] = [p, d];
  }
  return best;
}

// A control rule applies to a key directly ("face.eyeSize") or to its group ("face").
export function ruleFor(controls, key) {
  return controls[key] ?? controls[key.split('.')[0]];
}

function matches(when, params) {
  return Object.entries(when).every(([key, expected]) => {
    const v = params[key];
    if (Array.isArray(v)) return v.includes(expected);
    if (expected && typeof expected === 'object') {
      if ('gte' in expected && !(v >= expected.gte)) return false;
      if ('lte' in expected && !(v <= expected.lte)) return false;
      return true;
    }
    return v === expected;
  });
}

/**
 * @param avatar  flat avatar (see spec.js)
 * @param profile a game profile (profiles/*.json)
 * @param choices the player's own picks for this game's options, e.g. { hat: 'crown' }
 * @returns { params, options, hidden, notes } where params are only the keys this game uses
 */
export function adapt(avatar, profile, choices = {}) {
  const controls = profile.controls ?? {};
  const theme = profile.theme ?? {};
  const params = {};
  const hidden = [];
  const notes = [];

  // 1. Mappings see the player's original values, so "spiky hair" can still become a spiky hat.
  const source = { ...DEFAULTS, ...avatar };
  const options = Object.fromEntries(Object.entries(profile.options ?? {}).map(([k, vals]) => [k, vals[0]]));
  const mapped = {};
  for (const m of profile.mappings ?? []) {
    if (!matches(m.when, source)) continue;
    for (const [k, v] of Object.entries(m.set)) {
      if (k in options) {
        if (profile.options[k].includes(v)) options[k] = v;
      } else mapped[k] = v;
    }
    if (m.note) notes.push(m.note);
  }

  // 2. Controls: hide what the game does not show, rescale ranges, snap colours.
  let snapped = false;
  for (const [key, raw] of Object.entries({ ...source, ...mapped })) {
    const rule = ruleFor(controls, key);
    if (rule === 'hidden') {
      hidden.push(key);
      continue;
    }
    let v = raw;
    if (typeof v === 'number') {
      if (!(key in mapped)) v = clamp01(v + (theme.proportions?.[key] ?? 0));
      if (rule && typeof rule === 'object' && 'min' in rule && !(key in mapped)) v = rule.min + v * (rule.max - rule.min);
    } else if (typeof v === 'string' && v.startsWith('#') && theme.palette?.length) {
      const snap = theme.snapAllColors || rule?.from === 'palette';
      if (snap) {
        const s = nearestColor(v, theme.palette);
        if (colorDistance(s, v) > 0.12) snapped = true;
        v = s;
      }
    }
    params[key] = v;
  }
  if (snapped) notes.push("Colours were matched to this game's palette.");

  // 3. The player's explicit picks win over mappings.
  for (const [k, v] of Object.entries(choices)) if (profile.options?.[k]?.includes(v)) options[k] = v;

  return { params, options, hidden, notes: [...new Set(notes)] };
}
