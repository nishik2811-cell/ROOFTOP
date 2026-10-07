// Layout check from 320 to 1920 px, with Rooftop running on this machine:
//   node test/layout-check.mjs        (screenshots go to test/layout-shots/)
// Needs Playwright, like the other browser checks (ROOFTOP_PLAYWRIGHT, ROOFTOP_BROWSER_CHANNEL=chrome).
// For the phone page and the PC's page at each width: nothing scrolls sideways, no two buttons overlap,
// every button is fully on screen, and the credits line is not cut off.
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const { chromium } = await import(process.env.ROOFTOP_PLAYWRIGHT || 'playwright');
const shots = join(dirname(fileURLToPath(import.meta.url)), 'layout-shots');
mkdirSync(shots, { recursive: true });
const lan = (await (await fetch('http://localhost:8080/api/connect')).json()).url;
const SIZES = [[320, 568], [360, 740], [375, 667], [390, 844], [414, 896], [768, 1024], [1024, 768], [1280, 800], [1440, 900], [1920, 1080]];
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'ok    ' : 'FAIL  ') + what); if (!ok) failures++; };

const browser = await chromium.launch({ channel: process.env.ROOFTOP_BROWSER_CHANNEL, args: ['--proxy-server=direct://', '--proxy-bypass-list=*'] });

async function open(url, width, height) {
  const mobile = width < 768;
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
  const p = await ctx.newPage();
  await p.goto(url);
  const enter = p.locator('#introEnter');
  await enter.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  if (await enter.isVisible()) await enter.press('Enter'); // slide-to-enter: the keyboard enters at once
  const gate = p.locator('#nameGateInput');
  if (await gate.isVisible({ timeout: 4000 }).catch(() => false)) { await gate.fill('Layout check'); await gate.press('Enter'); }
  await p.waitForTimeout(2500); // arrival animation
  return { p, ctx };
}

// Everything a person can tap that is showing right now, with its box.
const measure = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden], dialog:not([open])') && +s.opacity > 0.05;
  };
  const controls = [...document.querySelectorAll('button, a.pill, label.pill, select, .round')]
    .filter((el) => vis(el) && !el.closest('.remove-layer') && el.closest('.bar, .bar-top, .bar-bottom'))
    .map((el) => { const r = el.getBoundingClientRect(); return { id: el.id || el.className || el.tagName, x0: r.left, y0: r.top, x1: r.right, y1: r.bottom, el }; });
  const overlaps = [];
  for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
    const a = controls[i], b = controls[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
    if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 1) overlaps.push(`${a.id} / ${b.id}`);
  }
  const offscreen = controls.filter((c) => c.x0 < -1 || c.x1 > innerWidth + 1 || c.y0 < -1 || c.y1 > innerHeight + 1).map((c) => c.id);
  const credits = document.querySelector('.credits');
  const cr = credits && vis(credits) ? credits.getBoundingClientRect() : null;
  return {
    sideways: document.documentElement.scrollWidth - innerWidth,
    overlaps, offscreen, controls: controls.length,
    creditsCut: cr ? cr.bottom > innerHeight + 1 || cr.right > innerWidth + 1 : null,
  };
};

for (const [w, h] of SIZES) {
  for (const [label, url] of [['phone page', lan], ["PC's page", 'http://localhost:8080/']]) {
    const { p, ctx } = await open(url, w, h);
    const m = await p.evaluate(measure);
    await p.screenshot({ path: join(shots, `${label === 'phone page' ? 'phone' : 'pc'}-${w}x${h}.png`) });
    const problems = [];
    if (m.sideways > 1) problems.push(`scrolls sideways by ${m.sideways}px`);
    if (m.overlaps.length) problems.push('overlapping: ' + m.overlaps.join(', '));
    if (m.offscreen.length) problems.push('off screen: ' + m.offscreen.join(', '));
    if (m.creditsCut && label === 'phone page') problems.push('credits cut off');
    check(!problems.length, `${String(w).padStart(4)}x${h} ${label}: ${problems.length ? problems.join('; ') : `${m.controls} buttons, none overlap, all on screen`}`);
    await ctx.close();
  }
}
// the opening screen's slider: a short drag springs back, a full drag enters the city
for (const [w, h] of [[390, 844], [1440, 900]]) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  await p.goto(lan);
  const knob = p.locator('#introEnter');
  await knob.waitFor({ state: 'visible', timeout: 15000 });
  await p.locator('#intro.s3').waitFor({ timeout: 15000 });
  await p.waitForTimeout(1600); // let it finish sliding in
  const track = await p.locator('#introSlider').boundingBox(), k = await knob.boundingBox();
  const cy = k.y + k.height / 2, cx = k.x + k.width / 2;
  await p.mouse.move(cx, cy); await p.mouse.down(); await p.mouse.move(cx + track.width * 0.3, cy, { steps: 8 }); await p.mouse.up();
  await p.waitForTimeout(700);
  const back = (await knob.boundingBox()).x - k.x;
  const stillIntro = await p.evaluate(() => document.body.classList.contains('intro-on'));
  await p.mouse.move(cx, cy); await p.mouse.down(); await p.mouse.move(track.x + track.width - 10, cy, { steps: 12 }); await p.mouse.up();
  await p.waitForTimeout(1500);
  const entered = !(await p.evaluate(() => document.body.classList.contains('intro-on')));
  check(Math.abs(back) < 3 && stillIntro && entered, `${w}x${h} slider: a short drag springs back (${Math.round(back)}px), a full drag enters the city`);
  await ctx.close();
}
await browser.close();
console.log(failures ? `\n${failures} layout problem(s)` : '\nall layout checks passed');
process.exit(failures ? 1 : 0);
