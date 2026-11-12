// A file's type comes from its sender. One phone sends another an html page named "report.pdf" with type text/html;
// opened from the page it would run with Rooftop's origin. Checks it arrives as a plain download and never runs.
// With Rooftop running on this machine:  node test/file-type-browser.mjs
const { chromium } = await import(process.env.ROOFTOP_PLAYWRIGHT || 'playwright');
const lan = (await (await fetch('http://localhost:8080/api/connect')).json()).url;
const browser = await chromium.launch({ channel: process.env.ROOFTOP_BROWSER_CHANNEL, args: ['--proxy-server=direct://', '--proxy-bypass-list=*'] });
async function phone(name) {
  const p = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  await p.goto(lan);
  await p.locator('#intro.s3').waitFor({ timeout: 20000 });
  await p.locator('#introEnter').press('Enter');
  await p.waitForFunction(() => typeof myKey === 'string' && myKey && state.youKey === myKey, null, { timeout: 30000 });
  await p.evaluate((n) => saveName(n), name);
  return { p, id: await p.evaluate(() => state.youId) };
}
let failed = false;
try {
  const sender = await phone('Type sender'), victim = await phone('Type receiver');
  await sender.p.waitForFunction((id) => state.devices.some((d) => d.id === id && d.key), victim.id, { timeout: 20000 });
  await sender.p.evaluate((id) => {
    renderRecipients(true); pickRecipient('*'); pickRecipient(id);
    upload([new File(['<script>parent.pwned = 1</script>'], 'report.pdf', { type: 'text/html' }),
      new File([new Uint8Array(10)], 'photo.png', { type: 'image/png' })]);
  }, victim.id);
  await victim.p.waitForFunction(() => localFiles.length === 2, null, { timeout: 30000 });
  const types = await victim.p.evaluate(() => Object.fromEntries(localFiles.map((f) => [f.name, f.blob.type])));
  await victim.p.evaluate(() => { const f = document.createElement('iframe'); f.src = localFile('report.pdf').url; document.body.append(f); });
  await victim.p.waitForTimeout(1500);
  const ran = await victim.p.evaluate(() => !!window.pwned);
  const ok = types['report.pdf'] === 'application/octet-stream' && types['photo.png'] === 'image/png' && !ran;
  console.log((ok ? 'ok    ' : 'FAIL  ') + `html sent as a pdf stays a download (${JSON.stringify(types)}, script ran: ${ran})`);
  failed = !ok;
} catch (e) {
  console.log('FAIL  ' + e.message.split('\n')[0]);
  failed = true;
}
await browser.close();
process.exit(failed ? 1 : 0);
