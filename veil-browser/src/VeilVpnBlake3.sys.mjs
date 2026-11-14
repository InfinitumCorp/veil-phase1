/* BLAKE3 key derivation for Shadowsocks 2022.
 *
 * This is a compact port of the portable BLAKE3 compression (BLAKE3-team,
 * CC0) limited to inputs of one chunk (1024 bytes) and at most 64 bytes of
 * output. Shadowsocks 2022 only asks it to derive a session subkey from a
 * pre-shared key and a salt, which fits in that limit. Longer inputs throw
 * rather than returning a wrong key.
 */

const IV = Uint32Array.from([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const MSG_SCHEDULE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8],
  [3, 4, 10, 12, 13, 2, 7, 14, 6, 5, 9, 0, 11, 15, 8, 1],
  [10, 7, 12, 9, 14, 3, 13, 15, 4, 0, 11, 2, 5, 8, 1, 6],
  [12, 13, 9, 11, 15, 10, 14, 8, 7, 2, 5, 3, 0, 1, 6, 4],
  [9, 14, 11, 5, 8, 12, 15, 1, 13, 3, 0, 10, 2, 6, 4, 7],
  [11, 15, 5, 0, 1, 9, 8, 6, 14, 10, 2, 12, 3, 4, 7, 13],
];

const CHUNK_START = 1;
const CHUNK_END = 2;
const ROOT = 8;
const DERIVE_KEY_CONTEXT = 32;
const DERIVE_KEY_MATERIAL = 64;
const BLOCK = 64;
const CHUNK = 1024;

const u32 = n => n >>> 0;

function rotr(x, n) {
  return u32((x >>> n) | (x << (32 - n)));
}

function load32(block, offset) {
  return (
    block[offset] |
    (block[offset + 1] << 8) |
    (block[offset + 2] << 16) |
    (block[offset + 3] << 24)
  ) >>> 0;
}

function store32(out, offset, word) {
  out[offset] = word & 0xff;
  out[offset + 1] = (word >>> 8) & 0xff;
  out[offset + 2] = (word >>> 16) & 0xff;
  out[offset + 3] = (word >>> 24) & 0xff;
}

function g(state, a, b, c, d, x, y) {
  state[a] = u32(state[a] + state[b] + x);
  state[d] = rotr(state[d] ^ state[a], 16);
  state[c] = u32(state[c] + state[d]);
  state[b] = rotr(state[b] ^ state[c], 12);
  state[a] = u32(state[a] + state[b] + y);
  state[d] = rotr(state[d] ^ state[a], 8);
  state[c] = u32(state[c] + state[d]);
  state[b] = rotr(state[b] ^ state[c], 7);
}

function compress(cv, block, blockLen, counter, flags) {
  const words = new Uint32Array(16);
  for (let i = 0; i < 16; i++) words[i] = load32(block, i * 4);
  const state = new Uint32Array(16);
  state.set(cv);
  state[8] = IV[0];
  state[9] = IV[1];
  state[10] = IV[2];
  state[11] = IV[3];
  state[12] = counter >>> 0;
  state[13] = Math.floor(counter / 2 ** 32) >>> 0;
  state[14] = blockLen;
  state[15] = flags;
  for (let round = 0; round < 7; round++) {
    const m = MSG_SCHEDULE[round];
    g(state, 0, 4, 8, 12, words[m[0]], words[m[1]]);
    g(state, 1, 5, 9, 13, words[m[2]], words[m[3]]);
    g(state, 2, 6, 10, 14, words[m[4]], words[m[5]]);
    g(state, 3, 7, 11, 15, words[m[6]], words[m[7]]);
    g(state, 0, 5, 10, 15, words[m[8]], words[m[9]]);
    g(state, 1, 6, 11, 12, words[m[10]], words[m[11]]);
    g(state, 2, 7, 8, 13, words[m[12]], words[m[13]]);
    g(state, 3, 4, 9, 14, words[m[14]], words[m[15]]);
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) store32(out, i * 4, state[i] ^ state[i + 8]);
  for (let i = 0; i < 8; i++) store32(out, 32 + i * 4, state[i + 8] ^ cv[i]);
  const next = new Uint32Array(8);
  for (let i = 0; i < 8; i++) next[i] = state[i] ^ state[i + 8];
  return { chaining: next, bytes: out };
}

function wordsOf(bytes) {
  const cv = new Uint32Array(8);
  for (let i = 0; i < 8; i++) cv[i] = load32(bytes, i * 4);
  return cv;
}

/** Hash one chunk. `key` is 32 bytes or null (use the IV). */
export function blake3(message, { key = null, flags = 0, outLen = 32 } = {}) {
  if (!(message instanceof Uint8Array)) throw new Error("blake3 message must be bytes");
  if (message.length > CHUNK) throw new Error("blake3 input exceeds one chunk");
  if (outLen < 1 || outLen > 64) throw new Error("blake3 output length must be 1..64");
  let cv = key ? wordsOf(key) : IV.slice();
  const buf = new Uint8Array(BLOCK);
  let bufLen = 0;
  let blocks = 0;
  let offset = 0;
  while (offset < message.length) {
    const take = Math.min(BLOCK - bufLen, message.length - offset);
    buf.set(message.subarray(offset, offset + take), bufLen);
    bufLen += take;
    offset += take;
    if (bufLen === BLOCK && offset < message.length) {
      const start = blocks === 0 ? CHUNK_START : 0;
      cv = compress(cv, buf, BLOCK, 0, flags | start).chaining;
      blocks += 1;
      buf.fill(0);
      bufLen = 0;
    }
  }
  const start = blocks === 0 ? CHUNK_START : 0;
  const wide = compress(cv, buf, bufLen, 0, flags | start | CHUNK_END | ROOT).bytes;
  return wide.slice(0, outLen);
}

const SESSION_CONTEXT = "shadowsocks 2022 session subkey";

/**
 * BLAKE3 derive_key, matching Xray-core's DeriveSessionSubKey:
 * context is hashed under DERIVE_KEY_CONTEXT, and that 32-byte result keys
 * the material hash under DERIVE_KEY_MATERIAL.
 */
export function deriveKey(context, material, outLen) {
  const contextKey = blake3(new TextEncoder().encode(context), {
    flags: DERIVE_KEY_CONTEXT,
    outLen: 32,
  });
  return blake3(material, { key: contextKey, flags: DERIVE_KEY_MATERIAL, outLen });
}

export function sessionSubkey(psk, salt) {
  if (psk.length !== salt.length) throw new Error("salt length must match the key");
  const material = new Uint8Array(psk.length + salt.length);
  material.set(psk, 0);
  material.set(salt, psk.length);
  return deriveKey(SESSION_CONTEXT, material, psk.length);
}
