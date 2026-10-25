// Holds the current avatar (flat form), applies patches and keeps an undo history.
import { DEFAULTS, physiques, sanitizePatch } from './spec.js';

export function createStore(initial = DEFAULTS) {
  let state = { ...initial };
  const history = [];
  const listeners = new Set();

  const emit = () => listeners.forEach((fn) => fn(state));

  function apply(patch, { record = true } = {}) {
    const clean = sanitizePatch(patch);
    if (!Object.keys(clean).length) return {};
    const next = { ...state };

    // Picking a physique preset sets its body sliders, unless the patch sets them itself.
    if (clean.physique && clean.physique !== 'custom') {
      for (const [k, v] of Object.entries(physiques[clean.physique])) if (!(k in clean)) next[k] = v;
    } else if (!('physique' in clean) && Object.keys(clean).some((k) => k.startsWith('body.'))) {
      // Touching any body slider by hand turns the preset into a custom build.
      clean.physique = 'custom';
    }
    Object.assign(next, clean);

    if (record) history.push(state);
    if (history.length > 100) history.shift();
    state = next;
    emit();
    return clean;
  }

  return {
    get: () => state,
    apply,
    undo() {
      if (!history.length) return false;
      state = history.pop();
      emit();
      return true;
    },
    reset() {
      history.push(state);
      state = { ...DEFAULTS };
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
