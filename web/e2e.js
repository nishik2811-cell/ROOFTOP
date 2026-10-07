/*
 * End-to-end encryption for files sent to one device. Runs in the browser and in Node (for the check),
 * using only Web Crypto. The PC in the middle only ever stores the sealed bytes.
 *
 * Sealed format:
 *   "RTE1" | headerLength (u32) | header | chunk 0 | chunk 1 | ...
 *   header = senderPublicKey (65) | ephemeralPublicKey (65) | salt (16) | nameLength (u16) | sealed name
 *   chunk i = AES-256-GCM of up to 1 MB of the file, 16-byte tag included
 * The key comes from HKDF-SHA-256 over an ECDH (P-256) between a one-time key and the recipient's key.
 * Each nonce carries the chunk number and a "last chunk" flag, so chunks cannot be reordered, dropped or cut off.
 */
(function (root) {
  const subtle = root.crypto.subtle;
  const CHUNK = 1 << 20;
  const TAG = 16;
  const MAGIC = [0x52, 0x54, 0x45, 0x31]; // "RTE1"
  const INFO = new TextEncoder().encode('rooftop end-to-end v1');
  const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

  const b64 = (bytes) => {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const unb64 = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

  // The private key is created non-extractable: scripts can use it, but nobody can read it out.
  async function newKeyPair() {
    return subtle.generateKey(ECDH, false, ['deriveBits']);
  }
  async function publicRaw(pair) {
    return new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  }
  const importPublic = (raw) => subtle.importKey('raw', raw, ECDH, true, []);

  async function aesKey(privateKey, otherRaw, salt) {
    const shared = await subtle.deriveBits({ name: 'ECDH', public: await importPublic(otherRaw) }, privateKey, 256);
    const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  function nonce(kind, index, last) {
    const n = new Uint8Array(12);
    n[0] = kind;           // 0 = file chunk, 1 = name
    n[1] = last ? 1 : 0;
    new DataView(n.buffer).setBigUint64(4, BigInt(index));
    return n;
  }

  /** Six digits both sides can compare out loud. Same on both devices, whatever the order of the keys. */
  async function safetyCode(rawA, rawB) {
    const [lo, hi] = b64(rawA) < b64(rawB) ? [rawA, rawB] : [rawB, rawA];
    const both = new Uint8Array(lo.length + hi.length);
    both.set(lo); both.set(hi, lo.length);
    const digest = new Uint8Array(await subtle.digest('SHA-256', both));
    const n = new DataView(digest.buffer).getUint32(0) % 1000000;
    const s = String(n).padStart(6, '0');
    return s.slice(0, 3) + ' ' + s.slice(3);
  }

  const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK));

  /**
   * Seals a file (anything with .size and .slice(a, b) returning a Blob, or a Uint8Array) for one recipient.
   * Yields the header first, then one sealed chunk at a time, so a big file never sits in memory.
   */
  async function* seal(file, name, recipientRaw, senderRaw) {
    const eph = await subtle.generateKey(ECDH, false, ['deriveBits']);
    const ephRaw = await publicRaw(eph);
    const salt = root.crypto.getRandomValues(new Uint8Array(16));
    const key = await aesKey(eph.privateKey, recipientRaw, salt);
    const sealedName = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce(1, 0, true) }, key, new TextEncoder().encode(name)));

    const header = new Uint8Array(65 + 65 + 16 + 2 + sealedName.length);
    header.set(senderRaw, 0); header.set(ephRaw, 65); header.set(salt, 130);
    new DataView(header.buffer).setUint16(146, sealedName.length);
    header.set(sealedName, 148);
    const start = new Uint8Array(8 + header.length);
    start.set(MAGIC); new DataView(start.buffer).setUint32(4, header.length); start.set(header, 8);
    yield start;

    const size = file.size ?? file.length;
    const n = chunkCount(size);
    for (let i = 0; i < n; i++) {
      const part = file.slice(i * CHUNK, Math.min(size, (i + 1) * CHUNK));
      const plain = part instanceof Uint8Array ? part : new Uint8Array(await part.arrayBuffer());
      yield new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce(0, i, i === n - 1) }, key, plain));
    }
  }

  /** Total sealed size for a file of {@code size} bytes and a header of {@code headerLength}. */
  const sealedSize = (size, headerLength) => 8 + headerLength + size + chunkCount(size) * TAG;

  /**
   * Opens a sealed stream (a ReadableStream reader or any async iterable of Uint8Array pieces).
   * Returns { name, senderRaw, parts } where parts are the decrypted chunks, in order.
   * Throws if anything was changed, reordered or cut off.
   */
  async function open(pieces, privateKey, onProgress = () => {}) {
    let buf = new Uint8Array(0);
    const take = (n) => { const out = buf.slice(0, n); buf = buf.slice(n); return out; };
    const iterator = pieces[Symbol.asyncIterator] ? pieces[Symbol.asyncIterator]() : null;
    let ended = false, got = 0;
    async function fill(n) {
      while (buf.length < n && !ended) {
        const r = iterator ? await iterator.next() : await pieces.read();
        if (r.done) { ended = true; break; }
        got += r.value.length;
        onProgress(got);
        const merged = new Uint8Array(buf.length + r.value.length);
        merged.set(buf); merged.set(r.value, buf.length);
        buf = merged;
      }
      return buf.length >= n;
    }

    if (!(await fill(8))) throw new Error('not a sealed file');
    const start = take(8);
    if (MAGIC.some((b, i) => start[i] !== b)) throw new Error('not a sealed file');
    const headerLength = new DataView(start.buffer).getUint32(4);
    if (headerLength > 4096 || !(await fill(headerLength))) throw new Error('damaged header');
    const header = take(headerLength);
    const senderRaw = header.slice(0, 65), ephRaw = header.slice(65, 130), salt = header.slice(130, 146);
    const nameLength = new DataView(header.buffer).getUint16(146);
    const key = await aesKey(privateKey, ephRaw, salt);
    const name = new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv: nonce(1, 0, true) }, key, header.slice(148, 148 + nameLength)));

    const parts = [];
    for (let i = 0; ; i++) {
      await fill(CHUNK + TAG + 1); // one byte more tells us whether this is the last chunk
      const last = ended && buf.length <= CHUNK + TAG;
      const sealed = take(Math.min(buf.length, CHUNK + TAG));
      if (sealed.length < TAG) throw new Error('cut off');
      parts.push(new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce(0, i, last) }, key, sealed)));
      if (last) break;
    }
    return { name, senderRaw, parts };
  }

  root.RooftopE2E = { newKeyPair, publicRaw, safetyCode, seal, sealedSize, open, b64, unb64, CHUNK };
})(typeof window !== 'undefined' ? window : globalThis);
