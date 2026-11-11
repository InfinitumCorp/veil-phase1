/* Local geo lists for VEIL.
 *
 * geoip.dat and geosite.dat are read as bytes the caller already has.
 * This module can tag a hostname or an IP literal, and, only when the user
 * has turned the setting on, it can say that a hostname is in an extra
 * ad or tracker category. Callers use that to skip a navigation.
 *
 * It does not resolve names, open a connection, or choose how traffic leaves
 * the browser. It never selects a route that leaves Tor, and it does not
 * read or write the preferences VeilAnonymityGuard watches. With the
 * setting off, decide() does not look at the lists and returns no block.
 *
 * The dat files are fetched by veil-browser/tools/fetch_geo.py into a
 * gitignored directory. They are not committed.
 */

export const SETTING_KEY = "veil.geosite.extraBlocking";
export const EXTRA_BLOCKING_DEFAULT = false;
// Same-origin paths of the local cache. Not remote addresses.
export const LOCAL_GEOIP_PATH = "/geo/geoip.dat";
export const LOCAL_GEOSITE_PATH = "/geo/geosite.dat";

// The only categories the setting may block. Country lists are not here.
export const EXTRA_BLOCK_CATEGORIES = Object.freeze([
  "category-ads",
  "category-ads-all",
  "category-ads-and-telemetry",
]);

const MAX_BYTES = 32 * 1024 * 1024;
// v2fly publishes list names in upper case. Matching is case-insensitive.
const NAME_RE = /^[a-z0-9][a-z0-9_!.-]{0,63}$/;

export class GeoDataError extends Error {
  constructor(message) {
    super(message);
    this.name = "GeoDataError";
  }
}

/** True only for an explicit on. Missing, false, and "0" stay off. */
export function extraBlockingEnabled(value) {
  return value === true || value === "1";
}

/** Read the setting. Any storage failure is off, which is the default. */
export function readExtraBlocking(storage) {
  try {
    if (!storage || typeof storage.getItem !== "function") return EXTRA_BLOCKING_DEFAULT;
    return extraBlockingEnabled(storage.getItem(SETTING_KEY));
  } catch {
    return EXTRA_BLOCKING_DEFAULT;
  }
}

function asBytes(input) {
  let bytes;
  if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else throw new GeoDataError("geo data must be bytes");
  if (bytes.length > MAX_BYTES) throw new GeoDataError("geo data is too large");
  return bytes;
}

function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 5; i++) {
    if (offset >= buf.length) throw new GeoDataError("truncated varint");
    const b = buf[offset++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new GeoDataError("integer too large");
      return [Number(result), offset];
    }
    shift += 7n;
  }
  throw new GeoDataError("varint too long");
}

function parseFields(buf) {
  const fields = [];
  let offset = 0;
  while (offset < buf.length) {
    let key;
    [key, offset] = readVarint(buf, offset);
    const field = key >> 3;
    const wire = key & 7;
    if (field <= 0) throw new GeoDataError("invalid field");
    if (wire === 0) {
      let value;
      [value, offset] = readVarint(buf, offset);
      fields.push({ field, wire, value });
    } else if (wire === 2) {
      let length;
      [length, offset] = readVarint(buf, offset);
      if (length < 0 || offset + length > buf.length) throw new GeoDataError("truncated length");
      fields.push({ field, wire, value: buf.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 5) {
      if (offset + 4 > buf.length) throw new GeoDataError("truncated fixed32");
      offset += 4;
    } else if (wire === 1) {
      if (offset + 8 > buf.length) throw new GeoDataError("truncated fixed64");
      offset += 8;
    } else {
      throw new GeoDataError("unsupported wire type");
    }
  }
  return fields;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

function decodeText(bytes) {
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw new GeoDataError("geo string is not UTF-8");
  }
}

function safeName(name) {
  if (typeof name !== "string") return null;
  const normalized = name.trim().toLowerCase();
  if (!NAME_RE.test(normalized)) return null;
  if (normalized === "direct") return null;
  return normalized;
}

function parseDomain(bytes) {
  let type = 0;
  let value = "";
  for (const field of parseFields(bytes)) {
    if (field.field === 1 && field.wire === 0) type = field.value;
    else if (field.field === 2 && field.wire === 2) value = decodeText(field.value);
  }
  if (type !== 0 && type !== 1 && type !== 2 && type !== 3) return null;
  if (!value || value.length > 512) return null;
  if (type !== 1) value = value.toLowerCase();
  return { type, value };
}

/**
 * Parse a v2fly geosite list (domain-list-community dlc.dat).
 * keep, when set, drops every other category so those names are not retained.
 */
export function parseGeoSite(input, { keep } = {}) {
  const bytes = asBytes(input);
  const keepSet = keep ? new Set(keep) : null;
  const lists = new Map();
  for (const field of parseFields(bytes)) {
    if (field.field !== 1 || field.wire !== 2) continue;
    let code = "";
    const rawDomains = [];
    for (const entry of parseFields(field.value)) {
      if (entry.field === 1 && entry.wire === 2) code = decodeText(entry.value);
      else if (entry.field === 2 && entry.wire === 2) rawDomains.push(entry.value);
    }
    const name = safeName(code);
    if (!name || (keepSet && !keepSet.has(name))) continue;
    const rules = lists.get(name) || [];
    for (const raw of rawDomains) {
      const rule = parseDomain(raw);
      if (rule) rules.push(rule);
    }
    if (rules.length) lists.set(name, rules);
  }
  return { lists };
}

function parseCidr(bytes) {
  let ip = null;
  let prefix = null;
  for (const field of parseFields(bytes)) {
    if (field.field === 1 && field.wire === 2) ip = Uint8Array.from(field.value);
    else if (field.field === 2 && field.wire === 0) prefix = field.value;
  }
  if (!ip || (ip.length !== 4 && ip.length !== 16) || !Number.isInteger(prefix)) return null;
  if (prefix < 0 || prefix > ip.length * 8) return null;
  return { ip, prefix };
}

/** Parse a v2fly geoip.dat. The result is tags only; it is not a route. */
export function parseGeoIp(input) {
  const bytes = asBytes(input);
  const entries = [];
  for (const field of parseFields(bytes)) {
    if (field.field !== 1 || field.wire !== 2) continue;
    let code = "";
    let inverse = false;
    const cidrs = [];
    for (const entry of parseFields(field.value)) {
      if (entry.field === 1 && entry.wire === 2) code = decodeText(entry.value);
      else if (entry.field === 2 && entry.wire === 2) {
        const cidr = parseCidr(entry.value);
        if (cidr) cidrs.push(cidr);
      } else if (entry.field === 3 && entry.wire === 0) inverse = entry.value !== 0;
    }
    const name = safeName(code);
    if (name && cidrs.length) entries.push({ code: name, inverse, cidrs });
  }
  return { entries };
}

function parseIp(input) {
  if (typeof input !== "string") return null;
  const value = input.trim().toLowerCase();
  if (value.includes("%")) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split(".").map(part => Number(part));
    if (parts.some(part => part > 255)) return null;
    return Uint8Array.from(parts);
  }
  if (value.includes(":") && /^[0-9a-f:]+$/.test(value)) return parseIpv6(value);
  return null;
}

function parseIpv6(value) {
  if (value.includes(":::")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const expand = part => (part ? part.split(":") : []);
  const head = expand(halves[0]);
  const tail = halves.length === 2 ? expand(halves[1]) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + tail.length > 8) return null;
  const groups = halves.length === 1
    ? head
    : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const parsed = Number.parseInt(groups[i], 16);
    out[i * 2] = parsed >> 8;
    out[i * 2 + 1] = parsed & 0xff;
  }
  return out;
}

function cidrContains(cidr, ip) {
  if (cidr.ip.length !== ip.length) return false;
  let left = cidr.prefix;
  for (let i = 0; i < ip.length && left > 0; i++) {
    const take = Math.min(8, left);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((ip[i] & mask) !== (cidr.ip[i] & mask)) return false;
    left -= take;
  }
  return true;
}

function normalizeHost(hostname) {
  if (typeof hostname !== "string") return "";
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.length > 253 || /[\s/\\]/.test(host)) return "";
  return host;
}

function regexMatches(pattern, host) {
  if (pattern.length > 128 || host.length > 253) return false;
  try {
    return new RegExp(pattern).test(host);
  } catch {
    return false;
  }
}

function ruleMatches(rule, host) {
  const value = rule.value;
  if (!value) return false;
  if (rule.type === 0) return host.includes(value);
  if (rule.type === 3) return host === value;
  if (rule.type === 2) return host === value || host.endsWith(`.${value}`);
  if (rule.type === 1) return regexMatches(value, host);
  return false;
}

function geoipTags(geoip, ipText) {
  const ip = parseIp(ipText);
  if (!ip || !geoip || !Array.isArray(geoip.entries)) return [];
  const tags = [];
  const seen = new Set();
  for (const entry of geoip.entries) {
    const name = safeName(entry.code);
    if (!name || seen.has(name)) continue;
    const inside = entry.cidrs.some(cidr => cidrContains(cidr, ip));
    const hit = entry.inverse ? !inside : inside;
    if (!hit) continue;
    seen.add(name);
    tags.push(`geoip:${name}`);
  }
  return tags;
}

/**
 * Local decision for one address the caller already has.
 * Returns { block, category, tags } and nothing else.
 * block is true only when extraBlocking is on and the hostname is in an
 * extra ad or tracker category. An IP literal may add a geoip tag. A
 * hostname that is not an IP literal is never turned into an IP here.
 */
export function decide({ hostname = "", ip = "", geosite = null, geoip = null, extraBlocking = EXTRA_BLOCKING_DEFAULT } = {}) {
  if (!extraBlockingEnabled(extraBlocking)) {
    return Object.freeze({ block: false, category: null, tags: Object.freeze([]) });
  }
  const host = normalizeHost(hostname);
  const tags = [];
  let category = null;
  if (host && geosite && geosite.lists) {
    for (const name of EXTRA_BLOCK_CATEGORIES) {
      const rules = geosite.lists.get(name);
      if (rules && rules.some(rule => ruleMatches(rule, host))) {
        tags.push(`geosite:${name}`);
        if (!category) category = name;
      }
    }
    for (const [name, rules] of geosite.lists) {
      if (EXTRA_BLOCK_CATEGORIES.includes(name) || !safeName(name)) continue;
      if (rules.some(rule => ruleMatches(rule, host))) tags.push(`geosite:${name}`);
    }
  }
  // Only an address that is already an IP literal is compared to geoip.
  const literal = parseIp(ip) ? normalizeHost(ip) : (parseIp(host) ? host : "");
  if (literal) tags.push(...geoipTags(geoip, literal));
  return Object.freeze({
    block: category !== null,
    category,
    tags: Object.freeze(tags),
  });
}
