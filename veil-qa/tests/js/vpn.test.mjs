// VEIL VPN is optional and off. These tests use a loopback mock of a VEIL
// node, so they do not need the real network. They check three things:
// the feature does nothing until veil.vpn.enabled is true, a connection
// then goes through the mock node, and destinations are not dialed or
// resolved directly.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../../..");
const vpn = await import(path.join(root, "veil-browser/src/VeilVpn.sys.mjs"));
const tunnel = await import(path.join(root, "veil-browser/src/VeilVpnTunnel.sys.mjs"));
const blake = await import(path.join(root, "veil-browser/src/VeilVpnBlake3.sys.mjs"));
const guard = await import(path.join(root, "veil-browser/src/VeilAnonymityGuard.sys.mjs"));

const {
  VeilVpnController, planEndpoint, parseServerList, leakProblems, hostAllowed,
  assertDirectoryUrl, PUBLIC_DIRECTORY, VpnError,
} = vpn;
const { startBridge, buffered, encodeClientHandshake, readClientHandshake, encodeServerHandshake, readServerHandshake, encodeChunk, readChunk } = tunnel;

const text = new TextEncoder();

const LEAK_SAFE = {
  "network.proxy.type": 1,
  "network.proxy.socks": "file:///run/user/1000/tor/socks.socket",
  "network.proxy.socks_version": 5,
  "network.proxy.socks_remote_dns": true,
  "network.proxy.failover_direct": false,
  "network.proxy.no_proxies_on": "",
  "network.trr.mode": 5,
  "network.dns.disablePrefetch": true,
  "media.peerconnection.enabled": false,
  "media.navigator.enabled": false,
};

function memPrefs(initial = {}) {
  const values = { ...initial };
  const watchers = [];
  const writes = [];
  return {
    values,
    writes,
    read: name => values[name],
    write(name, value) {
      writes.push(name);
      values[name] = value;
      for (const watcher of watchers) {
        if (name.startsWith(watcher.branch)) watcher.fn();
      }
    },
    watch(branch, fn) { watchers.push({ branch, fn }); },
    set(name, value) { this.write(name, value); },
  };
}

function torDouble() {
  return {
    current: null,
    sets: [],
    async get() { return this.current; },
    async set(proxy) { this.sets.push(proxy); this.current = proxy; },
  };
}

function wrap(socket) {
  const chunks = [];
  const waiters = [];
  let ended = false;
  const wake = () => {
    while (waiters.length) waiters.shift()();
  };
  socket.on("data", data => { chunks.push(data); wake(); });
  socket.on("end", () => { ended = true; wake(); });
  socket.on("error", () => { ended = true; wake(); });
  return {
    async readSome() {
      while (!chunks.length && !ended) await new Promise(resolve => waiters.push(resolve));
      if (!chunks.length) return null;
      return new Uint8Array(chunks.shift());
    },
    write(bytes) {
      return new Promise((resolve, reject) => {
        socket.write(Buffer.from(bytes), err => err ? reject(err) : resolve());
      });
    },
    close() { socket.destroy(); },
  };
}

function listenLoopback(log) {
  const servers = [];
  return {
    servers,
    async listen({ host, port, loopbackOnly, onConnection }) {
      log.push({ op: "listen", host, port, loopbackOnly });
      if (host !== "127.0.0.1" || loopbackOnly !== true) throw new Error("not loopback");
      const sockets = new Set();
      const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        onConnection(wrap(socket));
      });
      await new Promise(resolve => server.listen(port || 0, "127.0.0.1", resolve));
      server.unref();
      servers.push(server);
      return {
        port: server.address().port,
        close() {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      };
    },
  };
}

async function listenPort(handler) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  server.destroySockets = () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  return server;
}

function closeAll(servers) {
  for (const server of servers) {
    if (server.destroySockets) server.destroySockets();
    else server.close();
  }
}

test("BLAKE3 matches the published empty-string and abc vectors", () => {
  const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
  assert.equal(hex(blake.blake3(new Uint8Array())),
    "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262");
  assert.equal(hex(blake.blake3(text.encode("abc"))),
    "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85");
});

test("off by default does not touch Tor, sockets, or the directory", async () => {
  const log = [];
  const prefs = memPrefs({ ...LEAK_SAFE });
  const tor = torDouble();
  const controller = new VeilVpnController({
    prefs,
    tor,
    listen: async spec => { log.push(["listen", spec]); throw new Error("listen"); },
    connect: async spec => { log.push(["connect", spec]); throw new Error("connect"); },
    fetch: async url => { log.push(["fetch", url]); throw new Error("fetch"); },
  });
  await controller.start();
  assert.equal(controller.activated, false);
  assert.equal(controller.lastError, null);
  assert.deepEqual(log, []);
  assert.deepEqual(tor.sets, []);
  assert.deepEqual(prefs.writes, []);
});

test("enabled false is the same as an unset preference", async () => {
  const prefs = memPrefs({ ...LEAK_SAFE, "veil.vpn.enabled": false, "veil.vpn.password": "should-not-be-used" });
  const tor = torDouble();
  const controller = new VeilVpnController({
    prefs, tor,
    listen: async () => { throw new Error("listen"); },
    connect: async () => { throw new Error("connect"); },
  });
  await controller.start();
  assert.equal(controller.activated, false);
  assert.deepEqual(tor.sets, []);
});

test("stock Tor settings stay online when the VPN block flag is absent", () => {
  assert.deepEqual(guard.assess(name => LEAK_SAFE[name]), []);
  const blocked = guard.assess(name => ({ ...LEAK_SAFE, "veil.vpn.blocked": true }[name]));
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].pref, "veil.vpn.blocked");
});

test("the guard takes the browser offline when the tunnel reports it is down", () => {
  const values = { ...LEAK_SAFE };
  const watchers = [];
  const prefs = {
    read: name => values[name],
    watch: (branch, fn) => watchers.push({ branch, fn }),
  };
  const io = { _offline: false, manageOfflineStatus: true,
    get offline() { return this._offline; },
    set offline(v) { this._offline = v; },
    onOfflineChange() {},
  };
  const instance = new guard.Guard({ prefs, io });
  instance.start();
  assert.equal(io.offline, false);
  values["veil.vpn.blocked"] = true;
  for (const watcher of watchers) if ("veil.vpn.blocked".startsWith(watcher.branch)) watcher.fn();
  assert.equal(io.offline, true);
});

test("only VEIL node names are accepted", () => {
  assert.equal(hostAllowed("vpn-use2.infinitumveilvpn.app"), true);
  assert.equal(hostAllowed("api.infinitumveilvpn.app"), true);
  assert.equal(hostAllowed("VPN-USE2.INFINITUMVEILVPN.APP."), true);
  for (const bad of ["infinitumveilvpn.app", "evil.example", "vpn-use2.infinitumveilvpn.app.evil.com",
                     "127.0.0.1", "10.0.0.1", "localhost", "vpn gate", "a/b.infinitumveilvpn.app", ""]) {
    assert.equal(hostAllowed(bad), false, bad);
  }
  assert.equal(hostAllowed("127.0.0.1", { allowLoopback: true }), true);
});

test("the public server list is not a connectable endpoint and ignores other VPN brands", () => {
  const live = {"servers":[{"id":"use2-1","city":"Columbus","country":"United States","region":"na","load":0,"online":true,"modes":["proxy","wireguard","ikev2","openvpn"],"tor":false}]};
  const parsed = parseServerList(live);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].transport, "http-connect");
  assert.equal(parsed[0].host, "");
  assert.throws(() => planEndpoint({
    read: name => ({ "veil.vpn.directory": PUBLIC_DIRECTORY }[name]),
    directory: parsed,
  }), err => err.code === "directory-has-no-endpoint");

  const foreign = parseServerList({ servers: [{ host: "vpn.vpngate.net", modes: ["proxy"] }] });
  assert.deepEqual(foreign, []);
  const onlyWireGuard = parseServerList({
    servers: [{ host: "vpn-use2.infinitumveilvpn.app", modes: ["wireguard", "ikev2", "openvpn"] }],
  });
  assert.deepEqual(onlyWireGuard, []);
});

test("a directory entry can select Shadowsocks 2022 without dialing VLESS", () => {
  const parsed = parseServerList({
    servers: [{
      id: "use2-1",
      host: "vpn-use2.infinitumveilvpn.app",
      address: "203.0.113.10",
      modes: ["vless-reality", "shadowsocks-2022", "vless-ws"],
      transports: [
        { protocol: "vless-reality", port: 2053 },
        { protocol: "shadowsocks-2022", port: 16080, method: "2022-blake3-aes-256-gcm" },
        { protocol: "vless-ws", port: 443 },
      ],
    }],
  });
  assert.deepEqual(parsed.map(entry => entry.transport), ["shadowsocks-2022"]);
  const key = Buffer.alloc(32, 7).toString("base64");
  const plan = planEndpoint({
    read: name => ({ "veil.vpn.password": key }[name]),
    directory: parsed,
  });
  assert.equal(plan.transport, "shadowsocks-2022");
  assert.equal(plan.host, "203.0.113.10");
  assert.equal(plan.port, 16080);
  assert.equal(plan.tls, false);
  assert.equal(plan.servername, null);
  assert.equal(JSON.stringify(plan).includes(key), false);
});

test("HTTP CONNECT to a public node requires TLS, a public address, and a credential", () => {
  const directory = parseServerList({
    servers: [{ host: "vpn-use2.infinitumveilvpn.app", address: "203.0.113.10", modes: ["proxy"] }],
  });
  assert.throws(() => planEndpoint({
    read: () => undefined,
    directory,
  }), err => err.code === "no-credential");
  const plan = planEndpoint({
    read: name => ({ "veil.vpn.username": "veil", "veil.vpn.password": "returned-after-login" }[name]),
    directory,
  });
  assert.equal(plan.transport, "http-connect");
  assert.equal(plan.host, "203.0.113.10");
  assert.equal(plan.port, 443);
  assert.equal(plan.tls, true);
  assert.equal(plan.servername, "vpn-use2.infinitumveilvpn.app");
  assert.throws(() => planEndpoint({
    read: name => ({
      "veil.vpn.server": "vpn-use2.infinitumveilvpn.app",
      "veil.vpn.address": "192.168.1.9",
      "veil.vpn.username": "veil",
      "veil.vpn.password": "secret",
    }[name]),
  }), err => err.code === "address-not-public");
  assert.throws(() => planEndpoint({
    read: name => ({
      "veil.vpn.server": "vpn-use2.infinitumveilvpn.app",
      "veil.vpn.address": "203.0.113.10",
      "veil.vpn.port": 8443,
      "veil.vpn.username": "veil",
      "veil.vpn.password": "secret",
    }[name]),
  }), err => err.code === "bad-port");
});

test("directory URLs are https on a VEIL host and the servers path", () => {
  assert.equal(assertDirectoryUrl(PUBLIC_DIRECTORY), PUBLIC_DIRECTORY);
  for (const bad of [
    "http://api.infinitumveilvpn.app/v1/servers",
    "https://user:pass@api.infinitumveilvpn.app/v1/servers",
    "https://api.infinitumveilvpn.app/v1/login",
    "https://example.com/v1/servers",
  ]) {
    assert.throws(() => assertDirectoryUrl(bad), err => err instanceof VpnError);
  }
});

test("leak rules refuse WebRTC, direct fallback, and DNS prefetch before any dial", () => {
  const problems = leakProblems(name => ({ ...LEAK_SAFE, "media.peerconnection.enabled": true }[name]));
  assert.equal(problems[0].pref, "media.peerconnection.enabled");
  assert.ok(leakProblems(name => ({ ...LEAK_SAFE, "network.proxy.failover_direct": true }[name])).length);
  assert.ok(leakProblems(name => ({ ...LEAK_SAFE, "network.proxy.socks_remote_dns": false }[name])).length);
});

test("HTTP CONNECT routes through the mock node and does not dial or resolve the destination", async () => {
  const echoHits = [];
  const echo = await listenPort(socket => {
    echoHits.push(socket.remotePort);
    socket.on("data", data => socket.write(data));
  });
  const echoPort = echo.address().port;
  let connectHeader = "";
  const proxy = await listenPort(socket => {
    let buf = Buffer.alloc(0);
    const onData = data => {
      buf = Buffer.concat([buf, data]);
      const split = buf.indexOf("\r\n\r\n");
      if (split < 0) return;
      socket.off("data", onData);
      connectHeader = buf.subarray(0, split).toString("utf8");
      const target = /CONNECT ([^:\s]+):(\d+)/.exec(connectHeader);
      const auth = /Proxy-Authorization: Basic (\S+)/.exec(connectHeader);
      if (!target || !auth || auth[1] !== Buffer.from("veil:returned-after-login").toString("base64")) {
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"VEIL\"\r\n\r\n");
        return;
      }
      // The mock is the only thing that may dial the destination. It maps
      // the tunneled name itself; the browser side never resolves it.
      const rest = buf.subarray(split + 4);
      const upstream = net.connect({ host: "127.0.0.1", port: Number(target[2]) }, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) upstream.write(rest);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
    };
    socket.on("data", onData);
  });
  const lookups = [];
  const dials = [];
  const binder = listenLoopback([]);
  const prefs = memPrefs({
    ...LEAK_SAFE,
    "veil.vpn.enabled": true,
    "veil.vpn.transport": "http-connect",
    "veil.vpn.server": "127.0.0.1",
    "veil.vpn.port": proxy.address().port,
    "veil.vpn.username": "veil",
    "veil.vpn.password": "returned-after-login",
  });
  const tor = torDouble();
  const controller = new VeilVpnController({
    prefs,
    tor,
    allowLoopback: true,
    listen: spec => binder.listen(spec),
    async connect(spec) {
      dials.push({ ...spec });
      if (spec.host !== "127.0.0.1" || spec.port !== proxy.address().port) {
        lookups.push(spec.host);
        throw new Error("direct dial");
      }
      const socket = net.connect({ host: spec.host, port: spec.port });
      await once(socket, "connect");
      return wrap(socket);
    },
    fetch: async () => { throw new Error("fetch"); },
  });
  try {
    await controller.start();
    assert.equal(controller.lastError, null);
    const bridgePort = tor.sets.at(-1).port;
    assert.equal(tor.sets.at(-1).host, "127.0.0.1");
    assert.notEqual(bridgePort, proxy.address().port);
    assert.deepEqual(prefs.writes.filter(name => name.startsWith("network.")), []);

    const socket = net.connect({ host: "127.0.0.1", port: bridgePort });
    await once(socket, "connect");
    const conn = wrap(socket);
    const reader = buffered(conn);
    await conn.write(Uint8Array.of(5, 1, 0));
    assert.deepEqual([...(await reader.exact(2))], [5, 0]);
    const name = text.encode("echo.test");
    const portBytes = new Uint8Array(2);
    new DataView(portBytes.buffer).setUint16(0, echoPort);
    await conn.write(tunnel.concat(Uint8Array.of(5, 1, 0, 3, name.length), name, portBytes));
    const reply = await reader.exact(10);
    assert.equal(reply[1], 0, "SOCKS connect failed");
    await conn.write(text.encode("ping"));
    assert.equal(new TextDecoder().decode(await reader.exact(4)), "ping");
    assert.match(connectHeader, new RegExp(`CONNECT echo\\.test:${echoPort}`));
    assert.equal(dials.every(spec => spec.host === "127.0.0.1" && spec.port === proxy.address().port && spec.tls === false), true);
    assert.equal(lookups.includes("echo.test"), false);
    assert.ok(echoHits.length >= 1);
    conn.close();

    prefs.set("veil.vpn.enabled", false);
    await controller.chain;
    assert.equal(controller.activated, false);
    assert.equal(tor.current, null);
    assert.notEqual(prefs.values["veil.vpn.blocked"], true);
  } finally {
    closeAll([echo, proxy, ...binder.servers]);
  }
});

test("a refused node is not followed by a direct connection", async () => {
  const echoHits = [];
  const echo = await listenPort(socket => { echoHits.push(1); socket.end(); });
  const dials = [];
  const binder = listenLoopback([]);
  const prefs = memPrefs({
    ...LEAK_SAFE,
    "veil.vpn.enabled": true,
    "veil.vpn.server": "127.0.0.1",
    "veil.vpn.port": echo.address().port + 1,
    "veil.vpn.username": "veil",
    "veil.vpn.password": "x",
  });
  const tor = torDouble();
  const controller = new VeilVpnController({
    prefs, tor, allowLoopback: true,
    listen: spec => binder.listen(spec),
    async connect(spec) {
      dials.push(spec.host);
      throw new VpnError("tunnel-down");
    },
  });
  try {
    await controller.start();
    assert.equal(controller.lastError, null);
    const socket = net.connect({ host: "127.0.0.1", port: tor.current.port });
    await once(socket, "connect");
    const conn = wrap(socket);
    const reader = buffered(conn);
    await conn.write(Uint8Array.of(5, 1, 0));
    await reader.exact(2);
    const name = text.encode("echo.test");
    const portBytes = new Uint8Array(2);
    new DataView(portBytes.buffer).setUint16(0, echo.address().port);
    await conn.write(tunnel.concat(Uint8Array.of(5, 1, 0, 3, name.length), name, portBytes));
    const reply = await reader.exact(10);
    assert.notEqual(reply[1], 0);
    assert.deepEqual(echoHits, []);
    assert.equal(dials.every(host => host === "127.0.0.1"), true);
    assert.equal(dials.includes("echo.test"), false);
    assert.equal(prefs.values["network.proxy.type"], 1);
  } finally {
    closeAll([echo, ...binder.servers]);
  }
});

test("WebRTC or a direct-fallback pref keeps the tunnel from starting", async () => {
  const dials = [];
  const prefs = memPrefs({
    ...LEAK_SAFE,
    "veil.vpn.enabled": true,
    "media.peerconnection.enabled": true,
    "veil.vpn.server": "vpn-use2.infinitumveilvpn.app",
    "veil.vpn.address": "203.0.113.10",
    "veil.vpn.username": "veil",
    "veil.vpn.password": "secret-credential",
  });
  const tor = torDouble();
  const binder = listenLoopback([]);
  const controller = new VeilVpnController({
    prefs, tor,
    listen: spec => binder.listen(spec),
    connect: async spec => { dials.push(spec); throw new Error("no"); },
  });
  try {
    await controller.start();
    assert.equal(controller.lastError, "leak");
    assert.equal(prefs.values["veil.vpn.blocked"], true);
    assert.deepEqual(dials, []);
    assert.equal(tor.current.host, "127.0.0.1");
    assert.equal(String(controller.lastError).includes("secret-credential"), false);
  } finally {
    closeAll(binder.servers);
  }
});

test("UDP associate is refused and does not open a second socket", async () => {
  const dials = [];
  const binder = listenLoopback([]);
  const bridge = await startBridge({
    node: {
      transport: "http-connect",
      host: "127.0.0.1",
      port: 9,
      tls: false,
      username: "veil",
      password: "x",
      connect: async spec => { dials.push(spec); throw new Error("no"); },
    },
    listen: spec => binder.listen(spec),
    connect: async spec => { dials.push(spec); throw new Error("no"); },
  });
  try {
    const socket = net.connect({ host: "127.0.0.1", port: bridge.port });
    await once(socket, "connect");
    const conn = wrap(socket);
    const reader = buffered(conn);
    await conn.write(Uint8Array.of(5, 1, 0));
    await reader.exact(2);
    await conn.write(Uint8Array.of(5, 3, 0, 1, 0, 0, 0, 0, 0, 0));
    const reply = await reader.exact(10);
    assert.equal(reply[1], 0x07);
    assert.deepEqual(dials, []);
  } finally {
    bridge.close();
    closeAll(binder.servers);
  }
});

test("Shadowsocks 2022 carries the destination inside the tunnel", async () => {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  const echo = await listenPort(socket => socket.on("data", data => socket.write(data)));
  const seen = [];
  const node = await listenPort(socket => {
    const conn = wrap(socket);
    (async () => {
      const reader = buffered(conn);
      const request = await readClientHandshake(reader, key);
      seen.push(`${request.host}:${request.port}`);
      const upstream = net.connect({ host: "127.0.0.1", port: echo.address().port });
      await once(upstream, "connect");
      const up = wrap(upstream);
      const upReader = buffered(up);
      if (request.early.length) await up.write(request.early);
      let serverSession = null;
      const send = async payload => {
        if (!serverSession) {
          const salt = new Uint8Array(32);
          crypto.getRandomValues(salt);
          const handshake = await encodeServerHandshake({ key, clientSalt: request.salt, serverSalt: salt, payload });
          serverSession = handshake.session;
          await conn.write(handshake.bytes);
        } else {
          await conn.write(await encodeChunk(serverSession, payload));
        }
      };
      await Promise.all([
        (async () => {
          for (;;) {
            let chunk;
            try { chunk = await readChunk(reader, request.session); }
            catch (err) { if (err.code === "eof") return; throw err; }
            await up.write(chunk);
          }
        })(),
        (async () => {
          for (;;) {
            let payload;
            try {
              const first = await upReader.exact(1);
              const rest = upReader.take();
              payload = rest.length ? tunnel.concat(first, rest) : first;
            } catch (err) {
              if (err.code === "eof") return;
              throw err;
            }
            await send(payload);
          }
        })(),
      ]);
    })().catch(() => socket.destroy());
  });
  const dials = [];
  const binder = listenLoopback([]);
  const bridge = await startBridge({
    node: { transport: "shadowsocks-2022", host: "127.0.0.1", port: node.address().port, tls: false, key },
    listen: spec => binder.listen(spec),
    connect: async spec => {
      dials.push(spec);
      const socket = net.connect({ host: spec.host, port: spec.port });
      await once(socket, "connect");
      return wrap(socket);
    },
  });
  try {
    const socket = net.connect({ host: "127.0.0.1", port: bridge.port });
    await once(socket, "connect");
    const conn = wrap(socket);
    const reader = buffered(conn);
    await conn.write(Uint8Array.of(5, 1, 0));
    await reader.exact(2);
    const name = text.encode("secret.example");
    const portBytes = new Uint8Array(2);
    new DataView(portBytes.buffer).setUint16(0, echo.address().port);
    await conn.write(tunnel.concat(Uint8Array.of(5, 1, 0, 3, name.length), name, portBytes));
    assert.equal((await reader.exact(10))[1], 0);
    await conn.write(text.encode("veil"));
    assert.equal(new TextDecoder().decode(await reader.exact(4)), "veil");
    assert.deepEqual(seen, [`secret.example:${echo.address().port}`]);
    assert.equal(dials.every(spec => spec.host === "127.0.0.1" && spec.port === node.address().port), true);
  } finally {
    bridge.close();
    closeAll([echo, node, ...binder.servers]);
  }
});

test("in-memory Shadowsocks 2022 round trip keeps the destination and payload", async () => {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  const salt = new Uint8Array(32);
  crypto.getRandomValues(salt);
  const now = () => 1_700_000_000_000;
  const client = await encodeClientHandshake({
    key, salt, host: "guard.example", port: 443, payload: text.encode("early"), padding: 8, now,
  });
  const chunks = [client.bytes];
  const reader = {
    async exact(n) {
      while (chunks.reduce((sum, c) => sum + c.length, 0) < n) throw new VpnError("eof");
      const all = tunnel.concat(...chunks);
      chunks.length = 0;
      chunks.push(all.slice(n));
      return all.slice(0, n);
    },
  };
  const request = await readClientHandshake(reader, key, now);
  assert.equal(request.host, "guard.example");
  assert.equal(request.port, 443);
  assert.equal(new TextDecoder().decode(request.early), "early");
  const serverSalt = new Uint8Array(32);
  crypto.getRandomValues(serverSalt);
  const response = await encodeServerHandshake({ key, clientSalt: salt, serverSalt, payload: text.encode("ok"), now });
  chunks.length = 0;
  chunks.push(response.bytes);
  const opened = await readServerHandshake(reader, key, salt, now);
  assert.equal(new TextDecoder().decode(opened.initial), "ok");
});

test("a credential kept only in memory is dropped on New Identity", async () => {
  const prefs = memPrefs({
    ...LEAK_SAFE,
    "veil.vpn.enabled": true,
    "veil.vpn.server": "127.0.0.1",
    "veil.vpn.port": 9,
  });
  const tor = torDouble();
  const dials = [];
  const binder = listenLoopback([]);
  const controller = new VeilVpnController({
    prefs, tor, allowLoopback: true,
    listen: spec => binder.listen(spec),
    connect: async spec => { dials.push(spec.host); throw new VpnError("tunnel-down"); },
  });
  try {
    await controller.noteCredential({ username: "veil", password: "from-login" });
    assert.equal(controller.lastError, null);
    assert.equal(controller.activated, true);
    await controller.onNewIdentity();
    assert.equal(controller.lastError, "no-credential");
    assert.deepEqual(dials, []);
    assert.equal(prefs.values["veil.vpn.blocked"], true);
  } finally {
    closeAll(binder.servers);
  }
});

test("errors do not contain the credential", () => {
  const secret = "returned-after-login-9f3a";
  assert.throws(() => planEndpoint({
    read: name => ({
      "veil.vpn.server": "not-a-veil-host.example",
      "veil.vpn.username": "veil",
      "veil.vpn.password": secret,
    }[name]),
  }), err => err.code === "host-not-allowed" && !String(err).includes(secret) && !JSON.stringify(err).includes(secret));
});
