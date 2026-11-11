// Five independent devices: selected recipients, concurrent uploads, batch notice, bulk save, history and isolation.
// Run against a local Rooftop host; does not end its session.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { chromium } = await import(process.env.ROOFTOP_PLAYWRIGHT || 'playwright');
const { url } = await (await fetch('http://localhost:8080/api/connect')).json();
const browser = await chromium.launch({ channel: process.env.ROOFTOP_BROWSER_CHANNEL, args: ['--proxy-server=direct://', '--proxy-bypass-list=*'] });
const errors = [];
const stamp = Date.now();
try {
  const pages = [];
  for (let i = 0; i < 5; i++) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true, viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript((name) => {
      localStorage.setItem('rooftop-name', name);
      const media = window.matchMedia.bind(window);
      window.matchMedia = (q) => q.includes('reduced-motion') ? { matches: true, addEventListener() {} } : media(q);
    }, `Batch ${stamp} ${i}`);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(url);
    await p.waitForFunction(() => myPair && state.youId);
    pages.push(p);
  }
  const [sender, a, b, excluded, extra] = pages;
  const ids = await Promise.all(pages.map((p) => p.evaluate(() => state.youId)));
  await sender.waitForFunction((ids) => ids.every((id) => [...document.querySelectorAll('#sendTo option')].some((o) => o.value === id && !o.disabled)), ids.slice(1));
  await sender.click('#sendToBtn');
  for (const id of ids.slice(1, 4)) await sender.locator(`#sendToList [data-id="${id}"]`).click();
  assert.equal(await sender.locator('#sendToName').textContent(), '3 people');
  await sender.locator(`#sendToList [data-id="${ids[3]}"]`).click();
  assert.equal(await sender.locator('#sendToName').textContent(), '2 people');
  await sender.keyboard.press('Escape');
  const files = Array.from({ length: 4 }, (_, i) => ({ name: `batch-${stamp}-${i}.bin`, mimeType: 'application/octet-stream', buffer: Buffer.alloc(200000, i + 1) }));
  let release;
  const gate = new Promise((r) => { release = r; });
  let active = 0;
  await sender.route('**/api/sealed/upload?*', async (route) => { active++; await gate; await route.continue(); });
  await sender.setInputFiles('#picker', files);
  await a.waitForFunction(() => [...incomingTransfers.values()].some((t) => t.count === 4));
  const deadline = Date.now() + 15000;
  while (active < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(active, 3, 'three uploads in flight before any completes');
  assert.equal(await a.evaluate(() => localFiles.length), 0, 'batch count arrives before the files');
  release();
  console.log('ok  selected two of four peers; batch announced before three parallel uploads');
  for (const p of [a, b]) {
    await p.waitForFunction(() => localFiles.length === 4 && [...incomingTransfers.values()].some((t) => t.received === 4), null, { timeout: 30000 });
    assert.ok(await p.evaluate(() => localFiles.every((f) => f.forYou && f.url.startsWith('blob:'))));
    await p.waitForFunction(() => city.murals().filter((m) => m.file.forYou).length === 4);
    await p.click('#incomingStatus');
    const downloads = [];
    p.on('download', (d) => downloads.push(d));
    await p.locator('#fileFilter').fill(`batch-${stamp}-`);
    await p.click('#downloadAll');
    await p.waitForFunction(() => localFiles.every((f) => f.acked));
    const until = Date.now() + 10000;
    while (downloads.length < 4 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    assert.equal(downloads.length, 4, 'one action requests every download');
    for (const d of downloads) assert.deepEqual(readFileSync(await d.path()), files.find((f) => f.name === d.suggestedFilename()).buffer);
    await p.click('#tabHistory');
    await p.waitForFunction((stamp) => [...document.querySelectorAll('#historyList li')].filter((li) => li.textContent.includes(`batch-${stamp}-`)).length === 4, stamp);
    await p.keyboard.press('Escape');
  }
  console.log('ok  both recipients saved all four exact files, with private city banners and history');
  for (const p of [excluded, extra]) {
    assert.equal(await p.evaluate(() => localFiles.length + incomingTransfers.size + browserHistory.length), 0);
    assert.equal(await p.evaluate(async () => (await (await call('/api/state')).json()).sealed.length), 0);
  }
  await sender.evaluate(() => { showTab('history'); openSheet('inbox'); });
  await sender.waitForFunction((stamp) => [...document.querySelectorAll('#historyList li')].filter((li) => li.textContent.includes(`batch-${stamp}-`)).length === 4, stamp);
  console.log('ok  sender history survives tray cleanup; excluded peers get no files or batch metadata');
  await a.setViewportSize({ width: 390, height: 844 });
  await a.evaluate(() => popBubble(conv('all'), { from: state.meId, text: 'A compact notification', id: 'preview' }));
  await a.screenshot({ path: '/tmp/rooftop-batch-mobile.png' });
  const fits = await a.locator('#cityBubble').evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top < 150; });
  assert.ok(fits, 'chat notification stays near controls and within mobile viewport');
  const host = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  host.on('pageerror', (e) => errors.push(e.message));
  await host.goto('http://localhost:8080/');
  if (await host.locator('#introEnter').isVisible()) await host.locator('#introEnter').press('Enter');
  if (await host.locator('#nameGateSkip').isVisible()) await host.locator('#nameGateSkip').click();
  await host.waitForFunction(() => document.querySelector('#hostMore .key-list li'));
  const cards = await host.evaluate(() => {
    const [chat, keys, notifications] = document.querySelectorAll('#hostMore .host-card');
    const before = [chat.offsetHeight, notifications.offsetHeight];
    const list = keys.querySelector('.key-list');
    for (let i = 0; i < 25; i++) list.append(list.firstElementChild.cloneNode(true));
    return { before, after: [chat.offsetHeight, notifications.offsetHeight], scrolls: list.scrollHeight > list.clientHeight,
      gap: chat.querySelector('p').getBoundingClientRect().top - chat.querySelector('h2').getBoundingClientRect().bottom };
  });
  assert.deepEqual(cards.after, cards.before, 'more devices do not stretch chat or notifications');
  assert.ok(cards.scrolls && cards.gap <= 20, 'key rows scroll and chat content stays together');
  await host.locator('#hostMore').screenshot({ path: '/tmp/rooftop-host-cards.png' });
  console.log('ok  long device lists scroll without stretching chat or notification cards');
  assert.deepEqual(errors, []);
  console.log('all batch browser checks passed');
} finally {
  await browser.close();
}
