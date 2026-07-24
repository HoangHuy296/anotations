import { isIP } from "node:net";
import { lookup as lookupCallback } from "node:dns/promises";

export type SourceAccessFailure =
  | "SOURCE_URL_UNSAFE"
  | "SOURCE_DESTINATION_NOT_ALLOWED"
  | "SOURCE_ROOT_PATH_UNSAFE"
  | "SOURCE_IMPORT_LIMIT_EXCEEDED";

export type SourceAccessResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SourceAccessFailure };

export type SourceAccessPolicy = {
  allowedIpCidrs: readonly string[];
  trustedTestHosts: readonly string[];
  maxRootDepth: number;
  maxRootLength: number;
  maxItems: number;
  maxDeclaredBytes: number;
  maxDurationMs: number;
};

type DnsLookup = (hostname: string) => Promise<readonly string[]>;

const DEFAULTS = {
  maxRootDepth: 32,
  maxRootLength: 1024,
  maxItems: 2000,
  maxDeclaredBytes: 5 * 1024 * 1024 * 1024,
  maxDurationMs: 30 * 60 * 1000,
} as const;

function finiteInteger(value: string | undefined, fallback: number, min: number, max: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function csv(value: string | undefined) {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

/** Deployment policy only; browser input never reaches this constructor. */
export function readSourceAccessPolicy(environment: NodeJS.ProcessEnv = process.env): SourceAccessPolicy {
  const testMode = environment.NODE_ENV !== "production" && environment.SOURCE_CONNECTION_TEST_MODE === "1";
  return {
    allowedIpCidrs: csv(environment.SOURCE_ALLOWED_IP_CIDRS),
    trustedTestHosts: testMode ? csv(environment.SOURCE_TRUSTED_TEST_HOSTS).map((host) => host.toLowerCase()) : [],
    maxRootDepth: finiteInteger(environment.SOURCE_MAX_ROOT_DEPTH, DEFAULTS.maxRootDepth, 1, 128),
    maxRootLength: finiteInteger(environment.SOURCE_MAX_ROOT_LENGTH, DEFAULTS.maxRootLength, 1, 4096),
    maxItems: finiteInteger(environment.SOURCE_MAX_IMPORT_ITEMS, DEFAULTS.maxItems, 1, 100_000),
    maxDeclaredBytes: finiteInteger(environment.SOURCE_MAX_DECLARED_BYTES, DEFAULTS.maxDeclaredBytes, 1, Number.MAX_SAFE_INTEGER),
    maxDurationMs: finiteInteger(environment.SOURCE_MAX_DURATION_MS, DEFAULTS.maxDurationMs, 1_000, 24 * 60 * 60 * 1000),
  };
}

function ipv4Number(value: string) {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

export function isAllowedNumericIp(address: string, allowedCidrs: readonly string[]) {
  if (isIP(address) !== 4) return false;
  const candidate = ipv4Number(address);
  if (candidate === null) return false;
  return allowedCidrs.some((entry) => {
    const [network, prefixValue] = entry.split("/");
    const prefix = prefixValue === undefined ? 32 : Number(prefixValue);
    const base = ipv4Number(network ?? "");
    if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (candidate & mask) === (base & mask);
  });
}

export function isProhibitedAddress(address: string) {
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff");
  }
  const value = ipv4Number(address);
  if (value === null) return true;
  const first = value >>> 24;
  const second = (value >>> 16) & 0xff;
  return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || first >= 224;
}

async function defaultLookup(hostname: string) {
  const records = await lookupCallback(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/**
 * Test-only deterministic DNS. It is enabled only outside production with the
 * existing source test mode, and is supplied by server process environment —
 * never by a browser request. A value of `!ERROR` models a resolver failure.
 */
function configuredTestLookup(environment: NodeJS.ProcessEnv = process.env): DnsLookup | null {
  if (
    environment.NODE_ENV === "production"
    || environment.REPOSITORY_PREFLIGHT_INTEGRATION_TESTS !== "1"
    || environment.SOURCE_CONNECTION_TEST_MODE !== "1"
  ) return null;
  const raw = environment.SOURCE_TEST_DNS_OVERRIDES;
  if (!raw || raw.length > 8_192) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = new Map<string, readonly string[]>();
    for (const [hostname, addresses] of Object.entries(parsed)) {
      if (!/^[a-z0-9.-]{1,253}$/i.test(hostname) || !Array.isArray(addresses) || addresses.length > 8 || !addresses.every((address) => typeof address === "string" && (address === "!ERROR" || isIP(address) !== 0))) return null;
      entries.set(hostname.toLowerCase(), addresses);
    }
    return async (hostname) => {
      const addresses = entries.get(hostname.toLowerCase());
      if (!addresses || addresses.includes("!ERROR")) throw new Error("test DNS lookup failed");
      return addresses;
    };
  } catch {
    return null;
  }
}

export async function validateSourceBaseUrl(
  rawValue: string,
  policy: SourceAccessPolicy = readSourceAccessPolicy(),
  lookup?: DnsLookup,
): Promise<SourceAccessResult<URL>> {
  let url: URL;
  try { url = new URL(rawValue.trim()); } catch { return { ok: false, code: "SOURCE_URL_UNSAFE" }; }
  if (!url.hostname || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return { ok: false, code: "SOURCE_URL_UNSAFE" };
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") return { ok: false, code: "SOURCE_URL_UNSAFE" };
  const host = url.hostname.toLowerCase();
  if (isIP(host)) return isAllowedNumericIp(host, policy.allowedIpCidrs) ? { ok: true, value: url } : { ok: false, code: "SOURCE_DESTINATION_NOT_ALLOWED" };
  if (policy.trustedTestHosts.includes(host)) return { ok: true, value: url };
  try {
    const addresses = await (lookup ?? configuredTestLookup() ?? defaultLookup)(host);
    if (!addresses.length || addresses.some((address) => isProhibitedAddress(address))) return { ok: false, code: "SOURCE_DESTINATION_NOT_ALLOWED" };
  } catch { return { ok: false, code: "SOURCE_DESTINATION_NOT_ALLOWED" }; }
  return { ok: true, value: url };
}

export function normalizeSourceRootPath(rawValue: string, policy: SourceAccessPolicy = readSourceAccessPolicy()): SourceAccessResult<string> {
  if (rawValue.includes("\0") || rawValue.length > policy.maxRootLength || rawValue.startsWith("/") || rawValue.startsWith("\\") || /^[A-Za-z]:/.test(rawValue) || rawValue.startsWith("//")) return { ok: false, code: "SOURCE_ROOT_PATH_UNSAFE" };
  const normalized = rawValue.replaceAll("\\", "/").split("/");
  if (normalized.some((segment) => !segment || segment === "." || segment === ".." || /[\x00-\x1f]/.test(segment)) || normalized.length > policy.maxRootDepth) return rawValue === "" ? { ok: true, value: "" } : { ok: false, code: "SOURCE_ROOT_PATH_UNSAFE" };
  return { ok: true, value: normalized.join("/") };
}

export function validateSourceImportLimits(input: { itemCount: number; declaredBytes: number; durationMs?: number }, policy: SourceAccessPolicy = readSourceAccessPolicy()): SourceAccessResult<undefined> {
  if (!Number.isSafeInteger(input.itemCount) || input.itemCount < 0 || input.itemCount > policy.maxItems || !Number.isSafeInteger(input.declaredBytes) || input.declaredBytes < 0 || input.declaredBytes > policy.maxDeclaredBytes || (input.durationMs !== undefined && (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > policy.maxDurationMs))) return { ok: false, code: "SOURCE_IMPORT_LIMIT_EXCEEDED" };
  return { ok: true, value: undefined };
}
