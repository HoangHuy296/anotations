import { createDecipheriv } from "node:crypto";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import { normalizeSourceRootPath, validateSourceBaseUrl, validateSourceImportLimits } from "@annotationplatform/domain";
import { parseRepositoryImportInput, type RepositoryAccess } from "../jobs/repository-import-source.js";

export type SourceAccessResolution =
  | { kind: "not-applicable" }
  | { kind: "ready"; sourceConnectionId: string; baseUrl: string; token: string; rootPath: string }
  | { kind: "refused"; errorCode: "SOURCE_TOKEN_EXPIRED" | "SOURCE_CONNECTION_NOT_FOUND" | "SOURCE_URL_UNSAFE" | "SOURCE_ROOT_PATH_UNSAFE" | "SOURCE_TOKEN_INVALID" | "SOURCE_IMPORT_LIMIT_EXCEEDED" };

function decryptToken(value: string) {
  const encoded = process.env.SOURCE_CONNECTION_ENCRYPTION_KEY;
  if (!encoded) return null;
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) return null;
  const [version, ivValue, tagValue, cipherValue] = value.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !cipherValue) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(cipherValue, "base64url")), decipher.final()]).toString("utf8");
  } catch { return null; }
}

function canonicalBaseUrl(value: string) {
  const url = new URL(value);
  if (!url.hostname || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * A browser reaches the local Compose Gitea service through its published
 * loopback URL, whereas a private worker must use the Compose network alias.
 * The substitution is an exact, server-controlled topology mapping: it never
 * accepts an internal hostname from a Job or browser request.
 */
export function resolveWorkerReachableGiteaBaseUrl(raw: string, environment: NodeJS.ProcessEnv = process.env) {
  const publicUrl = environment.GITEA_PUBLIC_URL;
  const internalUrl = environment.GITEA_INTERNAL_URL;
  if (environment.ANNOTATIONPLATFORM_RUNTIME !== "compose" || !publicUrl || !internalUrl) return raw;
  try {
    const canonicalRaw = canonicalBaseUrl(raw);
    const canonicalPublic = canonicalBaseUrl(publicUrl);
    const canonicalInternal = canonicalBaseUrl(internalUrl);
    return canonicalRaw && canonicalPublic && canonicalInternal && canonicalRaw === canonicalPublic
      ? canonicalInternal
      : raw;
  } catch {
    return raw;
  }
}

/** Re-resolves authoritative state; it never consumes queue payload configuration. */
export async function resolveSourceAccessForJob(db: PrismaClient, jobId: string): Promise<SourceAccessResolution> {
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { sourceConnectionId: true, input: true, createdById: true, createdBy: { select: { role: true } } },
  });
  if (!job) return { kind: "not-applicable" };
  // Preserve the stable policy code for a syntactically visible unsafe root
  // while the strict parser still rejects every other malformed input shape.
  const rawSource = job.input && typeof job.input === "object" && !Array.isArray(job.input)
    ? (job.input as { source?: unknown }).source : null;
  const rawRepository = rawSource && typeof rawSource === "object" && !Array.isArray(rawSource)
    ? (rawSource as { repository?: unknown }).repository : null;
  const rawRootCandidate = rawRepository && typeof rawRepository === "object" && !Array.isArray(rawRepository)
    ? (rawRepository as { rootPath?: unknown }).rootPath : undefined;
  if (typeof rawRootCandidate === "string" && !normalizeSourceRootPath(rawRootCandidate).ok) {
    return { kind: "refused", errorCode: "SOURCE_ROOT_PATH_UNSAFE" };
  }
  const parsedInput = parseRepositoryImportInput(job.input);
  if (!parsedInput) return { kind: "refused", errorCode: "SOURCE_TOKEN_INVALID" };
  if (!job.sourceConnectionId) {
    if (parsedInput.repository.visibility !== "PUBLIC") return { kind: "refused", errorCode: "SOURCE_CONNECTION_NOT_FOUND" };
    if (parsedInput.repository.provider === "GITEA") {
      // Same pattern as the credentialed branch below: validate the durable
      // public address first (this is what goes through the numeric-IP/DNS
      // SSRF checks), then apply the exact, server-controlled internal-alias
      // substitution. Validating GITEA_INTERNAL_URL directly is wrong here —
      // it's a Compose-network hostname that resolves to a private address,
      // which the private-IP policy correctly rejects for arbitrary hosts.
      const publicUrl = process.env.GITEA_PUBLIC_URL;
      if (!publicUrl) return { kind: "refused", errorCode: "SOURCE_URL_UNSAFE" };
      const address = await validateSourceBaseUrl(publicUrl);
      if (!address.ok) return { kind: "refused", errorCode: "SOURCE_URL_UNSAFE" };
      const baseUrl = resolveWorkerReachableGiteaBaseUrl(address.value.toString());
      return { kind: "ready", sourceConnectionId: "", baseUrl, token: "", rootPath: parsedInput.repository.rootPath ?? "" };
    }
    const baseUrl = process.env.GITHUB_API_BASE_URL;
    if (!baseUrl) return { kind: "refused", errorCode: "SOURCE_URL_UNSAFE" };
    const address = await validateSourceBaseUrl(baseUrl);
    if (!address.ok) return { kind: "refused", errorCode: "SOURCE_URL_UNSAFE" };
    return { kind: "ready", sourceConnectionId: "", baseUrl: address.value.toString(), token: "", rootPath: parsedInput.repository.rootPath ?? "" };
  }
  const connection = await db.sourceConnection.findUnique({
    where: { id: job.sourceConnectionId },
    select: { id: true, userId: true, baseUrl: true, tokenEncrypted: true, tokenExpiresAt: true, status: true, revokedAt: true },
  });
  if (!connection || connection.revokedAt || connection.status !== "ACTIVE" || (!connection.tokenEncrypted)) return { kind: "refused", errorCode: "SOURCE_CONNECTION_NOT_FOUND" };
  if (connection.tokenExpiresAt && connection.tokenExpiresAt <= new Date()) {
    await db.sourceConnection.updateMany({ where: { id: connection.id, status: "ACTIVE" }, data: { status: "EXPIRED" } });
    return { kind: "refused", errorCode: "SOURCE_TOKEN_EXPIRED" };
  }
  if (job.createdById !== connection.userId && job.createdBy.role !== "ADMIN") return { kind: "refused", errorCode: "SOURCE_CONNECTION_NOT_FOUND" };
  // Validate the durable public/provider address first. When it is the exact
  // configured Compose Gitea public root, use the server-controlled internal
  // alias for the worker network hop; do not validate or accept a browser
  // supplied internal hostname.
  const address = await validateSourceBaseUrl(connection.baseUrl);
  if (!address.ok) return { kind: "refused", errorCode: "SOURCE_URL_UNSAFE" };
  const rawRoot = parsedInput.repository.rootPath ?? "";
  const rootPath = normalizeSourceRootPath(rawRoot);
  if (!rootPath.ok) return { kind: "refused", errorCode: "SOURCE_ROOT_PATH_UNSAFE" };
  const limitResult = validateSourceImportLimits(parsedInput.manifest);
  if (!limitResult.ok) return { kind: "refused", errorCode: "SOURCE_IMPORT_LIMIT_EXCEEDED" };
  const token = decryptToken(connection.tokenEncrypted);
  const baseUrl = resolveWorkerReachableGiteaBaseUrl(address.value.toString());
  return token ? { kind: "ready", sourceConnectionId: connection.id, baseUrl, token, rootPath: rootPath.value } : { kind: "refused", errorCode: "SOURCE_TOKEN_INVALID" };
}

/** Converts a successful durable-source revalidation into the provider bridge shape. */
export function sourceAccessToRepositoryAccess(value: SourceAccessResolution): RepositoryAccess | null {
  return value.kind === "ready" ? { baseUrl: value.baseUrl, token: value.token || null } : null;
}
