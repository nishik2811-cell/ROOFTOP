/*
 * End-to-end encryption for every file a browser sends. Runs in the browser and in Node (for the checks),
 * using only Web Crypto. The PC in the middle only ever stores the sealed bytes.
 *
 * Sealed format "RTE2":
 *   "RTE2" | headerLength (u32) | header | chunk 0 | chunk 1 | ...
 *   header = fileId (7) | senderPublicKey (65) | recipientCount (u8) | recipient entries | sealed details
 *   recipient entry = keyTag (8) | ephemeralPublicKey (65) | salt (16) | wrapped file key (48)
 *   sealed details = AES-GCM of {name, size, ...} as JSON, padded to a multiple of 256 bytes
 *   chunk i = AES-256-GCM of 1 MB of the (padded) file, 16-byte tag included
 *
 * Every file gets its own random AES-256 file key and a random file id. Each nonce is the file id, a flag byte
 * (bit 0: last chunk, bit 1: details) and the chunk number, so chunks cannot be reordered, dropped or cut off.
 * The file key is wrapped once per recipient with a key from HKDF-SHA-256 over two ECDH (P-256) results: a one-time
 * key with the recipient's key, and the sender's own key with the recipient's key. Only the recipient can unwrap
 * it, and only if the sender really holds the key named in the header: a swapped sender key fails to unwrap.
 * The file is padded to a size bucket (at most about 6% more) so the PC only learns roughly how big it is.
 */
(function (root) {
  const subtle = root.crypto.subtle;
  const CHUNK = 1 << 20;
  const TAG = 16;
  const ID = 7;
  const ENTRY = 8 + 65 + 16 + 48;
  const MAGIC = [0x52, 0x54, 0x45, 0x32]; // "RTE2"
  const WRAP_INFO = new TextEncoder().encode('rooftop end-to-end v2 wrap');
  const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

  const b64 = (bytes) => {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const unb64 = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  // The private key is created non-extractable: scripts can use it, but nobody can read it out.
  async function newKeyPair() {
    return subtle.generateKey(ECDH, false, ['deriveBits']);
  }
  async function publicRaw(pair) {
    return new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  }
  const importPublic = (raw) => subtle.importKey('raw', raw, ECDH, true, []);
  const dh = async (privateKey, otherRaw) => new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: await importPublic(otherRaw) }, privateKey, 256));
  const keyTag = async (raw) => new Uint8Array(await subtle.digest('SHA-256', raw)).slice(0, 8);

  async function wrapKey(sharedOne, sharedTwo, salt, info) {
    const hkdf = await subtle.importKey('raw', concat(sharedOne, sharedTwo), 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  function nonce(fileId, index, last, details) {
    const n = new Uint8Array(12);
    n.set(fileId, 0);
    n[7] = (last ? 1 : 0) | (details ? 2 : 0);
    new DataView(n.buffer).setUint32(8, index);
    return n;
  }

  /** Six digits both sides can compare out loud. Same on both devices, whatever the order of the keys. */
  async function safetyCode(rawA, rawB) {
    const [lo, hi] = b64(rawA) < b64(rawB) ? [rawA, rawB] : [rawB, rawA];
    const digest = new Uint8Array(await subtle.digest('SHA-256', concat(lo, hi)));
    const n = new DataView(digest.buffer).getUint32(0) % 1000000;
    const s = String(n).padStart(6, '0');
    return s.slice(0, 3) + ' ' + s.slice(3);
  }

  /** The size the PC gets to see: at least 64 KB, then rounded up to a sixteenth of the nearest power of two. */
  function paddedSize(size) {
    if (size <= 65536) return 65536;
    const step = 2 ** (Math.floor(Math.log2(size)) - 4);
    return Math.ceil(size / step) * step;
  }
  const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK));

  /**
   * Seals data (anything with .size and .slice(a, b) returning a Blob, or a Uint8Array) for several recipients.
   * details is a small object (name, size, ...) that travels encrypted too. recipients are raw public keys.
   * Returns { total, pieces } where pieces yields the header first, then one sealed chunk at a time.
   */
  async function seal(data, details, recipients, sender) {
    if (!recipients.length || recipients.length > 255) throw new Error('between 1 and 255 recipients');
    const fileId = root.crypto.getRandomValues(new Uint8Array(ID));
    const rawFileKey = root.crypto.getRandomValues(new Uint8Array(32));
    const fileKey = await subtle.importKey('raw', rawFileKey, 'AES-GCM', false, ['encrypt']);
    const senderRaw = await publicRaw(sender);
    const entries = [];
    for (const r of recipients) {
      const eph = await subtle.generateKey(ECDH, false, ['deriveBits']);
      const ephRaw = await publicRaw(eph);
      const salt = root.crypto.getRandomValues(new Uint8Array(16));
      const info = concat(WRAP_INFO, fileId, senderRaw, ephRaw, r);
      const k = await wrapKey(await dh(eph.privateKey, r), await dh(sender.privateKey, r), salt, info);
      const wrapped = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, k, rawFileKey));
      entries.push(concat(await keyTag(r), ephRaw, salt, wrapped));
    }
    rawFileKey.fill(0);

    const size = data.size ?? data.length;
    const padded = paddedSize(size);
    let json = new TextEncoder().encode(JSON.stringify({ ...details, size }));
    json = concat(json, new Uint8Array(Math.ceil((json.length + 1) / 256) * 256 - json.length)); // zeros hide the name's length
    const sealedDetails = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce(fileId, 0, true, true) }, fileKey, json));

    const header = concat(fileId, senderRaw, Uint8Array.of(entries.length), ...entries, new Uint8Array(4), sealedDetails);
    new DataView(header.buffer).setUint32(ID + 65 + 1 + entries.length * ENTRY, sealedDetails.length);
    const start = concat(Uint8Array.from(MAGIC), new Uint8Array(4), header);
    new DataView(start.buffer).setUint32(4, header.length);
    const n = chunkCount(padded);
    const total = start.length + padded + n * TAG;

    async function* pieces() {
      yield start;
      for (let i = 0; i < n; i++) {
        const from = i * CHUNK, to = Math.min(padded, from + CHUNK);
        const plain = new Uint8Array(to - from); // whatever lies past the real end stays zero: padding
        if (from < size) {
          const part = data.slice(from, Math.min(size, to));
          plain.set(part instanceof Uint8Array ? part : new Uint8Array(await part.arrayBuffer()));
        }
        yield new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce(fileId, i, i === n - 1, false) }, fileKey, plain));
      }
    }
    return { total, pieces: pieces() };
  }

  /**
   * Opens a sealed stream (a ReadableStream reader or any async iterable of Uint8Array pieces) with this device's
   * key pair. Returns { details, senderRaw, parts } where parts are the decrypted chunks, padding removed.
   * Throws if it is not for this key, or if anything was changed, swapped, reordered or cut off.
   */
  async function open(pieces, pair, onProgress = () => {}) {
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
        buf = concat(buf, r.value);
      }
      return buf.length >= n;
    }

    if (!(await fill(8))) throw new Error('not a sealed file');
    const start = take(8);
    if (MAGIC.some((b, i) => start[i] !== b)) throw new Error('not a sealed file');
    const headerLength = new DataView(start.buffer).getUint32(4);
    if (headerLength > 64 * 1024 || !(await fill(headerLength))) throw new Error('damaged header');
    const header = take(headerLength);
    const fileId = header.slice(0, ID), senderRaw = header.slice(ID, ID + 65), count = header[ID + 65];
    const myRaw = await publicRaw(pair);
    const myTag = await keyTag(myRaw);
    let fileKey = null;
    for (let i = 0; i < count; i++) {
      const e = header.slice(ID + 66 + i * ENTRY, ID + 66 + (i + 1) * ENTRY);
      if (!same(e.slice(0, 8), myTag)) continue;
      const ephRaw = e.slice(8, 73), salt = e.slice(73, 89), wrapped = e.slice(89);
      const info = concat(WRAP_INFO, fileId, senderRaw, ephRaw, myRaw);
      const k = await wrapKey(await dh(pair.privateKey, ephRaw), await dh(pair.privateKey, senderRaw), salt, info);
      let raw;
      try {
        raw = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, k, wrapped));
      } catch {
        throw new Error('the sender’s key does not match: it was swapped or damaged on the way');
      }
      fileKey = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
      raw.fill(0);
    }
    if (!fileKey) throw new Error('this file was not sealed for this device');
    const at = ID + 66 + count * ENTRY;
    const detailsLength = new DataView(header.buffer).getUint32(at);
    const json = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce(fileId, 0, true, true) }, fileKey, header.slice(at + 4, at + 4 + detailsLength)));
    const end = json.indexOf(0);
    const details = JSON.parse(new TextDecoder().decode(end >= 0 ? json.slice(0, end) : json));

    const parts = [];
    let kept = 0;
    for (let i = 0; ; i++) {
      await fill(CHUNK + TAG + 1); // one byte more tells us whether this is the last chunk
      const last = ended && buf.length <= CHUNK + TAG;
      const sealed = take(Math.min(buf.length, CHUNK + TAG));
      if (sealed.length < TAG) throw new Error('cut off');
      const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce(fileId, i, last, false) }, fileKey, sealed));
      const keep = Math.max(0, Math.min(plain.length, details.size - kept));
      if (keep) parts.push(keep === plain.length ? plain : plain.slice(0, keep));
      kept += keep;
      if (last) break;
    }
    if (kept !== details.size) throw new Error('cut off');
    return { details, senderRaw, parts };
  }

  root.RooftopE2E = { newKeyPair, publicRaw, safetyCode, seal, open, paddedSize, b64, unb64, CHUNK };
})(typeof window !== 'undefined' ? window : globalThis);
