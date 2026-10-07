// Browser-path speed, with Rooftop running on this machine:
//   node test/speed-browser.mjs [--mb 100] [--runs 3]
// A phone page in Chrome (over the Wi-Fi address, HTTPS) sends a file of random bytes to the PC through the real page
// code: sealed in the page (AES-256-GCM, 1 MB chunks), uploaded in pieces, then the PC's own page downloads it,
// decrypts it and files it in the inbox. Timed:
//   send    = sealing + uploading in the phone page, until the PC holds every byte
//   total   = from pressing send until the file is in the PC's inbox (includes the PC page noticing it, up to a poll)
// Both run on this one machine, so the network part is loopback: these are the software's limits, not Wi-Fi's.
const { chromium } = await import(process.env.ROOFTOP_PLAYWRIGHT || 'playwright');
const args = process.argv;
const MB = args.includes('--mb') ? +args[args.indexOf('--mb') + 1] : 100;
const RUNS = args.includes('--runs') ? +args[args.indexOf('--runs') + 1] : 3;
const lan = (await (await fetch('http://localhost:8080/api/connect')).json()).url;
const browser = await chromium.launch({ channel: process.env.ROOFTOP_BROWSER_CHANNEL, args: ['--proxy-server=direct://', '--proxy-bypass-list=*'] });

async function page(url, name) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  await p.goto(url);
  await p.locator('#intro.s3').waitFor({ timeout: 20000 });
  await p.locator('#introEnter').press('Enter');
  const gate = p.locator('#nameGateInput');
  if (await gate.isVisible({ timeout: 4000 }).catch(() => false)) { await gate.fill(name); await gate.press('Enter'); }
  return p;
}
const A = await page('http://localhost:8080/', 'Bench PC');
const B = await page(lan, 'Bench phone');
await A.waitForFunction(() => myKey && state.youKey === myKey, null, { timeout: 30000 });
await B.waitForFunction(() => myKey && state.youKey === myKey && state.meKey, null, { timeout: 30000 });

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const sends = [], totals = [];
for (let run = 1; run <= RUNS; run++) {
  const name = `speed-${MB}mb-${Date.now()}.bin`;
  const send = await B.evaluate(async ({ name, MB }) => {
    const bytes = new Uint8Array(MB * 1e6);
    for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536)); // incompressible
    renderRecipients();
    $('#sendTo').value = state.meId;
    window.__t0 = performance.now();
    upload([new File([bytes], name)]);
    while (jobs.some((j) => j.state === 'waiting' || j.state === 'sending')) await new Promise((r) => setTimeout(r, 20));
    if (!jobs.some((j) => j.file.name === name && j.state === 'sent')) throw new Error('send failed: ' + JSON.stringify(jobs.map((j) => [j.state, j.note])));
    window.__t0wall = Date.now() - (performance.now() - window.__t0);
    return (performance.now() - window.__t0) / 1000;
  }, { name, MB });
  const t0wall = await B.evaluate(() => window.__t0wall);
  await A.waitForFunction((n) => state.files.some((f) => f.name === n), name, { timeout: 300000, polling: 50 });
  const total = (Date.now() - t0wall) / 1000;
  sends.push(MB / send); totals.push(MB / total);
  console.log(`run ${run}: send ${send.toFixed(2)} s (${(MB / send).toFixed(1)} MB/s), into the PC's inbox ${total.toFixed(2)} s (${(MB / total).toFixed(1)} MB/s)`);
  await fetch('http://localhost:8080/api/remove?name=' + encodeURIComponent(name), { method: 'POST' });
}
console.log(`\n${MB} MB, ${RUNS} runs, median: phone page seals + uploads at ${median(sends).toFixed(1)} MB/s; end to end into the PC's inbox at ${median(totals).toFixed(1)} MB/s`);
await browser.close();
