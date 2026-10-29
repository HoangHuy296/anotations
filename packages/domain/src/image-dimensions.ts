export type ImageDimensions = { width: number; height: number };

const MAX_DIMENSION = 1_000_000;
const valid = (width: number, height: number): ImageDimensions | null =>
  Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION ? { width, height } : null;

function png(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return valid(view.getUint32(16), view.getUint32(20));
}

/** JPEG: walk the marker segments to the first start-of-frame (SOF0..SOF15 except DHT/JPG/DAC). */
function jpeg(bytes: Uint8Array): ImageDimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 2;
  while (position + 4 <= bytes.length) {
    if (bytes[position] !== 0xff) return null;
    const marker = bytes[position + 1]!;
    if (marker === 0xff) { position += 1; continue; } // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { position += 2; continue; } // no length
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan before any frame header
    const length = view.getUint16(position + 2);
    if (length < 2) return null;
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (position + 9 > bytes.length) return null;
      return valid(view.getUint16(position + 7), view.getUint16(position + 5));
    }
    position += 2 + length;
  }
  return null;
}

function webp(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 30) return null;
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  const u16 = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8);
  const u24 = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
  if (chunk === "VP8 ") {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return valid(u16(26) & 0x3fff, u16(28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (bytes[20] !== 0x2f) return null;
    const width = 1 + (((bytes[22]! & 0x3f) << 8) | bytes[21]!);
    const height = 1 + (((bytes[24]! & 0x0f) << 10) | (bytes[23]! << 2) | ((bytes[22]! & 0xc0) >> 6));
    return valid(width, height);
  }
  if (chunk === "VP8X") return valid(1 + u24(24), 1 + u24(27));
  return null;
}

/**
 * Pixel size of a PNG, JPEG or WebP read from a bounded header prefix, or null when the prefix is not one of those formats
 * or does not contain a (sane) size. Never throws and never reads past `bytes`; a null result means "unknown", never "invalid media".
 */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | null {
  try {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return png(bytes);
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpeg(bytes);
    if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return webp(bytes);
  } catch { /* out-of-range read on a truncated prefix */ }
  return null;
}
