// The "What's your name?" screen, in real browsers, against a running Rooftop on this machine:
//   node test/names-browser.mjs
// Needs Playwright (npm i -D playwright, or ROOFTOP_PLAYWRIGHT=<path to playwright's index.mjs>). Best run against
// a Rooftop that has not been named yet (a fresh user home), so the PC's own page asks too.
//   1. a new phone sees the screen right after "Enter the city" and picks a name
//   2. the PC and a second phone show that name, with initials, in the chat and in Send to
//   3. a name someone already has gets a warning and a suggestion instead of a silent rename
//   4. after a reload the screen does not come back
const { chromium } = await import(process.env.ROOFTOP_PLAYWRIGHT || 'playwright');
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'ok    ' : 'FAIL  ') + what); if (!ok) failures++; };
const lan = (await (await fetch('http://localhost:8080/api/connect')).json()).url;
const pcNamedBefore = (await (await fetch('http://localhost:8080/api/state')).json()).meNamed;

const browser = await chromium.launch({ args: ['--proxy-server=direct://', '--proxy-bypass-list=*'] });
const errors = [];
async function page(url, label, { intro = false, mobile = true } = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 860 } });
  if (!intro) await ctx.addInitScript(() => { const m = window.matchMedia.bind(window); window.matchMedia = (q) => (q.includes('reduced-motion') ? { matches: true, addEventListener() {}, addListener() {} } : m(q)); });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  await p.goto(url);
  return p;
}
const gate = (p) => p.locator('#nameGate');
const sendToTexts = (p) => p.$$eval('#sendTo option', (o) => o.map((x) => x.textContent));

// the PC's own page asks for the PC's name the first time
const A = await page('http://localhost:8080/', 'A', { mobile: false });
if (!pcNamedBefore) {
  await gate(A).waitFor({ state: 'visible', timeout: 10000 });
  check((await A.textContent('#nameGateTitle')).includes('this PC') && (await A.inputValue('#nameGateInput')).length > 0,
    'the PC\'s own page asks for its name, prefilled with the computer\'s name');
  await A.fill('#nameGateInput', 'Lab PC');
  await A.press('#nameGateInput', 'Enter');
  await gate(A).waitFor({ state: 'hidden' });
  check((await (await fetch('http://localhost:8080/api/state')).json()).me === 'Lab PC', 'Enter saves it through the PC rename');
} else {
  console.log('      (this PC was already named, so its page does not ask; run against a fresh home to check that too)');
}
const pcName = (await (await fetch('http://localhost:8080/api/state')).json()).me;

// 1. a new phone: intro, then the name screen
const P1 = await page(lan, 'P1', { intro: true });
await P1.click('#introEnter', { timeout: 15000 });
await gate(P1).waitFor({ state: 'visible', timeout: 10000 });
const focused = await P1.evaluate(() => document.activeElement?.id);
const fontSize = await P1.$eval('#nameGateInput', (i) => getComputedStyle(i).fontSize);
const placeholder = await P1.getAttribute('#nameGateInput', 'placeholder');
check(focused === 'nameGateInput' && fontSize === '16px' && /Asha's/.test(placeholder),
  `after "Enter the city" a new phone sees the name screen (field focused, 16px text, suggestion "${placeholder}")`);
await P1.fill('#nameGateInput', 'Asha');
await P1.click('#nameGateForm button[type=submit]');
await gate(P1).waitFor({ state: 'hidden' });
check(true, 'Join saves the name');

// 3. a second phone tries the same name
const P2 = await page(lan, 'P2');
await gate(P2).waitFor({ state: 'visible', timeout: 10000 });
await P2.waitForTimeout(3500); // a poll, so P2 knows who is here
await P2.fill('#nameGateInput', 'asha');
await P2.press('#nameGateInput', 'Enter');
const warning = await P2.textContent('#nameGateError');
check(/Someone here is already called Asha/.test(warning) && /Use asha 2/.test(warning) && await gate(P2).isVisible(),
  `a duplicate name gets a warning and a suggestion: "${warning}"`);
await P2.click('.namegate-use');
check(await P2.inputValue('#nameGateInput') === 'asha 2', 'the suggestion fills in "asha 2"');
await P2.press('#nameGateInput', 'Enter');
await gate(P2).waitFor({ state: 'hidden' });
check(true, 'and the second phone joins as "asha 2"');

// 2. Asha says hello; the PC and the second phone see her name and initials
await P1.click('#chatBtn');
await P1.fill('#note', 'hello from Asha');
await P1.press('#note', 'Enter');
await P1.click('#noteForm button[type=submit]').catch(() => {}); // phones keep Enter for new lines
await A.waitForTimeout(3500);
await P2.waitForTimeout(500);
await P2.click('#chatBtn');
await P2.waitForSelector('#textList .msg .msg-who', { timeout: 10000 });
const seenOnP2 = await P2.$$eval('#textList .msg.first', (m) => m.map((x) => [x.querySelector('.avatar')?.textContent, x.querySelector('.msg-who')?.textContent, x.querySelector('.bubble')?.textContent]));
check(seenOnP2.some(([a, who, text]) => a === 'AS' && who === 'Asha' && text === 'hello from Asha'), 'the second phone sees "Asha" with her initials above her message: ' + JSON.stringify(seenOnP2));
const seenOnA = await A.$$eval('#hostMessages li', (m) => m.map((x) => [x.querySelector('.avatar')?.textContent, x.querySelector('.meta')?.textContent]));
check(seenOnA.some(([a, meta]) => a === 'AS' && meta.startsWith('Asha')), 'the PC sees her message with her initials and name');
check((await sendToTexts(A)).some((t) => t.startsWith('AS · Asha')), "the PC's Send to lists \"AS · Asha\"");
check((await sendToTexts(P2)).some((t) => t.startsWith('AS · Asha')) && (await sendToTexts(P2)).some((t) => t.includes(pcName)), 'the second phone\'s Send to lists Asha and the PC');
const color1 = await P2.$eval('#textList .msg.first .avatar', (a) => a.style.background);
await P2.keyboard.press('Escape');
await P2.click('[data-sheet="nearby"]');
const colorNearby = await P2.$$eval('#deviceList li', (l) => l.filter((x) => x.textContent.includes('Asha')).map((x) => x.querySelector('.avatar').style.background)[0]);
check(color1 && color1 === colorNearby, 'her avatar has the same colour in the chat and in Nearby');
await P2.click('#youName');
check(await P2.evaluate(() => document.activeElement?.id) === 'myName', 'tapping "You are ..." opens the name field');
await P2.keyboard.press('Escape');

// 4. reloads do not ask again
await P1.reload();
await P1.click('#introEnter', { timeout: 15000 });
await P1.waitForTimeout(3000);
check(!(await gate(P1).isVisible()), 'after a reload the phone is not asked again');
await A.reload();
await A.waitForTimeout(3000);
check(!(await gate(A).isVisible()), 'after a reload the PC\'s page is not asked again');
check(errors.length === 0, 'no page errors ' + JSON.stringify(errors));

await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall name screen checks passed');
process.exit(failures ? 1 : 0);
