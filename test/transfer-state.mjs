// Focused checks for streaming decryption and manual retry of the same ciphertext.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import '../web/e2e.js';
const E2E = globalThis.RooftopE2E;
const pair = await E2E.newKeyPair();
const raw = await E2E.publicRaw(pair);
const file = new File([new Uint8Array(10 * 1024 * 1024).fill(37)], 'large.bin');
const sealed = await E2E.seal(file, { name: file.name }, [raw], pair);
let bytes = 0, chunks = 0;
const opened = await E2E.open(sealed.pieces, pair, undefined, async (chunk) => {
  assert.ok(chunk.length <= E2E.CHUNK);
  assert.ok(chunk.every((b) => b === 37));
  bytes += chunk.length;
  chunks++;
});
assert.equal(bytes, file.size);
assert.ok(chunks > 1);
assert.deepEqual(opened.parts, [], 'streaming receiver retains no plaintext chunks');
const corrupt = await E2E.seal(file, {}, [raw], pair);
const pieces = [];
for await (const piece of corrupt.pieces) pieces.push(piece);
pieces.at(-1)[0] ^= 1;
await assert.rejects(E2E.open((async function* () { yield* pieces; })(), pair, undefined, () => {}));
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
let fail = true, key, have = 0, seals = 0;
const received = [];
const ctx = vm.createContext({ Blob, crypto, state: { session: 'test' }, myPair: pair,
  E2E: { ...E2E, seal: (...args) => { seals++; return E2E.seal(...args); } },
  RETRIES: 0, PinError: class extends Error {}, Cancelled: class extends Error {},
  postSealed: async (job, piece, uploadKey, offset) => {
    key ??= uploadKey;
    assert.equal(uploadKey, key);
    if (offset !== have) return { offset: have };
    // Lose the response after the second batch reached the relay.
    received.push(new Uint8Array(await piece.arrayBuffer()));
    have += piece.size;
    if (fail && received.length === 2) throw new Error('lost reply');
    return { offset: have };
  },
});
vm.runInContext(app.slice(app.indexOf('const UPLOAD_BATCH ='), app.indexOf('\nfunction postSealed(')), ctx);
const job = { file, recipients: [{ id: 'peer', key: E2E.b64(raw) }], to: 'peer', transferId: 'batch', transferCount: 1 };
await assert.rejects(ctx.sendSealed(job), /lost reply/);
assert.ok(job.sealedUpload.offset > 0);
fail = false;
await ctx.sendSealed(job);
assert.equal(seals, 1, 'manual retry reuses the original encryption and upload ID');
assert.equal(have, job.sealedUpload.total);
const result = await E2E.open((async function* () { yield* received; })(), pair);
assert.deepEqual(new Uint8Array(await new Blob(result.parts).arrayBuffer()), new Uint8Array(await file.arrayBuffer()));
ctx.state.session = 'new';
await assert.rejects(ctx.sendSealed(job), /session changed/);
console.log('ok streaming decryption, tamper rejection, manual resume after lost reply, session isolation');
// Unsupported disk storage: all concurrent receivers share the fallback budget and release it on failure.
const fallback = vm.createContext({ Blob, crypto, navigator: {}, window: { addEventListener() {} } });
vm.runInContext(app.slice(app.indexOf('const MEMORY_RECEIVE_LIMIT ='), app.indexOf('/** Downloads and opens one sealed file without')), fallback);
const first = await fallback.receiveSink();
const second = await fallback.receiveSink();
await first.write(new Uint8Array(40 * 1024 * 1024));
await assert.rejects(second.write(new Uint8Array(25 * 1024 * 1024)), /memory limit/);
await first.abort();
await second.write(new Uint8Array([1, 2, 3]));
assert.deepEqual(new Uint8Array(await (await second.finish('')).arrayBuffer()), new Uint8Array([1, 2, 3]));
second.dispose();
assert.equal(vm.runInContext('receiveMemory', fallback), 0);
console.log('ok shared memory fallback budget and failure cleanup');
// Cancel while the announcement is blocked; releasing it must not requeue the cancelled job.
let announce;
const announcement = new Promise((resolve) => { announce = resolve; });
const queue = vm.createContext({
  crypto, E2E: {}, myPair: {}, state: { local: false }, jobs: [], jobSeq: 0, batch: 0, PARALLEL: 3,
  $: () => ({ value: 'peer' }), recipientsFor: () => ({ list: [{ id: 'peer', name: 'Peer' }], missing: [] }),
  city: { startFlight() {} }, acquireWakeLock() {}, renderTray() {}, toast() {}, finishBatch() {},
  transferNotice: (job, status) => status === 'uploading' ? announcement : Promise.resolve(),
  pump() { assert.ok(queue.jobs.every((j) => j.state !== 'waiting'), 'cancelled announcements never start uploading'); },
});
vm.runInContext(app.slice(app.indexOf('async function upload(list)'), app.indexOf('/** Starts as many waiting files')), queue);
vm.runInContext(app.slice(app.indexOf('function cancelJob('), app.indexOf('function retryJob(')), queue);
const pending = queue.upload([file]);
assert.equal(queue.jobs[0].state, 'announcing');
queue.cancelJob(queue.jobs[0]);
assert.equal(queue.jobs[0].state, 'cancelled');
announce();
await pending;
assert.equal(queue.jobs[0].state, 'cancelled');
console.log('ok cancellation while transfer announcement is in flight');
