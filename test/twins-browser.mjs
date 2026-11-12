// Same name, two devices: someone closes Rooftop and rejoins from another browser under the same name.
// With Rooftop running on this machine:  node test/twins-browser.mjs
// Checks that the two are told apart, that the one that left is marked inactive and listed last, and that a
// personal chat with someone who left says so and refuses to send instead of losing the message.
const { chromium } = await import(process.env.ROOFTOP_PLAYWRIGHT || 'playwright');
const lan = (await (await fetch('http://localhost:8080/api/connect')).json()).url;
const browser = await chromium.launch({ channel: process.env.ROOFTOP_BROWSER_CHANNEL, args: ['--proxy-server=direct://', '--proxy-bypass-list=*'] });
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'ok    ' : 'FAIL  ') + what); if (!ok) failures++; };
const errors = [];
const stamp = Date.now().toString(36).slice(-4);
const twin = `Twin ${stamp}`;

async function phone(name) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(lan);
  await p.locator('#intro.s3').waitFor({ timeout: 20000 });
  await p.locator('#introEnter').press('Enter');
  await p.waitForFunction(() => typeof myKey === 'string' && myKey && state.youKey === myKey, null, { timeout: 30000 });
  await p.evaluate((n) => saveName(n), name); // straight through the name the screen would save
  if (await p.locator('#nameGateSkip').isVisible().catch(() => false)) await p.locator('#nameGateSkip').click();
  return { p, ctx, id: await p.evaluate(() => state.youId) };
}

try {
  const B = await phone(`Sender ${stamp}`);
  const old = await phone(twin);
  await B.p.waitForFunction((id) => state.devices.some((d) => d.id === id && d.key), old.id, { timeout: 20000 });
  const neu = await phone(twin);
  await B.p.waitForFunction((ids) => ids.every((id) => state.devices.some((d) => d.id === id && d.key)), [old.id, neu.id], { timeout: 20000 });
  await old.ctx.close(); // closes the page; the PC still lists it for a few seconds

  // both listed, told apart, the one that left marked inactive and listed after the active one
  await B.p.waitForFunction((id) => (state.devices.find((d) => d.id === id)?.idle || 0) >= 5, old.id, { timeout: 15000 });
  const names = await B.p.evaluate(({ a, b }) => { renderRecipients(true); return { old: person(a).name, neu: person(b).name,
    order: [...document.querySelectorAll('#sendToList .to-item-name')].map((e) => e.textContent) }; }, { a: old.id, b: neu.id });
  check(names.old !== names.neu && names.old.startsWith(twin) && names.neu.startsWith(twin), `the two are told apart: "${names.neu}" and "${names.old}"`);
  check(/inactive/.test(names.old) && !/inactive/.test(names.neu), 'the one that closed its page is marked inactive');
  const iNew = names.order.findIndex((n) => n === names.neu), iOld = names.order.findIndex((n) => n === names.old);
  check(iNew >= 0 && iOld > iNew, `the active one is listed first in Send to (${JSON.stringify(names.order.filter((n) => n.startsWith(twin)))})`);

  // a personal chat with the one that left: it says so and does not send
  await B.p.evaluate((id) => openChat('p:' + id), old.id);
  await B.p.waitForFunction((id) => !state.devices.some((d) => d.id === id), old.id, { timeout: 20000 });
  await B.p.waitForTimeout(1200);
  const left = await B.p.evaluate(() => ({ title: $('#threadTitle').textContent, sub: $('#threadSub').textContent, disabled: $('#note').disabled }));
  check(left.title.startsWith(twin) && left.title.endsWith('(left)') && /has left/.test(left.sub), `the chat says they left: "${left.title}", "${left.sub}"`);
  check(left.disabled, 'the message box is disabled, so nothing is sent into the void');
  const sent = await B.p.evaluate(async () => { $('#note').disabled = false; $('#note').value = 'hello?'; $('#noteForm').requestSubmit(); await new Promise((r) => setTimeout(r, 800)); return $('#noteError').textContent; });
  check(/left/.test(sent), `forcing a send is refused with a reason: "${sent}"`);

  // the one still here gets messages as normal
  await B.p.evaluate((id) => openChat('p:' + id), neu.id);
  await B.p.waitForTimeout(500);
  const hello = `hi ${stamp}`;
  await B.p.fill('#note', hello);
  await B.p.press('#note', 'Enter');
  await neu.p.waitForFunction((t) => [...convs.values()].some((c) => c.msgs.some((m) => m.text === t)), hello, { timeout: 20000 });
  check(true, 'the one still here receives a personal message');
  check(errors.length === 0, `no page errors ${JSON.stringify(errors)}`);
} catch (e) {
  console.log('FAIL  ' + e.message.split('\n')[0]);
  failures++;
}
await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall same-name checks passed');
process.exit(failures ? 1 : 0);
