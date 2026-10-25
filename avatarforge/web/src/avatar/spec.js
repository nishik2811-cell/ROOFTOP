// The player's avatar description (see shared/avatar-spec.json).
// Everything outside this file works with "flat" keys such as "face.jawSharpness".
import spec from '../../../shared/avatar-spec.json';
import physiques from '../../../shared/physiques.json';

export { spec, physiques };

const COLOR = /^#[0-9a-f]{6}$/i;

export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

export function unflatten(flat) {
  const out = {};
  for (const [key, v] of Object.entries(flat)) {
    const parts = key.split('.');
    let node = out;
    for (const p of parts.slice(0, -1)) node = node[p] ??= {};
    node[parts.at(-1)] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

export const DEFAULTS = flatten(spec.defaults);

/** 'slider' | 'color' | 'enum' | 'tags' | undefined for unknown keys. */
export function kindOf(key) {
  if (key in spec.enums) return 'enum';
  const d = DEFAULTS[key];
  if (typeof d === 'number') return 'slider';
  if (typeof d === 'string' && d.startsWith('#')) return 'color';
  if (Array.isArray(d)) return 'tags';
  return undefined;
}

export const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Keep only valid entries of a patch (flat key -> value). Sliders are clamped,
 * colours and enums must be well formed, unknown keys are dropped.
 */
export function sanitizePatch(patch) {
  const clean = {};
  for (const [key, v] of Object.entries(patch ?? {})) {
    switch (kindOf(key)) {
      case 'slider':
        if (typeof v === 'number' && Number.isFinite(v)) clean[key] = clamp01(v);
        break;
      case 'color':
        if (typeof v === 'string' && COLOR.test(v)) clean[key] = v.toLowerCase();
        break;
      case 'enum':
        if (spec.enums[key].includes(v)) clean[key] = v;
        break;
      case 'tags':
        if (Array.isArray(v)) {
          clean[key] = [...new Set(v.filter((t) => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean))]
            .slice(0, spec.maxVibeTags);
        }
        break;
    }
  }
  return clean;
}
