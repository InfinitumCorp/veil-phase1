/* Local VEIL tunnel. The browser (and Tor in front of it) speaks SOCKS5 to a
 * loopback listener. Each CONNECT is carried to one VEIL node and nowhere
 * else: Shadowsocks 2022 (Xray-core 26.11.9, single pre-shared key) or HTTP
 * CONNECT with Basic auth. Destination names are written into that tunnel.
 * This module never resolves them.
 */

import { sessionSubkey } from "./VeilVpnBlake3.sys.mjs";

export class VpnError extends Error {
  constructor(code) {
    super(code);
    this.name = "VpnError";
    this.code = code;
  }
}

const text = new TextEncoder();
const utf8 = new TextDecoder();

export function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function isIpv4(host) {
  if (typeof host !== "string") return false;
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every(p => p.length > 0 && p.length <= 3 && !/^0\d/.test(p) && Number(p) <= 255 && String(Number(p)) === p);
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function incrementNonce(nonce) {
  for (let i = 0; i < nonce.length; i++) {
    nonce[i] = (nonce[i] + 1) & 0xff;
    if (nonce[i] !== 0) return;
  }
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function buffered(conn) {
  let buf = new Uint8Array(0);
  let eof = false;
  async function fill() {
    if (eof) throw new VpnError("eof");
    const chunk = await conn.readSome();
    if (!chunk || chunk.length === 0) {
      eof = true;
      throw new VpnError("eof");
    }
    buf = concat(buf, chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  }
  return {
    async exact(n) {
      while (buf.length < n) await fill();
      const out = buf.slice(0, n);
      buf = buf.slice(n);
      return out;
    },
    /** Bytes already read from the socket and not yet consumed. Does not wait. */
    take() {
      const out = buf;
      buf = new Uint8Array(0);
      return out;
    },
  };
}

async function importKey(raw) {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function openSession(psk, salt) {
  const raw = sessionSubkey(psk, salt);
  return { key: await importKey(raw), nonce: new Uint8Array(12) };
}

async function seal(session, plain) {
  const iv = session.nonce.slice();
  incrementNonce(session.nonce);
  const out = await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, session.key, plain);
  return new Uint8Array(out);
}

async function open(session, cipherBytes) {
  const iv = session.nonce.slice();
  incrementNonce(session.nonce);
  try {
    const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, session.key, cipherBytes);
    return new Uint8Array(out);
  } catch {
    throw new VpnError("auth");
  }
}

export function encodeSocksAddr(host, port) {
  assertDestination(host, port);
  const portBytes = new Uint8Array(2);
  view(portBytes).setUint16(0, port);
  if (isIpv4(host)) {
    return concat(Uint8Array.of(0x01, ...host.split(".").map(Number)), portBytes);
  }
  const name = text.encode(host);
  return concat(Uint8Array.of(0x03, name.length), name, portBytes);
}

export function decodeSocksAddr(bytes) {
  if (bytes.length < 1) throw new VpnError("bad-destination");
  if (bytes[0] === 1) {
    if (bytes.length < 7) throw new VpnError("bad-destination");
    const host = `${bytes[1]}.${bytes[2]}.${bytes[3]}.${bytes[4]}`;
    return { host, port: view(bytes).getUint16(5), length: 7 };
  }
  if (bytes[0] === 3) {
    const len = bytes[1];
    if (bytes.length < 2 + len + 2) throw new VpnError("bad-destination");
    const host = utf8.decode(bytes.subarray(2, 2 + len));
    return { host, port: view(bytes).getUint16(2 + len), length: 2 + len + 2 };
  }
  throw new VpnError("bad-destination");
}

export function assertDestination(host, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new VpnError("bad-destination");
  if (typeof host !== "string" || host.length < 1 || host.length > 253) throw new VpnError("bad-destination");
  if (/[\u0000-\u0020\u007f:\\/@]/.test(host)) throw new VpnError("bad-destination");
  if (!isIpv4(host) && !/^[A-Za-z0-9.-]+$/.test(host)) throw new VpnError("bad-destination");
}

function checkTime(unixSeconds, now) {
  const skew = Math.abs(Math.floor(now() / 1000) - Number(unixSeconds));
  if (skew > 30) throw new VpnError("bad-timestamp");
}

const METHODS = {
  "2022-blake3-aes-128-gcm": 16,
  "2022-blake3-aes-256-gcm": 32,
};

export function ssKeyLength(method) {
  const n = METHODS[method];
  if (!n) throw new VpnError("bad-method");
  return n;
}

export async function encodeClientHandshake({ key, salt, host, port, payload = new Uint8Array(0), padding, now = () => Date.now() }) {
  const session = await openSession(key, salt);
  const pad = padding === undefined ? (payload.length < 900 ? (view(randomBytes(2)).getUint16(0) % 900) + 1 : 0) : padding;
  if (pad < 0 || pad > 900) throw new VpnError("bad-padding");
  const addr = encodeSocksAddr(host, port);
  const padLen = new Uint8Array(2);
  view(padLen).setUint16(0, pad);
  const variable = concat(addr, padLen, new Uint8Array(pad), payload);
  const fixed = new Uint8Array(11);
  fixed[0] = 0;
  view(fixed).setBigUint64(1, BigInt(Math.floor(now() / 1000)));
  view(fixed).setUint16(9, variable.length);
  const bytes = concat(salt, await seal(session, fixed), await seal(session, variable));
  return { bytes, session };
}

export async function readClientHandshake(reader, key, now = () => Date.now()) {
  const salt = await reader.exact(key.length);
  const session = await openSession(key, salt);
  const fixed = await open(session, await reader.exact(11 + 16));
  if (fixed[0] !== 0) throw new VpnError("bad-header");
  checkTime(view(fixed).getBigUint64(1), now);
  const varLen = view(fixed).getUint16(9);
  if (varLen < 1 || varLen > 65535 + 900) throw new VpnError("bad-header");
  const variable = await open(session, await reader.exact(varLen + 16));
  const dest = decodeSocksAddr(variable);
  if (variable.length < dest.length + 2) throw new VpnError("bad-header");
  const pad = view(variable).getUint16(dest.length);
  const rest = dest.length + 2 + pad;
  if (pad > 900 || variable.length < rest) throw new VpnError("bad-padding");
  const early = variable.slice(rest);
  if (pad === 0 && early.length === 0) throw new VpnError("bad-padding");
  return { salt, session, host: dest.host, port: dest.port, early };
}

export async function encodeServerHandshake({ key, clientSalt, serverSalt, payload = new Uint8Array(0), now = () => Date.now() }) {
  const session = await openSession(key, serverSalt);
  const fixed = new Uint8Array(1 + 8 + clientSalt.length + 2);
  fixed[0] = 1;
  view(fixed).setBigUint64(1, BigInt(Math.floor(now() / 1000)));
  fixed.set(clientSalt, 9);
  view(fixed).setUint16(9 + clientSalt.length, payload.length);
  const parts = [serverSalt, await seal(session, fixed)];
  if (payload.length) parts.push(await seal(session, payload));
  return { bytes: concat(...parts), session };
}

export async function readServerHandshake(reader, key, clientSalt, now = () => Date.now()) {
  const serverSalt = await reader.exact(key.length);
  const session = await openSession(key, serverSalt);
  const fixedLen = 1 + 8 + clientSalt.length + 2;
  const fixed = await open(session, await reader.exact(fixedLen + 16));
  if (fixed[0] !== 1) throw new VpnError("bad-header");
  checkTime(view(fixed).getBigUint64(1), now);
  const echoed = fixed.subarray(9, 9 + clientSalt.length);
  for (let i = 0; i < clientSalt.length; i++) {
    if (echoed[i] !== clientSalt[i]) throw new VpnError("bad-header");
  }
  const initialLen = view(fixed).getUint16(9 + clientSalt.length);
  if (initialLen > 65535) throw new VpnError("bad-header");
  let initial = new Uint8Array(0);
  if (initialLen > 0) initial = await open(session, await reader.exact(initialLen + 16));
  return { session, initial };
}

export async function encodeChunk(session, payload) {
  if (payload.length < 1 || payload.length > 65535) throw new VpnError("bad-chunk");
  const len = new Uint8Array(2);
  view(len).setUint16(0, payload.length);
  return concat(await seal(session, len), await seal(session, payload));
}

export async function readChunk(reader, session) {
  const lenBytes = await open(session, await reader.exact(2 + 16));
  const n = view(lenBytes).getUint16(0);
  if (n < 1 || n > 65535) throw new VpnError("bad-chunk");
  return open(session, await reader.exact(n + 16));
}

function socksReply(code) {
  return Uint8Array.of(0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0);
}

async function readSocksRequest(reader, greet) {
  const head = await reader.exact(2);
  if (head[0] !== 0x05) throw new VpnError("socks");
  const methods = await reader.exact(head[1]);
  if (!methods.includes(0x00)) throw new VpnError("socks");
  // The client waits for this reply before it sends CONNECT.
  await greet(Uint8Array.of(0x05, 0x00));
  const req = await reader.exact(4);
  if (req[0] !== 0x05) throw new VpnError("socks");
  const cmd = req[1];
  if (cmd !== 0x01) return { cmd };
  let host;
  let port;
  if (req[3] === 0x01) {
    const addr = await reader.exact(6);
    host = `${addr[0]}.${addr[1]}.${addr[2]}.${addr[3]}`;
    port = view(addr).getUint16(4);
  } else if (req[3] === 0x03) {
    const len = (await reader.exact(1))[0];
    const name = await reader.exact(len);
    const portBytes = await reader.exact(2);
    host = utf8.decode(name);
    port = view(portBytes).getUint16(0);
  } else if (req[3] === 0x04) {
    await reader.exact(18);
    throw new VpnError("bad-destination");
  } else {
    throw new VpnError("bad-destination");
  }
  assertDestination(host, port);
  return { cmd, host, port };
}

function basicToken(username, password) {
  const raw = text.encode(`${username}:${password}`);
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s);
}

export async function writeHttpConnect(node, { host, port, username, password }) {
  assertDestination(host, port);
  const token = basicToken(username, password);
  const req = text.encode(
    `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: Basic ${token}\r\n\r\n`);
  await node.write(req);
}

export async function readHttpConnect(reader) {
  const chunks = [];
  let got = 0;
  while (got < 8192) {
    const byte = await reader.exact(1);
    chunks.push(byte);
    got += 1;
    if (got >= 4) {
      const tail = chunks.slice(-4).map(b => b[0]);
      if (tail[0] === 13 && tail[1] === 10 && tail[2] === 13 && tail[3] === 10) break;
    }
  }
  if (got >= 8192) throw new VpnError("proxy-rejected");
  const header = utf8.decode(concat(...chunks));
  const status = /^HTTP\/1\.[01] (\d+)/.exec(header);
  if (!status || status[1] !== "200") throw new VpnError("proxy-rejected");
}

async function pump(read, write) {
  try {
    for (;;) {
      const chunk = await read();
      if (!chunk) return;
      await write(chunk);
    }
  } catch (err) {
    if (err?.code !== "eof") throw err;
  }
}

async function handleClient(client, node, now) {
  const reader = buffered(client);
  let replied = false;
  const fail = async code => {
    if (!replied) {
      replied = true;
      try { await client.write(socksReply(code)); } catch { /* client already gone */ }
    }
    try { client.close(); } catch { /* already closed */ }
  };
  let request;
  try {
    request = await readSocksRequest(reader, bytes => client.write(bytes));
  } catch {
    await fail(0x01);
    return;
  }
  if (request.cmd !== 0x01) {
    await fail(0x07);
    return;
  }
  let upstream;
  try {
    if (!isIpv4(node.host)) throw new VpnError("need-address");
    upstream = await node.connect({
      host: node.host,
      port: node.port,
      tls: node.tls === true,
      servername: node.servername || null,
    });
  } catch {
    await fail(0x05);
    return;
  }
  const upstreamReader = buffered(upstream);
  const shutdown = () => {
    try { client.close(); } catch { /* already closed */ }
    try { upstream.close(); } catch { /* already closed */ }
  };
  try {
    if (node.transport === "http-connect") {
      await writeHttpConnect(upstream, { host: request.host, port: request.port, username: node.username, password: node.password });
      await readHttpConnect(upstreamReader);
      replied = true;
      await client.write(socksReply(0x00));
      await Promise.all([
        pump(() => readPayload(reader), data => upstream.write(data)),
        pump(() => readPayload(upstreamReader), data => client.write(data)),
      ]);
    } else if (node.transport === "shadowsocks-2022") {
      const salt = randomBytes(node.key.length);
      const handshake = await encodeClientHandshake({
        key: node.key, salt, host: request.host, port: request.port, now,
      });
      await upstream.write(handshake.bytes);
      replied = true;
      await client.write(socksReply(0x00));
      const response = readServerHandshake(upstreamReader, node.key, salt, now);
      let serverSession = null;
      let initial = null;
      await Promise.all([
        pump(() => readPayload(reader), async data => {
          await upstream.write(await encodeChunk(handshake.session, data));
        }),
        (async () => {
          const opened = await response;
          serverSession = opened.session;
          initial = opened.initial;
          if (initial.length) await client.write(initial);
          await pump(async () => {
            try { return await readChunk(upstreamReader, serverSession); }
            catch (err) { if (err?.code === "eof") return null; throw err; }
          }, data => client.write(data));
        })(),
      ]);
    } else {
      throw new VpnError("no-supported-transport");
    }
  } catch {
    await fail(0x05);
    shutdown();
    return;
  }
  shutdown();
}

async function readPayload(reader) {
  try {
    const first = await reader.exact(1);
    const rest = reader.take();
    return rest.length ? concat(first, rest) : first;
  } catch (err) {
    if (err?.code === "eof") return null;
    throw err;
  }
}

/**
 * Listen on 127.0.0.1 and carry each SOCKS5 CONNECT to the VEIL node.
 * `listen` and `connect` are injected. `connect` is only ever called with
 * the node IP.
 */
export async function startBridge({ node, listen, connect, now = () => Date.now() }) {
  if (!node || !isIpv4(node.host)) throw new VpnError("need-address");
  if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535) throw new VpnError("bad-port");
  if (node.transport !== "http-connect" && node.transport !== "shadowsocks-2022") {
    throw new VpnError("no-supported-transport");
  }
  const bound = node.transport === "shadowsocks-2022"
    ? { ...node, connect, key: node.key }
    : { ...node, connect };
  let listener;
  listener = await listen({
    host: "127.0.0.1",
    port: 0,
    loopbackOnly: true,
    onConnection(conn) {
      handleClient(conn, bound, now).catch(() => {
        try { conn.close(); } catch { /* already closed */ }
      });
    },
  });
  if (!listener || listener.port < 1) throw new VpnError("tunnel-down");
  return {
    port: listener.port,
    close() {
      try { listener.close(); } catch { /* already closed */ }
    },
  };
}
