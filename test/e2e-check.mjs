// End-to-end check against a running Rooftop on this machine:
//   node test/e2e-check.mjs
// The "sender" is this PC's own page (localhost); the "recipient" is a phone-like browser reaching the PC over
// the Wi-Fi address. Both use the exact crypto the page uses (web/e2e.js). The check proves that
//   1. the copy the PC holds is not the file (no plaintext, no file name in it),
//   2. the PC shows nothing about it (state, inbox, terminal log if ROOFTOP_LOG is given),
//   3. only the recipient can fetch it, and it decrypts to the original,
//   4. after the acknowledgement nothing is left on the PC.
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { userInfo, tmpdir, platform } from 'os';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the PC's certificate is self-signed
const here = dirname(fileURLToPath(import.meta.url));
new Function(readFileSync(join(here, '../web/e2e.js'), 'utf8'))();
const E = globalThis.RooftopE2E;

const sealedDir = process.env.ROOFTOP_SEALED_DIR
  || join(platform() === 'linux' ? '/tmp' : tmpdir(), 'rooftop-sealed-' + userInfo().username);
let failures = 0;
const check = (ok, what) => { console.log((ok ? 'ok    ' : 'FAIL  ') + what); if (!ok) failures++; };
const json = async (r) => { if (!r.ok) throw new Error(r.status + ' ' + (await r.text())); return r.json(); };

const local = 'http://localhost:8080';
const connect = await json(await fetch(local + '/api/connect'));
const lan = connect.url.split('/?')[0];
const pin = connect.pin;
const phone = (path, opts) => fetch(lan + path + (path.includes('?') ? '&' : '?') + 'pin=' + pin, opts);

// the recipient registers its key, like the page does on load
const bob = await E.newKeyPair();
const bobRaw = await E.publicRaw(bob);
await phone('/api/key', { method: 'POST', body: E.b64(bobRaw) });
const bobId = (await json(await phone('/api/state'))).youId;

// the sender (this PC's page) seals a file for that device
const alice = await E.newKeyPair();
const aliceRaw = await E.publicRaw(alice);
const name = 'e2e-check-secret-' + Date.now() + '.txt';
const marker = 'ROOFTOP PLAINTEXT MARKER, the host must never see this line. ';
const original = new TextEncoder().encode(marker.repeat(60000)); // about 3.6 MB
const hostView = await json(await fetch(local + '/api/state'));
const target = hostView.devices.find((d) => d.id === bobId);
check(target && target.key === E.b64(bobRaw), 'recipient key is listed in /api/state');

const pieces = [];
for await (const p of E.seal(original, name, E.unb64(target.key), aliceRaw)) pieces.push(p);
const total = E.sealedSize(original.length, pieces[0].length - 8);
const key = 'check' + Date.now();
let offset = 0;
for (const p of pieces) {
  const r = await json(await fetch(`${local}/api/sealed/upload?key=${key}&offset=${offset}&size=${total}&to=${encodeURIComponent(bobId)}`, { method: 'POST', body: p }));
  offset = r.offset;
}
check(offset === total, `sealed upload complete (${total} bytes for a ${original.length}-byte file)`);

// 1. what the PC holds is not the file
const held = existsSync(sealedDir) ? readdirSync(sealedDir) : [];
check(held.length === 1, `the PC holds exactly one sealed file in its hidden temp folder (${sealedDir})`);
const copy = held.length ? readFileSync(join(sealedDir, held[0])) : Buffer.alloc(0);
check(copy.length === total && !copy.equals(Buffer.from(original)), "the PC's copy is not the original file");
check(!copy.includes(Buffer.from(marker.slice(0, 24))), "the PC's copy contains none of the file's text");
check(!copy.includes(Buffer.from(name)), "the PC's copy does not contain the file name");

// 2. the PC shows nothing about it
const after = JSON.stringify(await json(await fetch(local + '/api/state')));
check(!after.includes(name) && !after.includes(held[0] || '#'), "the PC's own page (city, inbox, devices) shows nothing about it");
check(!readdirSync(join(userInfo().homedir, 'Rooftop')).some((f) => f.includes('e2e-check')), 'nothing was put in the inbox folder');
if (process.env.ROOFTOP_LOG) {
  const log = readFileSync(process.env.ROOFTOP_LOG, 'utf8');
  check(!log.includes(name) && !log.includes(held[0] || '#'), 'the terminal / activity log never mentions it');
}

// 3. only the recipient can fetch it, and it opens to the original
const id = (await json(await phone('/api/state'))).sealed[0]?.id;
check(!!id, 'the recipient sees one private file waiting');
check((await fetch(`${local}/api/sealed/${id}`)).status === 404, 'the PC itself cannot fetch it');
const res = await phone(`/api/sealed/${id}`);
const out = await E.open(res.body.getReader(), bob.privateKey);
const plain = Buffer.concat(out.parts.map((p) => Buffer.from(p)));
check(plain.equals(Buffer.from(original)) && out.name === name, 'the recipient decrypts it to the exact original, name included');
check(await E.safetyCode(bobRaw, out.senderRaw) === await E.safetyCode(aliceRaw, bobRaw), 'sender and recipient see the same safety code');

// 4. acknowledgement: nothing left
await phone(`/api/sealed/${id}/ack`, { method: 'POST' });
check(readdirSync(sealedDir).length === 0, 'after the acknowledgement the sealed file is gone from the PC');
check((await json(await phone('/api/state'))).sealed.length === 0, 'and the PC no longer knows it existed');
check((await phone(`/api/sealed/${id}`)).status === 404, 'and it cannot be fetched again');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall end-to-end checks passed');
process.exit(failures ? 1 : 0);
