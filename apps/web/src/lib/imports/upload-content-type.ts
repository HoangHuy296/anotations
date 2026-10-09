/**
 * Browser-safe resolution of the content type a selected file is DECLARED as in an upload manifest.
 *
 * The declared type is only a hint that selects an upload slot and gates verification eligibility; the server classifies by bytes and never trusts it. But the browser's
 * `file.type` is unreliable: it is empty for some files, differs between operating systems (`.csv` as `application/vnd.ms-excel`, `.wav` as `audio/x-wav`) and was previously
 * defaulted to `text/plain`, which silently made an MP4 with an empty MIME ineligible for video verification, while any type outside the allowlist failed the WHOLE manifest.
 * The file extension is therefore the deterministic hint, and a file whose type cannot be resolved is reported and skipped instead of poisoning the request.
 */
export const EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  mp4: "video/mp4", webm: "video/webm",
  wav: "audio/wav", mp3: "audio/mpeg",
  txt: "text/plain", csv: "text/csv", json: "application/json",
});
/** The declared types the upload APIs accept (must equal `candidateContentTypes`; asserted by test). */
export const SUPPORTED_UPLOAD_CONTENT_TYPES: readonly string[] = Object.freeze([...new Set(Object.values(EXTENSION_CONTENT_TYPES))]);

export type UploadContentTypeResolution = { supported: true; contentType: string; source: "extension" | "browser" } | { supported: false; reason: "UNSUPPORTED_TYPE"; extension: string };

export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : "";
}

export function resolveUploadContentType(file: { name: string; type: string }): UploadContentTypeResolution {
  const extension = fileExtension(file.name);
  const fromExtension = extension ? EXTENSION_CONTENT_TYPES[extension] : undefined;
  if (fromExtension) return { supported: true, contentType: fromExtension, source: "extension" };
  // No (known) extension: trust the browser only when it names one of the exact supported types; an extension-less plain-text file keeps working.
  const type = file.type.trim().toLowerCase();
  if (type && SUPPORTED_UPLOAD_CONTENT_TYPES.includes(type)) return { supported: true, contentType: type, source: "browser" };
  if (!extension && type === "") return { supported: true, contentType: "text/plain", source: "browser" };
  return { supported: false, reason: "UNSUPPORTED_TYPE", extension };
}

/** Splits a selection into uploadable entries and the skipped ones (for a clear, bounded message). */
export function partitionUploadSelection<T extends { name: string; type: string }>(files: readonly T[]) {
  const supported: Array<{ file: T; contentType: string }> = [];
  const skipped: Array<{ name: string; extension: string }> = [];
  for (const file of files) {
    const resolved = resolveUploadContentType(file);
    if (resolved.supported) supported.push({ file, contentType: resolved.contentType });
    else skipped.push({ name: file.name, extension: resolved.extension });
  }
  return { supported, skipped };
}

export function skippedFilesMessage(skipped: ReadonlyArray<{ name: string }>): string | null {
  if (skipped.length === 0) return null;
  const shown = skipped.slice(0, 3).map((entry) => entry.name).join(", ");
  return `${skipped.length} file${skipped.length === 1 ? " was" : "s were"} skipped because ${skipped.length === 1 ? "its" : "their"} type is not supported (${shown}${skipped.length > 3 ? ", …" : ""}). Supported: PNG, JPEG, WebP, MP4, WebM, WAV, MP3, TXT, CSV, JSON.`;
}
