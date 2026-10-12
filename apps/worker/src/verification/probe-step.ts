import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

import { MEDIA_VERIFICATION_POLICY_VERSION } from "@annotationplatform/domain/media-verification";

import { classifyPremedia, type PersistedProbe, type ProbeDocument } from "../media/classification-policy.js";
import { defaultMediaProcessingPolicy } from "../media/policy.js";
import { identitiesEqual, identityFromStat, isObjectNotFound } from "./identity.js";
import { swapResult, terminalizeVerification } from "./terminalize.js";
import type { StepContext, StepResult, VerificationRow } from "./types.js";

class ShortOrLongReadError extends Error {}

/** Streams the sealed object into a private temp file through a SHA-256 hasher and a byte counter; the count must equal the recorded sealed size exactly. */
export async function materializeSealed(ctx: StepContext, row: VerificationRow, destination: string): Promise<{ sha256: string; bytes: number }> {
  const expected = Number(row.sealedSizeBytes);
  const hash = createHash("sha256");
  let count = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      count += chunk.length;
      if (count > expected) return callback(new ShortOrLongReadError("OVERLONG"));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const source = await ctx.deps.minio.getObject(row.stagedBucket, row.sealedKey!, row.sealedVersionId ? { versionId: row.sealedVersionId } : undefined);
  await pipeline(source, counter, createWriteStream(destination, { flags: "wx" }));
  if (count !== expected) throw new ShortOrLongReadError("SHORT");
  return { sha256: hash.digest("hex"), bytes: count };
}

const statSealedEqualsRecorded = async (ctx: StepContext, row: VerificationRow): Promise<"EQUAL" | "CHANGED" | "ERROR"> => {
  try {
    const now = identityFromStat(await ctx.deps.minio.statObject(row.stagedBucket, row.sealedKey!));
    const recorded = { etag: row.sealedEtag!, size: row.sealedSizeBytes!, lastModified: row.sealedLastModified!, versionId: row.sealedVersionId };
    return now && identitiesEqual(now, recorded) ? "EQUAL" : "CHANGED";
  } catch (error) {
    return isObjectNotFound(error) ? "CHANGED" : "ERROR";
  }
};

const emptyProbe = (sizeBytes: number, ffprobeVersion: string): PersistedProbe => ({ formatName: null, durationMs: null, sizeBytes, streams: [], negativeBrandHit: false, ffprobeVersion });

/**
 * P2 — bounded materialization and probe (contract section 5.4). SEALED -> VERIFIED | REJECTED | STALE.
 *  a. sealed identity re-checked; b. size cap; c. hash-while-materializing with an exact byte count (a short or long read is an operational storage failure and ffprobe
 *  NEVER runs on it); d. identity re-checked after the read (mid-read replacement => STALE S2); e. ffprobe on the temp file only; the decision and the SHA-256 are written
 *  in the same compare-and-swap. A non-completed probe is operational and is never a verdict (R5).
 */
export async function probeStep(ctx: StepContext, row: VerificationRow, isCancellationRequested: () => Promise<boolean>): Promise<StepResult> {
  const { deps } = ctx;
  const stale = () => terminalizeVerification(ctx, row, { status: "STALE", resultCode: "UPLOAD_SOURCE_CHANGED", resultReason: "SOURCE_SEALED_CHANGED", jobErrorCode: "UPLOAD_SOURCE_CHANGED", jobErrorKind: "STALE_EVIDENCE" }).then(swapResult);

  const before = await statSealedEqualsRecorded(ctx, row);
  if (before === "CHANGED") return stale();
  if (before === "ERROR") return { kind: "operational", reason: "UPLOAD_VERIFICATION_STORAGE_FAILED" };
  if (!row.sealedKey || row.sealedSizeBytes === null || row.sealedSizeBytes > BigInt(deps.sourceCapBytes)) return { kind: "operational", reason: "UPLOAD_VERIFICATION_STORAGE_FAILED" };

  const versions = await deps.versions();
  return deps.withTempWorkspace(ctx.job.id, async (workspace) => {
    const filePath = `${workspace.path}/source`;
    let materialized: { sha256: string; bytes: number };
    try {
      materialized = await materializeSealed(ctx, row, filePath);
    } catch (error) {
      if (isObjectNotFound(error)) return stale();
      return { kind: "operational", reason: "UPLOAD_VERIFICATION_STORAGE_FAILED" } satisfies StepResult;
    }
    const after = await statSealedEqualsRecorded(ctx, row);
    if (after === "CHANGED") return stale();
    if (after === "ERROR") return { kind: "operational", reason: "UPLOAD_VERIFICATION_STORAGE_FAILED" } satisfies StepResult;

    const run = await deps.probe({ filePath, cwd: workspace.path, isCancellationRequested });
    if (run.kind === "CANCELED") return { kind: "advanced" } satisfies StepResult; // the loop's cancellation boundary terminalizes it
    if (run.kind === "NOT_COMPLETED") return { kind: "operational", reason: run.reason } satisfies StepResult;

    const processorVersion = versions.processorVersion;
    if (run.kind === "COMPLETED_INVALID") {
      const won = await terminalizeVerification(ctx, row, {
        status: "REJECTED", resultCode: "INVALID_MEDIA", resultReason: "MEDIA_UNREADABLE", jobErrorCode: "INVALID_MEDIA",
        evidence: { probe: emptyProbe(materialized.bytes, versions.ffprobeVersion) as never, contentSha256: materialized.sha256, policyVersion: MEDIA_VERIFICATION_POLICY_VERSION, processorVersion },
      });
      return swapResult(won) satisfies StepResult;
    }

    const decision = classifyPremedia({ document: run.document as ProbeDocument, sizeBytes: materialized.bytes, ffprobeVersion: versions.ffprobeVersion, boundModality: "VIDEO", maxDurationSeconds: defaultMediaProcessingPolicy.maxDurationMs / 1000 });
    if (decision.outcome === "REJECTED") {
      const won = await terminalizeVerification(ctx, row, {
        status: "REJECTED", resultCode: decision.code, resultReason: decision.reason, jobErrorCode: decision.code,
        evidence: { probe: decision.probe as never, contentSha256: materialized.sha256, policyVersion: decision.policyVersion, processorVersion },
      });
      return swapResult(won) satisfies StepResult;
    }
    // Positive, eligible outcome: the same compare-and-swap persists the decision and the content identity.
    const swapped = await ctx.db.mediaVerification.updateMany({
      where: { id: row.id, status: "SEALED" },
      data: { status: "VERIFIED", contentSha256: materialized.sha256, probe: decision.probe as never, verifiedModality: "VIDEO", policyVersion: decision.policyVersion, processorVersion, verifiedAt: deps.now() },
    });
    void swapped;
    return { kind: "advanced" } satisfies StepResult;
  });
}
