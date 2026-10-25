import { describe, expect, it } from 'vitest';
import { DEFAULTS, kindOf, physiques, spec } from '../src/avatar/spec.js';

const profiles = import.meta.glob('../../profiles/*.json', { eager: true, import: 'default' });

describe('physique presets', () => {
  it('only set known body sliders', () => {
    for (const [name, p] of Object.entries(physiques)) {
      expect(spec.enums.physique).toContain(name);
      for (const [k, v] of Object.entries(p)) {
        expect(k.startsWith('body.') && kindOf(k) === 'slider', `${name}: ${k}`).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe.each(Object.entries(profiles))('%s', (_file, p) => {
  const groups = new Set(Object.keys(DEFAULTS).map((k) => k.split('.')[0]));

  it('has the required fields', () => {
    for (const f of ['id', 'name', 'figure', 'theme', 'controls', 'options', 'mappings']) expect(p).toHaveProperty(f);
    expect(['human', 'bean']).toContain(p.figure);
    expect(['flat', 'toon', 'pbr']).toContain(p.theme.shader);
  });

  it('only controls known avatar keys or groups', () => {
    for (const k of Object.keys(p.controls)) expect(k in DEFAULTS || groups.has(k), k).toBe(true);
  });

  it('has valid palette colours', () => {
    for (const c of p.theme.palette) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('has mappings that use known keys and existing options', () => {
    for (const m of p.mappings) {
      for (const k of Object.keys(m.when)) expect(k in DEFAULTS, k).toBe(true);
      for (const [k, v] of Object.entries(m.set)) {
        if (k in p.options) expect(p.options[k], `${k}=${v}`).toContain(v);
        else expect(k in DEFAULTS, k).toBe(true);
      }
    }
  });
});
