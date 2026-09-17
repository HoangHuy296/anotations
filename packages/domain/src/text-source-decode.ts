/**
 * Shared fatal UTF-8 decode rules (research.md D1): `ignoreBOM: true` so a
 * leading UTF-8 BOM is preserved as U+FEFF in the decoded text, and invalid
 * UTF-8 is rejected outright — never substituted with U+FFFD. Preparation
 * (worker) and reads (web) must use this single function, not a duplicate
 * `TextDecoder` call with different options.
 */

export class TextSourceDecodeError extends Error {
  constructor(message = "Source bytes are not valid, complete UTF-8") {
    super(message);
    this.name = "TextSourceDecodeError";
  }
}

export interface DecodedTextSource {
  text: string;
  byteLength: number;
  codeUnitLength: number;
}

export function decodeUtf8SourceBytes(bytes: Uint8Array): DecodedTextSource {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new TextSourceDecodeError();
  }
  return { text, byteLength: bytes.byteLength, codeUnitLength: text.length };
}
