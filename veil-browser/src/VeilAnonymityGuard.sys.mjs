/* VEIL anonymity guard: VEIL is always anonymous.
 *
 * VEIL has one workspace and every connection goes over Tor. This module
 * makes that a hard guarantee instead of a default: at startup, and every
 * time a network setting changes, it checks the settings that decide
 * whether traffic can leave without Tor. If any of them is unsafe, VEIL
 * goes offline (fail closed) and stays offline until the settings are safe
 * again. It never "fixes" a setting by guessing a value, because Tor
 * Browser chooses those values (for example a Unix socket path for SOCKS on
 * Linux and macOS) and VEIL must match stock Tor Browser exactly.
 *
 * It changes nothing a website can observe: it only reads preferences and
 * toggles the browser's offline state.
 *
 * veil.vpn.blocked is unset unless the optional VEIL VPN tunnel is on and
 * not actually up. An absent or false value leaves this guard exactly as
 * strict as Tor-only VEIL: startup with stock Tor Browser proxy settings
 * stays online.
 *
 * Installed by patch 0003 ([network]); loaded from BrowserGlue at startup:
 *   import { VeilAnonymityGuard } from "moz-src:///browser/components/veil/VeilAnonymityGuard.sys.mjs";
 *   VeilAnonymityGuard.init();
 */

// Each rule names one preference and says what a safe value is. All of
// these are standard Firefox network preferences that stock Tor Browser
// already sets to the safe value.
export const RULES = Object.freeze([
  {
    pref: "network.proxy.type",
    ok: v => v === 1,
    why: "the proxy must be set manually to Tor (type 1)",
  },
  {
    pref: "network.proxy.socks",
    ok: v => typeof v === "string" && v.trim() !== "",
    why: "a Tor SOCKS proxy must be configured",
  },
  {
    pref: "network.proxy.socks_version",
    ok: v => v === 5,
    why: "SOCKS version must be 5",
  },
  {
    pref: "network.proxy.socks_remote_dns",
    ok: v => v === true,
    why: "DNS lookups must go through Tor",
  },
  {
    pref: "network.proxy.failover_direct",
    ok: v => v === false || v === undefined,
    why: "the browser must never fall back to a direct connection",
  },
  {
    pref: "network.proxy.http",
    ok: v => v === undefined || v === "",
    why: "no HTTP proxy may bypass Tor",
  },
  {
    pref: "network.proxy.ssl",
    ok: v => v === undefined || v === "",
    why: "no HTTPS proxy may bypass Tor",
  },
  {
    pref: "network.proxy.no_proxies_on",
    ok: v => v === undefined || v.trim() === "",
    why: "no site may be excluded from Tor",
  },
  {
    pref: "network.trr.mode",
    // 0 = default (off in Tor Browser), 5 = off by choice. 1-3 would send
    // DNS over HTTPS outside the SOCKS proxy's DNS path.
    ok: v => v === undefined || v === 0 || v === 5,
    why: "DNS over HTTPS must stay off; Tor resolves names",
  },
  {
    pref: "veil.vpn.blocked",
    // Only the VPN controller sets this, and only while the feature is on
    // but the tunnel is not. Unset is the normal Tor-only browser.
    ok: v => v !== true,
    why: "VEIL VPN was requested but its tunnel is not up, so traffic must not leave",
  },
]);

const WATCHED_BRANCHES = ["network.proxy.", "network.trr.", "veil.vpn."];
export const BLOCKED_TOPIC = "veil-anonymity-blocked";
export const RESTORED_TOPIC = "veil-anonymity-restored";

/** Check every rule. Returns a list of {pref, value, why} problems (empty = safe). */
export function assess(readPref) {
  const problems = [];
  for (const rule of RULES) {
    let value;
    try {
      value = readPref(rule.pref);
    } catch {
      value = Symbol.for("unreadable");
    }
    let ok = false;
    try {
      ok = typeof value !== "symbol" && rule.ok(value);
    } catch {
      ok = false;
    }
    if (!ok) {
      problems.push({ pref: rule.pref, value: typeof value === "symbol" ? null : value, why: rule.why });
    }
  }
  return problems;
}

/**
 * The guard itself, written against small injected interfaces so it can be
 * tested outside the browser:
 *   prefs.read(name)            -> value or undefined
 *   prefs.watch(branch, fn)     -> calls fn() when any pref under branch changes
 *   io.offline                  -> get/set the browser's offline state
 *   io.manageOfflineStatus      -> get/set automatic online/offline switching
 *   io.onOfflineChange(fn)      -> calls fn() when the offline state changes
 *   notify(topic, problems)     -> tell the UI (status line, notification bar)
 */
export class Guard {
  constructor({ prefs, io, notify = () => {} }) {
    this.prefs = prefs;
    this.io = io;
    this.notify = notify;
    this.blocked = false;
    this.problems = [];
    this.savedManageOffline = null;
  }

  start() {
    for (const branch of WATCHED_BRANCHES) this.prefs.watch(branch, () => this.check());
    // If something brings the browser back online while settings are still
    // unsafe, take it offline again.
    this.io.onOfflineChange(() => {
      if (this.blocked && !this.io.offline) this.enforce();
    });
    this.check();
  }

  check() {
    this.problems = assess(name => this.prefs.read(name));
    if (this.problems.length) {
      const wasBlocked = this.blocked;
      this.blocked = true;
      this.enforce();
      if (!wasBlocked) this.notify(BLOCKED_TOPIC, this.problems);
    } else if (this.blocked) {
      this.blocked = false;
      this.release();
      this.notify(RESTORED_TOPIC, []);
    }
    return this.problems;
  }

  enforce() {
    if (this.savedManageOffline === null) this.savedManageOffline = this.io.manageOfflineStatus;
    this.io.manageOfflineStatus = false;
    this.io.offline = true;
  }

  release() {
    this.io.offline = false;
    if (this.savedManageOffline !== null) {
      this.io.manageOfflineStatus = this.savedManageOffline;
      this.savedManageOffline = null;
    }
  }
}

/** Browser glue: wires Guard to Firefox's Services. Only runs inside VEIL. */
export const VeilAnonymityGuard = {
  _guard: null,

  init() {
    if (this._guard) return this._guard;
    const S = globalThis.Services;
    const prefs = {
      read(name) {
        switch (S.prefs.getPrefType(name)) {
          case S.prefs.PREF_INT: return S.prefs.getIntPref(name);
          case S.prefs.PREF_BOOL: return S.prefs.getBoolPref(name);
          case S.prefs.PREF_STRING: return S.prefs.getStringPref(name);
          default: return undefined;
        }
      },
      watch(branch, fn) {
        S.prefs.addObserver(branch, { observe: () => fn() });
      },
    };
    const io = {
      get offline() { return S.io.offline; },
      set offline(v) { S.io.offline = v; },
      get manageOfflineStatus() { return S.io.manageOfflineStatus; },
      set manageOfflineStatus(v) { S.io.manageOfflineStatus = v; },
      onOfflineChange(fn) {
        S.obs.addObserver({ observe: () => fn() }, "network:offline-status-changed");
      },
    };
    const notify = (topic, problems) =>
      S.obs.notifyObservers(null, topic, JSON.stringify(problems));
    this._guard = new Guard({ prefs, io, notify });
    this._guard.start();
    return this._guard;
  },
};
