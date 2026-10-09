/**
 * Object-identity comparison for the sealing protocol (contract section 5.4). The ETag is a *bound observation*, never a content identity; it is compared
 * only to detect that the exact observed object changed. Last-modified has one-second granularity on S3-compatible stores, so it is compared at second resolution.
 */
export type ObjectIdentity = { etag: string; size: number | bigint; lastModified: Date; versionId?: string | null };

const normalizeEtag = (etag: string) => etag.replace(/^"+|"+$/g, "");
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

export function identityFromStat(stat: { etag?: string; size: number; lastModified?: Date; versionId?: string | null }): ObjectIdentity | null {
  if (!stat.etag || !stat.lastModified || !Number.isFinite(stat.size)) return null;
  return { etag: normalizeEtag(stat.etag), size: stat.size, lastModified: stat.lastModified, versionId: stat.versionId ?? null };
}

export function identitiesEqual(a: ObjectIdentity, b: ObjectIdentity): boolean {
  return normalizeEtag(a.etag) === normalizeEtag(b.etag)
    && BigInt(a.size) === BigInt(b.size)
    && seconds(a.lastModified) === seconds(b.lastModified)
    && (a.versionId ?? null) === (b.versionId ?? null);
}

/** MinIO/S3 "object does not exist" in all the shapes the client surfaces it. */
export function isObjectNotFound(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "NotFound" || code === "NoSuchKey" || code === "NoSuchVersion" || (error as { statusCode?: number } | null)?.statusCode === 404;
}

/** HTTP 412: a conditional copy's precondition (matching ETag / unmodified-since) no longer holds. */
export function isPreconditionFailed(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "PreconditionFailed" || (error as { statusCode?: number } | null)?.statusCode === 412;
}
