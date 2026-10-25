import { describe, expect, it } from 'vitest';
import { adapt, nearestColor } from '../src/adapter/adapt.js';
import { DEFAULTS } from '../src/avatar/spec.js';
import bean from '../../profiles/among-us-style.json';
import anime from '../../profiles/anime-rpg.json';
import retro from '../../profiles/retro-shooter.json';

const avatar = (patch = {}) => ({ ...DEFAULTS, ...patch });

describe('nearestColor', () => {
  it('snaps to the closest palette colour', () => {
    expect(nearestColor('#d01010', ['#c51111', '#132ed1', '#117f2d'])).toBe('#c51111');
    expect(nearestColor('#0000ff', ['#c51111', '#132ed1', '#117f2d'])).toBe('#132ed1');
  });
});

describe('among-us-style profile', () => {
  it('hides face and hair controls', () => {
    const r = adapt(avatar(), bean);
    expect(Object.keys(r.params).some((k) => k.startsWith('face.') || k.startsWith('hair.'))).toBe(false);
    expect(r.hidden).toContain('face.jawSharpness');
    expect(r.hidden).toContain('hair.style');
  });

  it('turns spiky hair into a spiky hat, with a note', () => {
    const r = adapt(avatar({ 'hair.style': 'spiky' }), bean);
    expect(r.options.hat).toBe('spiky-hat');
    expect(r.notes.join(' ')).toMatch(/spiky hat/);
  });

  it('rescales height into its narrow range', () => {
    expect(adapt(avatar({ 'body.height': 0 }), bean).params['body.height']).toBeCloseTo(0.4);
    expect(adapt(avatar({ 'body.height': 1 }), bean).params['body.height']).toBeCloseTo(0.6);
  });

  it('snaps the primary colour to the palette', () => {
    const r = adapt(avatar({ 'colors.primary': '#d01010' }), bean);
    expect(r.params['colors.primary']).toBe('#c51111');
    // A barely visible shift is not worth a note.
    expect(r.notes.join(' ')).not.toMatch(/palette/);
  });

  it('says so when the colour visibly changes', () => {
    const r = adapt(avatar({ 'colors.primary': '#8a8a2a' }), bean);
    expect(r.notes.join(' ')).toMatch(/palette/);
  });

  it('lets the player override a mapping', () => {
    const r = adapt(avatar({ 'hair.style': 'spiky' }), bean, { hat: 'crown' });
    expect(r.options.hat).toBe('crown');
  });

  it('ignores choices the game does not have', () => {
    expect(adapt(avatar(), bean, { hat: 'sombrero' }).options.hat).toBe('none');
  });

  it('matches vibe tags', () => {
    const r = adapt(avatar({ vibe: ['cyberpunk'] }), bean);
    expect(r.options.visor).toBe('cyan');
    expect(r.options.pet).toBe('robot');
  });
});

describe('anime-rpg profile', () => {
  it('keeps every slider and adds its proportion offsets', () => {
    const r = adapt(avatar(), anime);
    expect(r.hidden).toEqual([]);
    expect(r.params['face.eyeSize']).toBeCloseTo(0.8);
    expect(r.params['face.jawSharpness']).toBe(0.5);
  });

  it('clamps offsets at the slider limits', () => {
    expect(adapt(avatar({ 'face.eyeSize': 0.9 }), anime).params['face.eyeSize']).toBe(1);
  });

  it('keeps colours exact (no palette)', () => {
    expect(adapt(avatar({ 'hair.color': '#123456' }), anime).params['hair.color']).toBe('#123456');
  });
});

describe('retro-shooter profile', () => {
  it('snaps every colour to its 16-colour palette', () => {
    const r = adapt(avatar(), retro);
    for (const k of ['hair.color', 'colors.skin', 'colors.primary', 'colors.secondary', 'colors.eyes']) {
      expect(retro.theme.palette).toContain(r.params[k]);
    }
  });

  it('hides only the listed fine face sliders', () => {
    const r = adapt(avatar(), retro);
    expect(r.hidden).toContain('face.lipFullness');
    expect(r.params['face.jawSharpness']).toBe(0.5);
  });

  it('maps a muscular physique to heavy armor', () => {
    expect(adapt(avatar({ physique: 'muscular' }), retro).options.armor).toBe('heavy');
  });
});

describe('palette snapping looks right to people', () => {
  it('snaps a warm skin tone to a warm colour, not grey-purple', () => {
    expect(nearestColor('#c68e6a', retro.theme.palette)).not.toBe('#83769c');
    expect(['#ffccaa', '#ab5236']).toContain(nearestColor('#c68e6a', retro.theme.palette));
  });
});
