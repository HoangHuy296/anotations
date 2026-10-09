import { CopyDestinationOptions, CopySourceOptions } from "minio";

import { buildSealedKey } from "@annotationplatform/domain/media-verification";

import { identitiesEqual, identityFromStat, isObjectNotFound, isPreconditionFailed } from "./identity.js";
import { swapResult, terminalizeVerification } from "./terminalize.js";
import type { StepContext, StepResult, VerificationRow } from "./types.js";

/**
 * P1 — conditional seal (contract section 5.4). PENDING -> SEALED.
 *  a. the staged object must still equal the identity recorded at the request (missing/changed => STALE S1);
 *  b. server-side conditional copy into the deterministic sealed key (precondition failure => STALE S1; any other error is transient);
 *  c. an INDEPENDENT stat of the sealed object must have the recorded staged size (otherwise the partial object is deleted and the failure is operational);
 *  d. one compare-and-swap persists the sealed identity;
 *  e. only after (d) the staged object is deleted (best effort). A crash before (d) leaves the staged object intact and the copy repeats.
 */
export async function sealStep(ctx: StepContext, row: VerificationRow): Promise<StepResult> {
  const { deps } = ctx;
  const stagedExpected = { etag: row.stagedEtag, size: row.stagedSizeBytes, lastModified: row.stagedLastModified, versionId: row.stagedVersionId };
  const stale = (reason: "SOURCE_STAGED_CHANGED") => terminalizeVerification(ctx, row, { status: "STALE", resultCode: "UPLOAD_SOURCE_CHANGED", resultReason: reason, jobErrorCode: "UPLOAD_SOURCE_CHANGED", jobErrorKind: "STALE_EVIDENCE" }).then(swapResult);

  let stagedNow;
  try {
    stagedNow = identityFromStat(await deps.minio.statObject(row.stagedBucket, row.stagedKey, row.stagedVersionId ? { versionId: row.stagedVersionId } : undefined));
  } catch (error) {
    if (isObjectNotFound(error)) return stale("SOURCE_STAGED_CHANGED");
    return { kind: "operational", reason: "UPLOAD_VERIFICATION_STORAGE_FAILED" };
  }
  if (!stagedNow || !identitiesEqual(stagedNow, stagedExpected)) return stale("SOURCE_STAGED_CHANGED");

  const sealedKey = row.sealedKey ?? buildSealedKey(row.datasetId, row.id);
  try {
    await deps.minio.copyObject(
      new CopySourceOptions({ Bucket: row.stagedBucket, Object: row.stagedKey, ...(row.stagedVersionId ? { VersionID: row.stagedVersionId } : {}), MatchETag: row.stagedEtag, MatchUnmodifiedSince: row.stagedLastModified.toUTCString() }),
      new CopyDestinationOptions({ Bucket: row.stagedBucket, Object: sealedKey }),
    );
  } catch (error) {
    if (isPreconditionFailed(error) || isObjectNotFound(error)) return stale("SOURCE_STAGED_CHANGED");
    return { kind: "operational", reason: "UPLOAD_VERIFICATION_STORAGE_FAILED" };
  }

  let sealed;
  try {
    sealed = identityFromStat(await deps.minio.statObject(row.stagedBucket, sealedKey));
  } catch {
    return { kind: "operational", reason: "UPLOAD_VERIFICATION_STORAGE_FAILED" };
  }
  if (!sealed || BigInt(sealed.size) !== row.stagedSizeBytes) {
    try { await deps.minio.removeObject(row.stagedBucket, sealedKey); } catch { /* the sealed GC covers leftovers */ }
    return { kind: "operational", reason: "UPLOAD_VERIFICATION_STORAGE_FAILED" };
  }

  const swapped = await ctx.db.mediaVerification.updateMany({
    where: { id: row.id, status: "PENDING" },
    data: { status: "SEALED", sealedKey, sealedEtag: sealed.etag, sealedSizeBytes: BigInt(sealed.size), sealedLastModified: sealed.lastModified, sealedVersionId: sealed.versionId ?? null, sealedAt: deps.now() },
  });
  if (swapped.count !== 1) return { kind: "advanced" }; // another actor moved it; the loop re-reads the recorded status
  try { await deps.minio.removeObject(row.stagedBucket, row.stagedKey); } catch { /* staged cleanup is best effort; GC covers it */ }
  return { kind: "advanced" };
}
