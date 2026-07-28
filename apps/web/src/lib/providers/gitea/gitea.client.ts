import "server-only";

import { encodePath, requestProviderJson } from "@/lib/providers/provider-fetch";
import { ProviderTransportError } from "@/lib/providers/provider-errors";
import type { RepositoryIdentity, ServerCredentialContext } from "@/lib/providers/provider.types";

type GiteaRepository = { defaultBranch: string; isPrivate: boolean };
type PreviewModality = "IMAGE" | "VIDEO" | "AUDIO" | "TEXT";
type GiteaPreview = { detectedAssetCount: number; detectedBytes: number; truncated: boolean; sample: Array<{ path: string; size: number | null; modality: PreviewModality }> };

const PREVIEW_LIMIT = 100;
const PREVIEW_SAMPLE_LIMIT = 20;
const modalityByExtension: Record<string, PreviewModality> = {
  ".jpg": "IMAGE", ".jpeg": "IMAGE", ".png": "IMAGE", ".webp": "IMAGE", ".gif": "IMAGE", ".bmp": "IMAGE",
  ".mp4": "VIDEO", ".webm": "VIDEO", ".mov": "VIDEO", ".avi": "VIDEO",
  ".mp3": "AUDIO", ".wav": "AUDIO", ".ogg": "AUDIO", ".m4a": "AUDIO", ".flac": "AUDIO",
  ".txt": "TEXT", ".csv": "TEXT", ".json": "TEXT", ".md": "TEXT", ".pdf": "TEXT",
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderTransportError("INVALID_RESPONSE");
  return value as Record<string, unknown>;
}

function apiBaseUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/v1/`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function authHeaders(credential: ServerCredentialContext | null): HeadersInit | undefined {
  return credential ? { Authorization: `token ${credential.token}` } : undefined;
}

export async function getGiteaRepository(baseUrl: string, repository: RepositoryIdentity, credential: ServerCredentialContext | null): Promise<GiteaRepository> {
  const body = asRecord(await requestProviderJson({
    baseUrl: apiBaseUrl(baseUrl),
    path: `repos/${encodePath(repository.owner, repository.name)}`,
    headers: authHeaders(credential),
  }));
  const defaultBranch = body.default_branch;
  const isPrivate = body.private;
  if (typeof defaultBranch !== "string" || typeof isPrivate !== "boolean") throw new ProviderTransportError("INVALID_RESPONSE");
  return { defaultBranch, isPrivate };
}

export async function getGiteaRevision(baseUrl: string, repository: RepositoryIdentity, ref: string, credential: ServerCredentialContext | null): Promise<string | null> {
  const body = asRecord(await requestProviderJson({
    baseUrl: apiBaseUrl(baseUrl),
    path: `repos/${encodePath(repository.owner, repository.name)}/git/commits/${encodeURIComponent(ref)}`,
    headers: authHeaders(credential),
  }));
  const sha = body.sha;
  return typeof sha === "string" && sha.length <= 128 ? sha : null;
}

/**
 * A bounded branch projection for the browser's read-only Import Preview.
 * It is provider metadata only: no file manifest or credential is returned.
 */
export async function getGiteaBranches(baseUrl: string, repository: RepositoryIdentity, credential: ServerCredentialContext | null): Promise<string[]> {
  const body = await requestProviderJson({
    baseUrl: apiBaseUrl(baseUrl),
    path: `repos/${encodePath(repository.owner, repository.name)}/branches?limit=100&page=1`,
    headers: authHeaders(credential),
  });
  if (!Array.isArray(body)) throw new ProviderTransportError("INVALID_RESPONSE");
  return body.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const name = (entry as Record<string, unknown>).name;
    return typeof name === "string" && name.trim().length > 0 && name.length <= 255 ? [name] : [];
  }).slice(0, 100);
}

export async function giteaRootExists(baseUrl: string, repository: RepositoryIdentity, ref: string, rootPath: string, credential: ServerCredentialContext | null): Promise<boolean> {
  const relative = rootPath ? `/${rootPath.split("/").map(encodeURIComponent).join("/")}` : "";
  await requestProviderJson({
    baseUrl: apiBaseUrl(baseUrl),
    path: `repos/${encodePath(repository.owner, repository.name)}/contents${relative}?ref=${encodeURIComponent(ref)}`,
    headers: authHeaders(credential),
  });
  return true;
}

/**
 * A bounded metadata-only tree projection for the Import Preview UI. It does
 * not download file bodies or persist a manifest. A truncation flag prevents
 * callers from treating the count as a complete repository inventory.
 */
export async function getGiteaAssetPreview(baseUrl: string, repository: RepositoryIdentity, ref: string, rootPath: string | null, credential: ServerCredentialContext | null): Promise<GiteaPreview> {
  const body = asRecord(await requestProviderJson({
    baseUrl: apiBaseUrl(baseUrl),
    path: `repos/${encodePath(repository.owner, repository.name)}/git/trees/${encodeURIComponent(ref)}?recursive=true&page=1&per_page=${PREVIEW_LIMIT}`,
    headers: authHeaders(credential),
  }));
  const tree = body.tree;
  if (!Array.isArray(tree) || tree.length > PREVIEW_LIMIT) throw new ProviderTransportError("INVALID_RESPONSE");
  const prefix = rootPath ? `${rootPath}/` : "";
  const assets = tree.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const file = entry as Record<string, unknown>;
    if (file.type !== "blob" || typeof file.path !== "string" || (rootPath && file.path !== rootPath && !file.path.startsWith(prefix))) return [];
    const extension = file.path.slice(file.path.lastIndexOf(".")).toLowerCase();
    const modality = modalityByExtension[extension];
    if (!modality) return [];
    const size = typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : null;
    return [{ path: file.path, size, modality }];
  });
  return {
    detectedAssetCount: assets.length,
    detectedBytes: assets.reduce((total, asset) => total + (asset.size ?? 0), 0),
    truncated: body.truncated === true || tree.length === PREVIEW_LIMIT,
    sample: assets.slice(0, PREVIEW_SAMPLE_LIMIT),
  };
}

export async function validateGiteaToken(baseUrl: string, credential: ServerCredentialContext | null) {
  if (!credential) return { valid: true as const };
  try {
    await requestProviderJson({ baseUrl: apiBaseUrl(baseUrl), path: "user", headers: authHeaders(credential) });
    return { valid: true as const };
  } catch (error) {
    if (error instanceof ProviderTransportError && error.kind === "UNAUTHORIZED") return { valid: false as const, reason: "EXPIRED" as const };
    return { valid: false as const, reason: "INVALID" as const };
  }
}
