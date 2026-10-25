// The left panel. It shows only the controls the selected game uses, plus that game's own items.
import { ruleFor } from '../adapter/adapt.js';
import { DEFAULTS, spec } from '../avatar/spec.js';

export function label(key) {
  const name = key.split('.').at(-1);
  const words = name.replace(/([A-Z])/g, ' $1').toLowerCase();
  return words[0].toUpperCase() + words.slice(1);
}

const el = (tag, props = {}, children = []) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
};
const pretty = (v) => (v === 'custom' ? 'Custom' : v.replace(/-/g, ' '));

/**
 * @param onChoice (optionName, value) when the player picks one of the game's items
 */
export function createControls(root, store, onChoice) {
  const inputs = new Map(); // key -> input element
  const values = new Map(); // key -> number shown next to a slider
  const rows = new Map(); // key -> row element (to hide per game)
  const chipSets = new Map(); // key -> [buttons]
  const groups = []; // { details, keys }
  let profile = null;
  let adapted = null;

  // The selected game's own items (hats, outfits…), rebuilt when the game changes.
  const itemsBody = el('div');
  const itemsTitle = el('h3');
  const items = el('details', { className: 'group', open: true }, [el('summary', {}, [itemsTitle]), itemsBody]);
  root.append(items);

  function group(title, entries, open = true) {
    const details = el('details', { className: 'group', open }, [el('summary', {}, [el('h3', { textContent: title })])]);
    const keys = [];
    for (const [key, node] of entries) {
      details.append(node);
      if (key) {
        rows.set(key, node);
        keys.push(key);
      }
    }
    root.append(details);
    groups.push({ details, keys });
  }

  function chips(key, values) {
    const buttons = values.map((v) =>
      el('button', { type: 'button', className: 'chip', textContent: pretty(v), onclick: () => store.apply({ [key]: v }) }),
    );
    buttons.forEach((b, i) => (b.dataset.value = values[i]));
    chipSets.set(key, buttons);
    return [key, el('div', { className: 'chips' }, buttons)];
  }

  function slider(key) {
    const input = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: DEFAULTS[key] });
    input.setAttribute('aria-label', label(key));
    // One undo step per drag, not per pixel.
    input.addEventListener('pointerdown', () => store.apply({ [key]: Number(input.value) }));
    input.addEventListener('input', () => store.apply({ [key]: Number(input.value) }, { record: false }));
    inputs.set(key, input);
    const value = el('output', { className: 'value' });
    values.set(key, value);
    return [key, el('label', { className: 'slider' }, [el('span', { textContent: label(key) }), value, input])];
  }

  function color(key, text) {
    const input = el('input', { type: 'color', value: DEFAULTS[key] });
    input.setAttribute('aria-label', text);
    input.addEventListener('input', () => store.apply({ [key]: input.value }, { record: false }));
    input.addEventListener('change', () => store.apply({ [key]: input.value }));
    inputs.set(key, input);
    // Games that only allow palette colours get swatches instead of a free picker.
    const swatches = el('div', { className: 'swatches' });
    swatches.dataset.for = key;
    const row = el('div', {}, [el('label', { className: 'color' }, [el('span', { textContent: text }), input]), swatches]);
    return [key, row];
  }

  const keys = Object.keys(DEFAULTS);
  group('Body type', [chips('physique', spec.enums.physique)]);
  group('Hair', [
    chips('hair.style', spec.enums['hair.style']),
    ...['hair.length', 'hair.spikiness', 'hair.volume'].map(slider),
    color('hair.color', 'Hair colour'),
  ]);
  group('Face', keys.filter((k) => k.startsWith('face.')).map(slider));
  group('Body', keys.filter((k) => k.startsWith('body.')).map(slider));
  const tagsBox = el('div', { className: 'tags' });
  group('Colours and vibe', [
    color('colors.primary', 'Outfit / suit'),
    color('colors.skin', 'Skin'),
    color('colors.eyes', 'Eyes'),
    color('colors.secondary', 'Trousers and shoes'),
    [null, tagsBox],
  ]);

  /** Show only what this game uses. */
  function setProfile(p, a) {
    profile = p;
    adapted = a;
    const controls = p.controls ?? {};
    for (const [key, row] of rows) {
      // The physique still matters in games without a body slider (it feeds the mappings).
      row.hidden = key !== 'physique' && ruleFor(controls, key) === 'hidden';
      const swatches = row.querySelector?.('.swatches');
      if (!swatches) continue;
      const usePalette = ruleFor(controls, key)?.from === 'palette' && p.theme.palette?.length;
      row.querySelector('.color input').hidden = !!usePalette;
      swatches.replaceChildren(
        ...(usePalette
          ? p.theme.palette.map((c) => {
              const b = el('button', { type: 'button', className: 'swatch', title: c, onclick: () => store.apply({ [key]: c }) });
              b.style.background = c;
              b.dataset.value = c;
              return b;
            })
          : []),
      );
    }
    for (const g of groups) g.details.hidden = g.keys.length > 0 && g.keys.every((k) => rows.get(k).hidden);

    itemsTitle.textContent = `${p.name} items`;
    itemsBody.replaceChildren();
    const entries = Object.entries(p.options ?? {});
    items.hidden = !entries.length;
    for (const [name, values] of entries) {
      const buttons = values.map((v) =>
        el('button', { type: 'button', className: 'chip', textContent: pretty(v), onclick: () => onChoice(name, v) }),
      );
      buttons.forEach((b, i) => (b.dataset.value = values[i]));
      buttons.forEach((b) => (b.dataset.option = name));
      itemsBody.append(el('p', { className: 'hint', textContent: label(name) }), el('div', { className: 'chips' }, buttons));
    }
    sync(store.get());
  }

  function sync(state) {
    for (const [key, input] of inputs) {
      const v = state[key];
      if (input.type === 'range' && Number(input.value) !== v) input.value = v;
      if (input.type === 'color' && input.value !== v) input.value = v;
    }
    for (const [key, out] of values) out.textContent = Math.round(state[key] * 100);
    for (const [key, buttons] of chipSets) buttons.forEach((b) => b.classList.toggle('on', b.dataset.value === state[key]));
    // A palette swatch is "on" when it is the colour the game shows.
    root.querySelectorAll('.swatches').forEach((box) => {
      const shown = adapted?.params[box.dataset.for];
      box.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b.dataset.value === shown));
    });
    if (adapted) {
      itemsBody.querySelectorAll('.chip').forEach((b) => b.classList.toggle('on', adapted.options[b.dataset.option] === b.dataset.value));
    }
    const vibe = state.vibe ?? [];
    tagsBox.replaceChildren(
      ...(vibe.length
        ? vibe.map((t) => el('span', { className: 'tag', textContent: t }))
        : [el('span', { className: 'muted', textContent: 'Vibe tags from the copilot show here.' })]),
    );
  }

  store.subscribe(sync);

  return {
    setProfile,
    /** Called after every adapt, so swatches and item chips show what the game shows. */
    setAdapted(a) {
      adapted = a;
      sync(store.get());
    },
  };
}
