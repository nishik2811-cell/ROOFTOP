import { describe, expect, it } from 'vitest';
import { createStore } from '../src/avatar/store.js';
import { sanitizePatch } from '../src/avatar/spec.js';

describe('sanitizePatch', () => {
  it('clamps sliders and drops bad values and unknown keys', () => {
    expect(
      sanitizePatch({
        'face.jawSharpness': 1.7,
        'face.eyeSize': -1,
        'face.madeUp': 0.3,
        'hair.style': 'mohawk',
        'hair.color': 'red',
        'colors.primary': '#AABBCC',
        vibe: ['Cyberpunk', 'cyberpunk', 3, ' cute '],
      }),
    ).toEqual({ 'face.jawSharpness': 1, 'face.eyeSize': 0, 'colors.primary': '#aabbcc', vibe: ['cyberpunk', 'cute'] });
  });
});

describe('store', () => {
  it('applies a physique preset to the body sliders', () => {
    const s = createStore();
    s.apply({ physique: 'muscular' });
    expect(s.get()['body.muscle']).toBe(0.9);
    expect(s.get().physique).toBe('muscular');
  });

  it('switches to custom when a body slider is moved by hand', () => {
    const s = createStore();
    s.apply({ physique: 'slim' });
    s.apply({ 'body.muscle': 0.7 });
    expect(s.get().physique).toBe('custom');
  });

  it('keeps explicit body values that come with a preset', () => {
    const s = createStore();
    s.apply({ physique: 'athletic', 'body.height': 0.9 });
    expect(s.get()['body.height']).toBe(0.9);
    expect(s.get().physique).toBe('athletic');
  });

  it('undoes the last change', () => {
    const s = createStore();
    s.apply({ 'face.jawSharpness': 0.9 });
    s.undo();
    expect(s.get()['face.jawSharpness']).toBe(0.5);
  });

  it('notifies subscribers', () => {
    const s = createStore();
    let calls = 0;
    s.subscribe(() => calls++);
    s.apply({ 'hair.style': 'spiky' });
    s.apply({ 'hair.style': 'nonsense' });
    expect(calls).toBe(1);
  });
});
