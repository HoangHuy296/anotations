/**
 * `crypto.randomUUID()` requires a secure context (HTTPS, or literally
 * `localhost`) — unlike `crypto.getRandomValues()`, which has no such
 * restriction. Over plain HTTP from another host on the LAN, `crypto.randomUUID`
 * is `undefined`. This uses the native method when available and otherwise
 * builds an RFC 4122 v4 UUID from `crypto.getRandomValues()` directly.
 */
export function randomUUIDAuto(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
