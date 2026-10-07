// End-to-end encrypted chat in real browsers, against a running Rooftop on this machine:
//   ROOFTOP_LOG=<file the terminal output goes to> node test/chat-browser.mjs
// Needs Playwright (npm i -D playwright, or ROOFTOP_PLAYWRIGHT=<path to playwright's index.mjs>).
// A is this PC's own page; B, C and D are phones.
//   1. B writes to Everyone: A, C and D read it (C through the bubble in the city, D through its unread count),
//      and A's page puts it on the PC's clipboard.
//   2. B writes to C in person: C reads it; A's page, state, history and log, and D, see nothing of it.
//   3. B makes a group with C: C sees the group and its messages and who is typing; D and A never see it or its name.
//   4. C leaves: B's next message no longer reaches C.
//   5. A message whose sender key was swapped is detected and thrown away.
import { readFileSync } from 'fs';

const { chromium } = await import(process.env.ROOFTOP_PLAYWRIGHT || 'playwright');
const logFile = process.env.ROOFTOP_LOG;
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'ok    ' : 'FAIL  ') + what); if (!ok) failures++; };
const lan = (await (await fetch('http://localhost:8080/api/connect')).json()).url;
const stamp = Date.now().toString(36);

const browser = await chromium.launch({ args: ['--proxy-server=direct://', '--proxy-bypass-list=*'] });
const errors = [];
async function page(url, name, mobile = true) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 860 } });
  if (!name) await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://localhost:8080' });
  await ctx.addInitScript((n) => {
    if (n) localStorage.setItem('rooftop-name', n);
    const m = window.matchMedia.bind(window); // no intro animation
    window.matchMedia = (q) => (q.includes('reduced-motion') ? { matches: true, addEventListener() {}, addListener() {} } : m(q));
  }, name);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name || 'A'}: ${e.message}`));
  await p.goto(url);
  if (!name) await p.locator('#nameGate').waitFor({ state: 'visible', timeout: 4000 }).then(() => p.click('#nameGateSkip')).catch(() => {});
  return p;
}
const A = await page('http://localhost:8080/', '', false);
const B = await page(lan, 'Phone B'), C = await page(lan, 'Phone C'), D = await page(lan, 'Phone D');
const everyoneHasKeys = () => fetch('http://localhost:8080/api/state').then((r) => r.json())
  .then((s) => ['Phone B', 'Phone C', 'Phone D'].every((n) => s.devices.some((d) => d.name === n && d.key)) && !!s.youKey);
for (let i = 0; i < 40 && !(await everyoneHasKeys()); i++) await A.waitForTimeout(500);
await B.waitForTimeout(3500); // everyone has seen everyone's key

const isOpen = (p) => p.evaluate(() => document.querySelector('#sheet-notes').open);
async function openList(p) {
  if (!(await isOpen(p))) await p.click('#chatBtn');
  if (await p.locator('#threadBack').isVisible()) await p.click('#threadBack');
}
const row = (p, name) => p.locator('#convList .conv').filter({ has: p.locator('.conv-name', { hasText: name }) }).first();
async function openConv(p, name) {
  await openList(p);
  await row(p, name).click();
  await p.locator('#threadTitle', { hasText: name }).waitFor({ timeout: 10000 });
}
async function say(p, text) {
  await p.fill('#note', text);
  await p.press('#note', 'Enter');
  await p.locator('#textList .bubble', { hasText: text }).waitFor({ timeout: 10000 });
}
const waitFor = (p, text, timeout = 12000) => p.locator('#textList .bubble', { hasText: text }).waitFor({ timeout });
const knows = (p, text) => p.evaluate((t) => JSON.stringify([...convs.values()].map((c) => [c.name, c.msgs.map((m) => m.text)])).includes(t) || document.body.innerText.includes(t), text);
async function close(p) { if (await isOpen(p)) await p.keyboard.press('Escape'); }

// 1. Everyone
const hello = `hello room ${stamp}`;
await openConv(B, 'Everyone');
await say(B, hello);
await C.locator('#cityBubble').waitFor({ state: 'visible', timeout: 12000 });
const bubble = await C.locator('#cityBubble').innerText();
const dot = await C.locator('#chatDot').innerText();
check(bubble.includes('Phone B') && bubble.includes('hello room') && dot === '1', `C gets a bubble in the city ("${bubble.replace(/\n/g, ' ')}") and an unread count of ${dot}`);
await C.click('#cityBubble');
await C.locator('#threadTitle', { hasText: 'Everyone' }).waitFor({ timeout: 5000 });
check(await C.locator(`#textList .msg.flash .bubble`, { hasText: hello }).count() === 1, 'tapping the bubble opens Everyone at that message');
await openList(D);
await row(D, 'Everyone').locator('.badge-n', { hasText: '1' }).waitFor({ timeout: 12000 });
check(true, 'D sees an unread count of 1 next to Everyone in the switcher');
await openConv(D, 'Everyone');
await waitFor(D, hello);
check(true, 'D reads it');
await openConv(A, 'Everyone');
await waitFor(A, hello);
check(true, "A (the PC's own page) reads it");
const clip = await A.evaluate(() => navigator.clipboard.readText().catch(() => pendingClip));
check(clip === hello, "A's page put it on the PC's clipboard (decrypted in the page, never by Java)");
const who = await D.locator('#textList .msg.first', { hasText: hello }).locator('.msg-who').innerText();
check(who.startsWith('Phone B') && /verified/.test(who), `the sender's name and key status sit above the message: "${who}"`);
await close(A); await close(C); await close(D);

// 2. B -> C in person
const secret = `just for C ${stamp} https://example.com/plan`;
await openList(B);
await row(B, 'Phone C').click();
await B.locator('#threadTitle', { hasText: 'Phone C' }).waitFor();
await say(B, secret);
await C.locator('#cityBubble').waitFor({ state: 'visible', timeout: 12000 });
await openConv(C, 'Phone B');
await waitFor(C, secret);
const link = await C.locator('#textList .bubble a').last().getAttribute('href');
check(link === 'https://example.com/plan', 'C reads it, with the link clickable');
await A.waitForTimeout(3500);
const aState = JSON.stringify(await A.evaluate(async () => (await fetch('/api/state')).json()));
const aHistory = JSON.stringify(await A.evaluate(async () => (await fetch('/api/history')).json()));
check(!(await knows(A, 'just for C')) && !aState.includes('just for C') && !aHistory.includes('just for C'), "A's page, state and history know nothing of it");
if (logFile) check(!readFileSync(logFile, 'utf8').includes(stamp), 'the terminal / activity log never shows any chat text');
await openList(D);
check(!(await knows(D, 'just for C')) && !(await D.locator('#convList .conv-last', { hasText: 'just for' }).count()), 'D sees nothing of it');

// 3. a group with C only
const group = `Crew ${stamp}`;
await openList(B);
await B.click('#newGroupBtn');
await B.fill('#groupName', group);
await B.locator('#groupPeople label', { hasText: 'Phone C' }).locator('input').check();
await B.click('#groupForm button[type=submit]');
await B.locator('#threadTitle', { hasText: group }).waitFor({ timeout: 10000 });
await say(B, `group hello ${stamp}`);
await openList(C);
await row(C, group).waitFor({ timeout: 12000 });
await openConv(C, group);
await waitFor(C, `group hello ${stamp}`);
check(true, 'C sees the group and its message');
await B.fill('#note', 'typing something');
await B.dispatchEvent('#note', 'input');
await C.locator('#typingLine', { hasText: 'Phone B is typing' }).waitFor({ timeout: 10000 });
check(true, 'C sees "Phone B is typing…" in the group');
await B.fill('#note', '');
await D.waitForTimeout(3500);
check(!(await knows(D, group)) && !(await knows(D, 'group hello')), 'D never sees the group, its name or its messages');
check(!(await knows(A, group)) && !(await knows(A, 'group hello')), "A's page never sees the group, its name or its messages");

// 4. C leaves; B's next message does not reach C
await C.click('#leaveGroup');
await B.locator('#textList .msg-system', { hasText: 'Phone C left' }).waitFor({ timeout: 12000 });
check(true, 'B sees "Phone C left"');
await say(B, `after leaving ${stamp}`);
await C.waitForTimeout(4000);
check(!(await knows(C, 'after leaving')), 'after leaving, C no longer gets the group\'s messages');

// 5. a forged message: D seals it, then puts B's public key in as the sender's
const forged = await D.evaluate(async (stampText) => {
  const c = state.devices.find((d) => d.name === 'Phone C'), b = state.devices.find((d) => d.name === 'Phone B');
  const bytes = await E2E.sealMessage({ k: 'msg', c: 'all', t: 'forged ' + stampText }, [E2E.unb64(c.key)], myPair);
  bytes.set(E2E.unb64(b.key), 4 + 7);
  await call('/api/chat/send?to=' + encodeURIComponent(c.id), { method: 'POST', body: bytes });
  return true;
}, stamp);
await openConv(C, 'Everyone');
await C.locator('#textList .msg-system.warn').waitFor({ timeout: 12000 });
check(forged && !(await knows(C, 'forged ' + stamp)), 'C detects the swapped sender key, shows a warning and drops the message');
check(errors.length === 0, 'no page errors ' + JSON.stringify(errors));

await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall chat checks passed');
process.exit(failures ? 1 : 0);
