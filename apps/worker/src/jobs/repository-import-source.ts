import { z } from "zod";

import { getRepositoryImportPolicy } from "../config.js";
import { normalizeRepositoryPath } from "./source-fingerprint.js";

const repositoryInputSchema = z.object({
  source: z.object({
    repository: z.object({
      provider: z.enum(["GITHUB", "GITEA"]),
      owner: z.string().trim().min(1).max(255),
      repo: z.string().trim().min(1).max(255),
      ref: z.string().trim().min(1).max(255),
      rootPath: z.string().max(1024).nullable(),
      visibility: z.enum(["PUBLIC", "PRIVATE"]),
    }).strict(),
    manifest: z.object({
      itemCount: z.number().int().min(0),
      declaredBytes: z.number().int().min(0),
      durationMs: z.number().int().min(0).optional(),
    }).strict(),
    sourceConnectionId: z.string().min(1).nullable(),
  }).strict(),
}).strict();

export type RepositoryImportInput = z.infer<typeof repositoryInputSchema>["source"];

export type RepositoryCandidate = {
  path: string;
  filename: string;
  mimeType: string;
  modality: "IMAGE" | "VIDEO" | "TEXT" | "AUDIO";
  sizeBytes: number;
  revision: string;
  providerFileIdentity: string;
  downloadUrl: string;
};

export type RepositoryAccess = { baseUrl: string; token: string | null };

/**
 * The provider tree is ephemeral worker input.  Unsupported files are counted
 * as a safe aggregate skip, never persisted with a path or provider detail.
 */
export type RepositoryCandidateListing = {
  candidates: RepositoryCandidate[];
  skippedItems: number;
};

export const repositoryImportPolicy = getRepositoryImportPolicy();

export function parseRepositoryImportInput(value: unknown): RepositoryImportInput | null {
  const parsed = repositoryInputSchema.safeParse(value);
  if (!parsed.success) return null;
  try {
    const rootPath = parsed.data.source.repository.rootPath;
    if (rootPath !== null && rootPath !== "") normalizeRepositoryPath(rootPath);
    return parsed.data.source;
  } catch {
    return null;
  }
}

export function detectRepositoryFile(path: string, sizeBytes: number, revision: string, providerFileIdentity: string, downloadUrl: string): RepositoryCandidate | null {
  let normalized: string;
  try { normalized = normalizeRepositoryPath(path); } catch { return null; }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > repositoryImportPolicy.REPOSITORY_IMPORT_MAX_FILE_BYTES) return null;
  const extension = normalized.split(".").pop()?.toLowerCase() ?? "";
  const mapping: Record<string, Pick<RepositoryCandidate, "mimeType" | "modality">> = {
    jpg: { mimeType: "image/jpeg", modality: "IMAGE" }, jpeg: { mimeType: "image/jpeg", modality: "IMAGE" }, png: { mimeType: "image/png", modality: "IMAGE" }, webp: { mimeType: "image/webp", modality: "IMAGE" },
    mp4: { mimeType: "video/mp4", modality: "VIDEO" }, webm: { mimeType: "video/webm", modality: "VIDEO" },
    txt: { mimeType: "text/plain", modality: "TEXT" }, json: { mimeType: "application/json", modality: "TEXT" }, csv: { mimeType: "text/csv", modality: "TEXT" },
    mp3: { mimeType: "audio/mpeg", modality: "AUDIO" }, ogg: { mimeType: "audio/ogg", modality: "AUDIO" }, wav: { mimeType: "audio/wav", modality: "AUDIO" },
  };
  const detected = mapping[extension];
  return detected ? { path: normalized, filename: normalized.split("/").at(-1)!, sizeBytes, revision, providerFileIdentity, downloadUrl, ...detected } : null;
}

/**
 * Minimal bounded provider bridge. It receives only an already-authorized
 * server-side base URL/token, never a browser URL or durable credential.
 */
export async function listRepositoryCandidates(input: { source: RepositoryImportInput; access: RepositoryAccess }): Promise<RepositoryCandidate[]> {
  return (await listRepositoryCandidateListing(input)).candidates;
}

export async function listRepositoryCandidateListing(input: { source: RepositoryImportInput; access: RepositoryAccess }): Promise<RepositoryCandidateListing> {
  const { repository, manifest } = input.source;
  const root = repository.rootPath?.replace(/^\/+|\/+$/g, "") ?? "";
  const base = input.access.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = input.access.token ? { Authorization: repository.provider === "GITEA" ? `token ${input.access.token}` : `Bearer ${input.access.token}` } : {};
  const treeUrl = repository.provider === "GITEA"
    ? `${base}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git/trees/${encodeURIComponent(repository.ref)}?recursive=true`
    : `${base}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git/trees/${encodeURIComponent(repository.ref)}?recursive=1`;
  const response = await fetch(treeUrl, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("SOURCE_PROVIDER_UNAVAILABLE");
  const data: unknown = await response.json();
  const tree = data && typeof data === "object" && Array.isArray((data as { tree?: unknown[] }).tree) ? (data as { tree: unknown[] }).tree : [];
  const candidates: RepositoryCandidate[] = [];
  let skippedItems = 0;
  let totalBytes = 0;
  // Old accepted repository Jobs used `{0,0}` before bounded preview
  // aggregates were persisted. That sentinel means "unknown", never
  // unlimited: the immutable worker policy remains the cap.
  const itemLimit = manifest.itemCount > 0
    ? Math.min(manifest.itemCount, repositoryImportPolicy.REPOSITORY_IMPORT_MAX_FILES)
    : repositoryImportPolicy.REPOSITORY_IMPORT_MAX_FILES;
  const byteLimit = manifest.declaredBytes > 0
    ? Math.min(manifest.declaredBytes, repositoryImportPolicy.REPOSITORY_IMPORT_MAX_TOTAL_BYTES)
    : repositoryImportPolicy.REPOSITORY_IMPORT_MAX_TOTAL_BYTES;
  for (const entry of tree) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const path = typeof row.path === "string" ? row.path : "";
    const type = typeof row.type === "string" ? row.type : "";
    const size = typeof row.size === "number" ? row.size : -1;
    const identity = typeof row.sha === "string" ? row.sha : "";
    if (type !== "blob" || !identity || (root && !(path === root || path.startsWith(`${root}/`)))) continue;
    const downloadUrl = repository.provider === "GITEA"
      ? `${base}/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/raw/${encodeURIComponent(repository.ref)}/${path.split("/").map(encodeURIComponent).join("/")}`
      : `${base}/raw/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/${encodeURIComponent(identity)}/${path.split("/").map(encodeURIComponent).join("/")}`;
    const candidate = detectRepositoryFile(path, size, repository.ref, identity, downloadUrl);
    if (!candidate) {
      skippedItems += 1;
      continue;
    }
    if (
      totalBytes + candidate.sizeBytes > byteLimit
      || candidates.length >= itemLimit
    ) break;
    totalBytes += candidate.sizeBytes;
    candidates.push(candidate);
  }
  if (
    candidates.length === 0
    || (manifest.itemCount > 0 && candidates.length + skippedItems > manifest.itemCount)
    || (manifest.declaredBytes > 0 && totalBytes > manifest.declaredBytes)
  ) throw new Error("SOURCE_IMPORT_LIMIT_EXCEEDED");
  return { candidates, skippedItems };
}

export async function downloadRepositoryCandidate(candidate: RepositoryCandidate, access: RepositoryAccess) {
  const headers: Record<string, string> = access.token ? { Authorization: `token ${access.token}` } : {};
  const response = await fetch(candidate.downloadUrl, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error("SOURCE_DOWNLOAD_FAILED");
  const contentLength = Number(response.headers.get("content-length") ?? candidate.sizeBytes);
  if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > repositoryImportPolicy.REPOSITORY_IMPORT_MAX_FILE_BYTES) throw new Error("SOURCE_IMPORT_LIMIT_EXCEEDED");
  return { body: response.body, sizeBytes: contentLength };
}

export function chunkRepositoryCandidates<T>(items: readonly T[], batchSize = repositoryImportPolicy.REPOSITORY_IMPORT_BATCH_SIZE) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += batchSize) chunks.push([...items.slice(index, index + batchSize)]);
  return chunks;
}
