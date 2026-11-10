/* Optional VEIL VPN in front of Tor. Off unless veil.vpn.enabled is exactly
 * true. While it is off this module does not open a socket, fetch a directory,
 * or change Tor. While it is on, Tor's own upstream proxy is the loopback
 * tunnel and the browser's proxy stays on Tor. A down tunnel fails closed:
 * the browser is held offline and Tor is not given a direct path.
 *
 * Enable it from about:config. There is no toolbar control. See
 * veil-browser/README.md.
 */

import { startBridge, VpnError, isIpv4, ssKeyLength } from "./VeilVpnTunnel.sys.mjs";

export { VpnError };

export const ENABLED_PREF = "veil.vpn.enabled";
export const BLOCKED_PREF = "veil.vpn.blocked";
export const VEIL_NODE_SUFFIX = ".infinitumveilvpn.app";

/** Observed public directory. Contacted only when veil.vpn.directory is set to it. */
export const PUBLIC_DIRECTORY = "https://api.infinitumveilvpn.app/v1/servers";

const PREF = Object.freeze({
  enabled: ENABLED_PREF,
  transport: "veil.vpn.transport",
  server: "veil.vpn.server",
  address: "veil.vpn.address",
  port: "veil.vpn.port",
  method: "veil.vpn.method",
  username: "veil.vpn.username",
  password: "veil.vpn.password",
  directory: "veil.vpn.directory",
  blocked: BLOCKED_PREF,
});

const PUBLISHED_PORT = Object.freeze({
  "http-connect": 443,
  "shadowsocks-2022": 16080,
});

/** Firefox prefs that must stay in their Tor Browser state before the tunnel starts. */
export const LEAK_RULES = Object.freeze([
  ["network.proxy.type", v => v === 1, "the browser proxy must stay on Tor"],
  ["network.proxy.socks", v => typeof v === "string" && v.trim() !== "", "Tor's SOCKS proxy must stay configured"],
  ["network.proxy.socks_version", v => v === 5, "SOCKS version must stay 5"],
  ["network.proxy.socks_remote_dns", v => v === true, "DNS must stay inside Tor"],
  ["network.proxy.failover_direct", v => v !== true, "the browser must not fall back to a direct connection"],
  ["network.proxy.no_proxies_on", v => v === undefined || String(v).trim() === "", "no site may bypass the proxy"],
  ["network.proxy.http", v => v === undefined || v === "", "no HTTP proxy may bypass Tor"],
  ["network.proxy.ssl", v => v === undefined || v === "", "no HTTPS proxy may bypass Tor"],
  ["network.trr.mode", v => v === undefined || v === 0 || v === 5, "DNS over HTTPS must stay off"],
  ["network.dns.disablePrefetch", v => v === true, "DNS prefetch must stay off"],
  ["media.peerconnection.enabled", v => v === false, "WebRTC must stay off"],
  ["media.navigator.enabled", v => v === false, "media devices must stay off"],
]);

export function leakProblems(readPref) {
  const problems = [];
  for (const [pref, ok, why] of LEAK_RULES) {
    let value;
    try {
      value = readPref(pref);
    } catch {
      value = Symbol.for("unreadable");
    }
    let good = false;
    try {
      good = typeof value !== "symbol" && ok(value);
    } catch {
      good = false;
    }
    if (!good) problems.push({ pref, why });
  }
  return problems;
}

export function hostAllowed(host, { allowLoopback = false } = {}) {
  if (typeof host !== "string") return false;
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h === "127.0.0.1") return allowLoopback === true;
  if (!/^[a-z0-9.-]+$/.test(h) || h.includes("..") || h.startsWith(".") || h.endsWith(".") || h.includes(".-") || h.includes("-.")) {
    return false;
  }
  if (!h.endsWith(VEIL_NODE_SUFFIX)) return false;
  const label = h.slice(0, -VEIL_NODE_SUFFIX.length);
  return label.length > 0 && !label.endsWith(".");
}

export function isPublicIpv4(host) {
  if (!isIpv4(host)) return false;
  const [a, b] = host.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

const TRANSPORT_ALIAS = Object.freeze({
  proxy: "http-connect",
  "http-connect": "http-connect",
  "shadowsocks-2022": "shadowsocks-2022",
  ss2022: "shadowsocks-2022",
});

function asTransport(value) {
  if (typeof value !== "string") return null;
  return TRANSPORT_ALIAS[value.trim().toLowerCase()] || null;
}

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function decodeKey(password, method) {
  const cleaned = password.trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = cleaned.length % 4 === 0 ? cleaned : cleaned + "=".repeat((4 - (cleaned.length % 4)) % 4);
  let bin;
  try {
    bin = atob(pad);
  } catch {
    throw new VpnError("bad-key");
  }
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  if (raw.length !== ssKeyLength(method)) throw new VpnError("bad-key");
  return raw;
}

/**
 * Turn /v1/servers JSON into connectable entries. Hosts outside VEIL's own
 * suffix are dropped. WireGuard, IKEv2, OpenVPN, VLESS and any other mode
 * are ignored. A live entry that names no host is returned with host "" so
 * the caller can see the directory without dialing it.
 */
export function parseServerList(json, { allowLoopback = false } = {}) {
  const rows = Array.isArray(json) ? json : json?.servers || json?.nodes;
  if (!Array.isArray(rows)) throw new VpnError("directory");
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const host = str(row.host || row.hostname);
    if (host && !hostAllowed(host, { allowLoopback })) continue;
    const address = str(row.address || row.ip);
    if (address && !isIpv4(address)) continue;
    const modes = [];
    if (Array.isArray(row.modes)) modes.push(...row.modes);
    if (Array.isArray(row.transports)) {
      for (const t of row.transports) modes.push(t?.protocol || t?.mode || t);
    }
    if (row.shadowsocks2022 || row.shadowsocks_2022) modes.push("shadowsocks-2022");
    if (row.proxy) modes.push("proxy");
    const supported = [];
    for (const mode of modes) {
      const name = asTransport(typeof mode === "string" ? mode : mode?.protocol);
      if (!name || supported.includes(name)) continue;
      const fromRow = typeof mode === "object" && mode ? mode : null;
      const nested = name === "shadowsocks-2022" ? (row.shadowsocks2022 || row.shadowsocks_2022) : row.proxy;
      const port = Number(fromRow?.port ?? nested?.port ?? (name === "http-connect" ? row.proxyPort : row.ssPort) ?? 0);
      const method = str(fromRow?.method || nested?.method || "");
      supported.push(name);
      out.push({
        id: str(row.id),
        host,
        address,
        transport: name,
        port: Number.isInteger(port) && port > 0 ? port : PUBLISHED_PORT[name],
        method: method || (name === "shadowsocks-2022" ? "2022-blake3-aes-256-gcm" : ""),
      });
    }
  }
  return out;
}

export function chooseTransport(entries, requested) {
  const want = asTransport(requested);
  if (want) return entries.find(e => e.transport === want) || null;
  return entries.find(e => e.transport === "shadowsocks-2022")
    || entries.find(e => e.transport === "http-connect")
    || null;
}

export function assertDirectoryUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new VpnError("directory");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new VpnError("directory");
  if (url.pathname !== "/v1/servers") throw new VpnError("directory");
  if (!hostAllowed(url.hostname)) throw new VpnError("directory");
  return url.toString();
}

/**
 * Decide the single node the tunnel may dial. Throws VpnError (a code, never
 * the credential) instead of substituting a direct connection.
 */
export function planEndpoint({ read, directory = null, allowLoopback = false, credential = null }) {
  let server = str(read(PREF.server));
  let address = str(read(PREF.address));
  let transport = str(read(PREF.transport));
  let port = read(PREF.port);
  let method = str(read(PREF.method)) || "2022-blake3-aes-256-gcm";
  const username = credential?.username ?? str(read(PREF.username));
  const password = credential?.password ?? str(read(PREF.password));

  if (!server && directory) {
    const withHost = directory.filter(entry => entry.host);
    if (!withHost.length) throw new VpnError("directory-has-no-endpoint");
    const choice = chooseTransport(withHost, transport);
    if (!choice) throw new VpnError("no-supported-transport");
    server = choice.host;
    if (!address) address = choice.address;
    if (!transport) transport = choice.transport;
    if (port === undefined || port === 0 || port === "") port = choice.port;
    if (choice.method) method = choice.method;
  }
  if (!transport) transport = "http-connect";
  transport = asTransport(transport);
  if (!transport) throw new VpnError("no-supported-transport");
  if (!hostAllowed(server, { allowLoopback })) throw new VpnError("host-not-allowed");

  if (port === undefined || port === 0 || port === "") port = PUBLISHED_PORT[transport];
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new VpnError("bad-port");
  const loopback = allowLoopback && (address === "127.0.0.1" || (!address && server === "127.0.0.1"));
  if (!loopback && port !== PUBLISHED_PORT[transport]) throw new VpnError("bad-port");

  const connectHost = address || (isIpv4(server) ? server : "");
  if (!isIpv4(connectHost)) throw new VpnError("need-address");
  if (!(allowLoopback && connectHost === "127.0.0.1") && !isPublicIpv4(connectHost)) {
    throw new VpnError("address-not-public");
  }

  if (transport === "http-connect") {
    if (!username || !password) throw new VpnError("no-credential");
    if (/[\r\n:]/.test(username) || /[\r\n]/.test(password)) throw new VpnError("bad-credential");
    return {
      transport, host: connectHost, port,
      tls: connectHost !== "127.0.0.1",
      servername: isIpv4(server) ? null : server,
      username, password,
    };
  }
  const key = decodeKey(password, method);
  return {
    transport, host: connectHost, port, tls: false, servername: null,
    method, key, username: "", password: "",
  };
}

export class VeilVpnController {
  constructor({ prefs, tor, listen, connect, fetch: fetchImpl = null, allowLoopback = false, now = () => Date.now() }) {
    this.prefs = prefs;
    this.tor = tor;
    this.listen = listen;
    this.connect = connect;
    this.fetchImpl = fetchImpl;
    this.allowLoopback = allowLoopback === true;
    this.now = now;
    this.generation = 0;
    this.chain = Promise.resolve();
    this.bridge = null;
    this.seal = null;
    this.savedTor = undefined;
    this.activated = false;
    this.blockedByUs = false;
    this.memoryCredential = null;
    this.lastError = null;
    this.silent = false;
  }

  start() {
    this.prefs.watch("veil.vpn.", () => {
      if (!this.silent) this.kick();
    });
    return this.kick();
  }

  noteCredential(credential) {
    this.memoryCredential = credential && typeof credential === "object" ? {
      username: str(credential.username),
      password: typeof credential.password === "string" ? credential.password : "",
    } : null;
    return this.kick();
  }

  onNewIdentity() {
    this.memoryCredential = null;
    return this.kick();
  }

  kick() {
    const gen = ++this.generation;
    this.chain = this.chain.then(() => this.#sync(gen)).catch(() => {});
    return this.chain;
  }

  async #sync(gen) {
    if (this.prefs.read(PREF.enabled) !== true) {
      await this.#shutdown();
      return;
    }
    if (leakProblems(name => this.prefs.read(name)).length) {
      await this.#failClosed(gen, "leak");
      return;
    }
    let directory = null;
    const directoryUrl = str(this.prefs.read(PREF.directory));
    if (directoryUrl) {
      try {
        directory = await this.#directory(directoryUrl);
      } catch (err) {
        await this.#failClosed(gen, err?.code || "directory");
        return;
      }
    }
    if (gen !== this.generation) return;
    let endpoint;
    try {
      endpoint = planEndpoint({
        read: name => this.prefs.read(name),
        directory,
        allowLoopback: this.allowLoopback,
        credential: this.memoryCredential,
      });
    } catch (err) {
      await this.#failClosed(gen, err?.code || "config");
      return;
    }
    if (gen !== this.generation) return;
    try {
      await this.#closeBridge();
      const bridge = await startBridge({
        node: { ...endpoint, connect: spec => this.connect(spec) },
        listen: this.listen,
        connect: this.connect,
        now: this.now,
      });
      if (gen !== this.generation) {
        bridge.close();
        return;
      }
      this.bridge = bridge;
      await this.#rememberTor();
      await this.tor.set({ host: "127.0.0.1", port: bridge.port, type: 1, username: "", password: "" });
      await this.#closeSeal();
      this.#setBlocked(false);
      this.activated = true;
      this.lastError = null;
    } catch (err) {
      await this.#failClosed(gen, err?.code || "tunnel-down");
    }
  }

  async #directory(url) {
    assertDirectoryUrl(url);
    if (!this.fetchImpl) throw new VpnError("directory");
    const response = await this.fetchImpl(url, {
      redirect: "error",
      headers: { accept: "application/json" },
    });
    if (!response?.ok) throw new VpnError("directory");
    const body = await response.text();
    if (typeof body !== "string" || body.length > 1_000_000) throw new VpnError("directory");
    return parseServerList(JSON.parse(body), { allowLoopback: this.allowLoopback });
  }

  async #failClosed(gen, code) {
    if (gen !== this.generation) return;
    await this.#closeBridge();
    this.lastError = code;
    this.#setBlocked(true);
    await this.#rememberTor();
    if (!this.seal) {
      try {
        this.seal = await this.listen({
          host: "127.0.0.1",
          port: 0,
          loopbackOnly: true,
          onConnection(conn) {
            try { conn.close(); } catch { /* drop */ }
          },
        });
      } catch {
        this.seal = null;
      }
    }
    if (gen !== this.generation) return;
    await this.tor.set({
      host: "127.0.0.1",
      port: this.seal?.port || 9,
      type: 1,
      username: "",
      password: "",
    });
    this.activated = true;
  }

  async #shutdown() {
    if (!this.activated && this.savedTor === undefined && !this.bridge && !this.seal) return;
    await this.#closeBridge();
    await this.#closeSeal();
    if (this.savedTor !== undefined) {
      await this.tor.set(this.savedTor);
      this.savedTor = undefined;
    }
    this.#setBlocked(false);
    this.activated = false;
    this.lastError = null;
  }

  async #rememberTor() {
    if (this.savedTor === undefined) this.savedTor = await this.tor.get();
  }

  async #closeBridge() {
    if (!this.bridge) return;
    try { this.bridge.close(); } catch { /* already closed */ }
    this.bridge = null;
  }

  async #closeSeal() {
    if (!this.seal) return;
    try { this.seal.close(); } catch { /* already closed */ }
    this.seal = null;
  }

  #setBlocked(on) {
    const current = this.prefs.read(PREF.blocked);
    this.silent = true;
    try {
      if (on) {
        if (current !== true) this.prefs.write(PREF.blocked, true);
        this.blockedByUs = true;
        return;
      }
      if (this.blockedByUs && current === true) this.prefs.write(PREF.blocked, false);
      this.blockedByUs = false;
    } finally {
      this.silent = false;
    }
  }
}

function readBrowserPref(name) {
  const S = globalThis.Services;
  switch (S.prefs.getPrefType(name)) {
    case S.prefs.PREF_INT: return S.prefs.getIntPref(name);
    case S.prefs.PREF_BOOL: return S.prefs.getBoolPref(name);
    case S.prefs.PREF_STRING: return S.prefs.getStringPref(name);
    default: return undefined;
  }
}

function writeBrowserPref(name, value) {
  const S = globalThis.Services;
  if (typeof value === "boolean") S.prefs.setBoolPref(name, value);
  else if (typeof value === "number") S.prefs.setIntPref(name, value);
  else S.prefs.setStringPref(name, String(value));
}

function firefoxListen({ host, port, loopbackOnly, onConnection }) {
  if (host !== "127.0.0.1" || loopbackOnly !== true) throw new VpnError("not-loopback");
  const { Cc, Ci } = globalThis;
  const socket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
  socket.init(port > 0 ? port : 0, true, -1);
  socket.asyncListen({
    onSocketAccepted(_server, transport) {
      try {
        onConnection(xpcomConnection(transport));
      } catch {
        try { transport.close(globalThis.Cr.NS_BINDING_ABORTED); } catch { /* already closed */ }
      }
    },
    onStopListening() {},
  });
  return { port: socket.port, close() { try { socket.close(); } catch { /* already closed */ } } };
}

function xpcomConnection(transport) {
  const { Cc, Ci, Cr, Services } = globalThis;
  const input = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
  const output = transport.openOutputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncOutputStream);
  const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
  binary.setInputStream(input);
  let buf = new Uint8Array(0);
  let eof = false;
  const waiters = [];
  const pump = {
    onInputStreamReady(stream) {
      try {
        const n = stream.available();
        const bytes = new Uint8Array(binary.readByteArray(n));
        const merged = new Uint8Array(buf.length + bytes.length);
        merged.set(buf, 0);
        merged.set(bytes, buf.length);
        buf = merged;
        wake();
        stream.asyncWait(pump, 0, 0, Services.tm.currentThread);
      } catch (err) {
        if (err?.result === Cr.NS_BASE_STREAM_WOULD_BLOCK) {
          stream.asyncWait(pump, 0, 0, Services.tm.currentThread);
          return;
        }
        eof = true;
        wake();
      }
    },
  };
  input.asyncWait(pump, 0, 0, Services.tm.currentThread);
  function wake() {
    while (waiters.length && (buf.length || eof)) waiters.shift()();
  }
  return {
    readSome() {
      if (buf.length) {
        const out = buf;
        buf = new Uint8Array(0);
        return Promise.resolve(out);
      }
      if (eof) return Promise.resolve(null);
      return new Promise(resolve => {
        waiters.push(() => {
          if (buf.length) {
            const out = buf;
            buf = new Uint8Array(0);
            resolve(out);
          } else resolve(null);
        });
      });
    },
    write(bytes) {
      const raw = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream);
      raw.setOutputStream(output);
      raw.writeByteArray([...bytes], bytes.length);
      return Promise.resolve();
    },
    close() {
      try { transport.close(Cr.NS_OK); } catch { /* already closed */ }
    },
  };
}

async function firefoxConnect({ host, port, tls, servername }) {
  if (!isIpv4(host)) throw new VpnError("need-address");
  const { Cc, Ci, Services } = globalThis;
  const sts = Cc["@mozilla.org/network/socket-transport-service;1"].getService(Ci.nsISocketTransportService);
  let pinned = null;
  if (tls) {
    if (!servername) throw new VpnError("need-servername");
    const override = Cc["@mozilla.org/network/native-dns-override;1"].getService(Ci.nsINativeDNSResolverOverride);
    override.addIPOverride(servername, host);
    pinned = servername;
  }
  try {
    const transport = sts.createTransport(tls ? ["ssl"] : [], tls ? servername : host, port, null, null);
    await new Promise((resolve, reject) => {
      transport.setEventSink({
        onTransportStatus(_t, status) {
          if (status === Ci.nsISocketTransport.STATUS_CONNECTED_TO) resolve();
        },
      }, Services.tm.currentThread);
      const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      timer.initWithCallback(() => reject(new VpnError("tunnel-down")), 15000, Ci.nsITimer.TYPE_ONE_SHOT);
    });
    return xpcomConnection(transport);
  } finally {
    if (pinned) {
      try {
        Cc["@mozilla.org/network/native-dns-override;1"].getService(Ci.nsINativeDNSResolverOverride).clearHostOverride(pinned);
      } catch { /* the connected socket already has the address */ }
    }
  }
}

function firefoxTor() {
  let mod = null;
  async function ready() {
    if (!mod) mod = ChromeUtils.importESModule("resource://gre/modules/TorSettings.sys.mjs");
    const { TorSettings, TorSettingsTopics } = mod;
    if (!TorSettings.initialized) {
      await new Promise(resolve => {
        const obs = {
          observe() {
            globalThis.Services.obs.removeObserver(obs, TorSettingsTopics.Ready);
            resolve();
          },
        };
        globalThis.Services.obs.addObserver(obs, TorSettingsTopics.Ready);
        if (TorSettings.initialized) {
          globalThis.Services.obs.removeObserver(obs, TorSettingsTopics.Ready);
          resolve();
        }
      });
    }
    return mod;
  }
  return {
    async get() {
      const { TorSettings } = await ready();
      const proxy = TorSettings.getSettings().proxy;
      if (!proxy?.enabled) return null;
      return {
        host: proxy.address,
        port: proxy.port,
        type: proxy.type,
        username: proxy.username || "",
        password: proxy.password || "",
      };
    },
    async set(proxy) {
      const { TorSettings, TorProxyType } = await ready();
      if (!proxy) {
        await TorSettings.changeSettings({ proxy: { enabled: false } });
        return;
      }
      await TorSettings.changeSettings({
        proxy: {
          enabled: true,
          type: proxy.type ?? TorProxyType.Socks5,
          address: proxy.host,
          port: proxy.port,
          username: proxy.username || "",
          password: proxy.password || "",
        },
      });
    },
  };
}

/** Browser entry. A no-op until veil.vpn.enabled is true. */
export const VeilVpn = {
  _controller: null,

  init() {
    if (this._controller || !globalThis.Services || !globalThis.Cc || !globalThis.ChromeUtils) return this._controller;
    const prefs = {
      read: readBrowserPref,
      write: writeBrowserPref,
      watch(branch, fn) {
        globalThis.Services.prefs.addObserver(branch, { observe: () => fn() });
      },
    };
    this._controller = new VeilVpnController({
      prefs,
      tor: firefoxTor(),
      listen: firefoxListen,
      connect: firefoxConnect,
      fetch: (url, init) => globalThis.fetch(url, init),
      allowLoopback: false,
    });
    this._controller.start();
    return this._controller;
  },

  onNewIdentity() {
    return this._controller?.onNewIdentity();
  },
};
