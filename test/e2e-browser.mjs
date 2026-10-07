// End-to-end check in real browsers, against a running Rooftop on this machine:
//   ROOFTOP_LOG=<file the terminal output goes to> node test/e2e-browser.mjs
// Needs Playwright (npm i -D playwright, or ROOFTOP_PLAYWRIGHT=<path to playwright's index.mjs>).
// Three pages: A is this PC's own page (localhost), B and C are phones reaching it over the Wi-Fi address.
//   1. B sends a file to C: C decrypts it byte for byte; while it waits, the PC holds only ciphertext without the
//      name; afterwards nothing is left; and A's page, inbox, history and log never mention it.
//   2. B sends a file to Everyone: C and A each decrypt their own copy, then nothing is left on the PC.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { userInfo, tmpdir, platform, homedir } from 'os';
import { randomBytes } from 'crypto';

const { chromium } = await import(process.env.ROOFTOP_PLAYWRIGHT || 'playwright');
const sealedDir = process.env.ROOFTOP_SEALED_DIR || join(platform() === 'linux' ? '/tmp' : tmpdir(), 'rooftop-sealed-' + userInfo().username);
const inboxDir = process.env.ROOFTOP_INBOX || join(homedir(), 'Rooftop');
const logFile = process.env.ROOFTOP_LOG;
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'ok    ' : 'FAIL  ') + what); if (!ok) failures++; };
const sealedFiles = () => (existsSync(sealedDir) ? readdirSync(sealedDir) : []);

const connect = await (await fetch('http://localhost:8080/api/connect')).json();
const lan = connect.url; // the phone link, PIN included
const work = mkdtempSync(join(tmpdir(), 'rooftop-e2e-'));
const stamp = Date.now();
const marker = 'ROOFTOP PLAINTEXT MARKER, the PC must never see this line. ';
const secretName = `b-to-c-secret-${stamp}.txt`;
const secret = Buffer.from(marker.repeat(50000)); // about 3 MB
writeFileSync(join(work, secretName), secret);
const allName = `b-to-everyone-${stamp}.bin`;
const forAll = randomBytes(2 * 1024 * 1024 + 123);
writeFileSync(join(work, allName), forAll);

const browser = await chromium.launch({ args: ['--proxy-server=direct://', '--proxy-bypass-list=*'] });
const errors = [];
async function page(url, name, noCrypto = false) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true, viewport: { width: 1280, height: 860 } });
  if (noCrypto) await ctx.addInitScript(() => Object.defineProperty(Crypto.prototype, 'subtle', { get: () => undefined }));
  await ctx.addInitScript((n) => {
    if (n) localStorage.setItem('rooftop-name', n);
    const m = window.matchMedia.bind(window); // no intro animation
    window.matchMedia = (q) => (q.includes('reduced-motion') ? { matches: true, addEventListener() {}, addListener() {} } : m(q));
  }, name);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${name || 'A'}: ${e.message}`));
  await p.goto(url);
  if (!name) { // this PC's page asks for the PC's name the first time; leave the name as it is
    await p.locator('#nameGate').waitFor({ state: 'visible', timeout: 4000 }).then(() => p.click('#nameGateSkip')).catch(() => {});
  }
  return p;
}
const A = await page('http://localhost:8080/', '');
const B = await page(lan, 'Phone B');
const C = await page(lan, 'Phone C');
const state = (p) => p.evaluate(async () => (await fetch(withPin('/api/state'))).json());
await B.waitForFunction(() => [...document.querySelectorAll('#sendTo option')].some((o) => o.textContent.includes('Phone C') && !o.disabled), null, { timeout: 20000 });
await B.waitForFunction(() => [...document.querySelectorAll('#sendTo option')].some((o) => o.textContent.includes('(PC)') && !o.disabled), null, { timeout: 20000 });
check(true, 'B lists Phone C and the PC as recipients with keys');

async function receiveOnPhone(p, expectName) {
  await p.waitForSelector('#sealedCard:not([hidden])', { timeout: 20000 });
  await p.click('#sealedOpen');
  await p.waitForSelector('#sealedSave:not([hidden])', { timeout: 30000 });
  const [download] = await Promise.all([p.waitForEvent('download'), p.click('#sealedSave')]);
  const body = readFileSync(await download.path());
  await p.waitForSelector('#sealedCard', { state: 'hidden', timeout: 10000 });
  return { body, name: download.suggestedFilename(), card: expectName };
}

// 1. B -> C
const optionC = await B.$eval('#sendTo', (s) => [...s.options].find((o) => o.textContent.includes('Phone C')).value);
await B.selectOption('#sendTo', optionC);
await B.setInputFiles('#picker', join(work, secretName));
await B.waitForFunction(() => document.querySelector('.job.is-sent'), null, { timeout: 30000 });
const held = sealedFiles();
const copy = held.length ? readFileSync(join(sealedDir, held[0])) : Buffer.alloc(0);
check(held.length === 1, `while C has not collected it, the PC holds exactly one sealed file (${sealedDir})`);
check(copy.length > 0 && !copy.equals(secret) && !copy.includes(Buffer.from(marker.slice(0, 30))), `the PC's copy (${copy.length} bytes) is not the file: none of its text is in it`);
check(!copy.includes(Buffer.from(secretName)) && !copy.includes(Buffer.from('b-to-c-secret')), "the PC's copy does not contain the file name");
const got = await receiveOnPhone(C, secretName);
check(got.body.equals(secret) && got.name === secretName, 'C decrypts it byte for byte, name included');
await C.waitForTimeout(500);
check(sealedFiles().length === 0, 'after C acknowledged, the sealed file is gone from the PC');
check((await state(C)).sealed.length === 0, 'and the PC no longer offers it to anyone');
await A.waitForTimeout(3500); // a few polls of A's page
const aState = JSON.stringify(await state(A));
const aHistory = JSON.stringify(await A.evaluate(async () => (await fetch('/api/history')).json()));
await A.click('[data-sheet="inbox"]');
await A.click('#tabHistory');
await A.waitForTimeout(800);
const aText = await A.evaluate(() => document.body.innerText + document.title);
check(!aText.includes('b-to-c-secret'), "A's page (city, inbox, history, chat, panels) shows nothing about it");
check(!aState.includes('b-to-c-secret') && !aHistory.includes('b-to-c-secret'), "A's state and history know nothing about it");
check(!readdirSync(inboxDir).some((f) => f.includes('b-to-c-secret')), "A's inbox folder has nothing of it");
if (logFile) check(!readFileSync(logFile, 'utf8').includes('b-to-c-secret'), "the terminal / activity log never mentions it");
await A.keyboard.press('Escape');

// 2. B -> Everyone
await B.selectOption('#sendTo', '*');
await B.setInputFiles('#picker', join(work, allName));
const c2 = await receiveOnPhone(C, allName);
check(c2.body.equals(forAll) && c2.name === allName, "C decrypts its own copy of B's file for everyone");
const onA = await A.waitForFunction(async (n) => {
  const r = await fetch('/api/files/' + encodeURIComponent(n));
  return r.ok ? r.headers.get('content-length') : false;
}, allName, { timeout: 20000, polling: 500 });
check(Number(await onA.jsonValue()) === forAll.length, "A's page decrypted its own copy and saved it into the PC's inbox");
check(readFileSync(join(inboxDir, allName)).equals(forAll), "A's copy is byte for byte the same");
await A.waitForTimeout(800);
check(sealedFiles().length === 0, 'after both recipients acknowledged, nothing is left in the sealed folder');
// 3. verifying a key: C opens B's key link (what scanning B's QR code does), and B shows as verified in C's list
const bPrint = await B.evaluate(async () => fingerprint(myKey));
await C.goto(lan.split('/?')[0] + '/#v=' + bPrint);
await C.waitForFunction(() => [...document.querySelectorAll('#sendTo option')].some((o) => o.textContent.includes('Phone B') && o.textContent.includes('verified') && !o.textContent.includes('not verified')), null, { timeout: 20000 });
check(true, "after scanning B's key link, C's Send to list marks Phone B as verified");
const cOptions = await C.$$eval('#sendTo option', (o) => o.map((x) => x.textContent));
check(cOptions.some((t) => t.includes('(PC)') && t.includes('not verified')), 'devices nobody verified are marked "not verified": ' + JSON.stringify(cOptions));

// 4. a device with no key is shown as such and never gets a plain copy
await page(lan, 'No key phone', true); // a browser without Web Crypto: it can never get a key
await B.waitForFunction(() => [...document.querySelectorAll('#sendTo option')].some((o) => o.textContent.includes('No key phone')), null, { timeout: 20000 });
const keylessOption = await B.$eval('#sendTo', (s) => { const o = [...s.options].find((x) => x.textContent.includes('No key phone')); return { text: o.textContent, disabled: o.disabled }; });
check(keylessOption.disabled && keylessOption.text.includes('no key yet'), `a device without a key is marked and cannot be picked: "${keylessOption.text}"`);

// 5. a new session means new keys
const before = (await state(A)).devices.find((d) => d.name === 'Phone B')?.key;
await A.click('#newSession');
await A.click('#newSession');
await A.waitForTimeout(800);
const fresh = await (await fetch('http://localhost:8080/api/connect')).json();
await B.goto(fresh.url);
await A.waitForFunction((old) => fetch('/api/state').then((r) => r.json()).then((s) => { const k = s.devices.find((d) => d.name === 'Phone B')?.key; return k && k !== old; }), before, { timeout: 20000, polling: 500 });
check(!!before, 'after the session ends, Phone B comes back with a brand new key');

check(errors.length === 0, 'no page errors ' + JSON.stringify(errors));

await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall browser end-to-end checks passed');
process.exit(failures ? 1 : 0);
