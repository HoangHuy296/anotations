# T173 — security review: TEXT code paths

Date: 2026-09-24. Targeted grep-based audit plus type-signature inspection across every TEXT-specific file touched or created this feature (`apps/web/src/lib/annotations/text-*.ts`, `apps/web/src/app/api/assets/[assetId]/text/**`, `apps/web/src/app/api/datasets/[datasetId]/text-policy`, `apps/worker/src/jobs/text-*.ts`, `apps/worker/src/source/text-*.ts`).

## Findings

1. **`boundaryArtifactKey`/`boundaryArtifactDigest` (private MinIO derivative locator) never reaches a browser response.** `text-source-read-service.ts`'s `readTextSource` reads these fields from Prisma to fetch the boundary artifact from MinIO internally, but its exported `TextSourceReadOutcome` return type has no field for them at all — confirmed by the type signature itself, not just by reading the implementation (a future edit that tried to add them to the response would be a type error unless the type itself were also changed). Same for `storageKey`/`storageBucket` in both `text-source-read-service.ts` and `text-source-prepare-service.ts`.

2. **The TEXT export projection (T085) explicitly excludes the same fields**, by type signature: `projectTextAssetSourceForExport`'s input/output types only carry `sourceIdentity`/`sourceEncoding`/`offsetUnit`/`sourceByteLength`/`sourceCodeUnitLength` — no boundary-artifact or storage fields exist in that type to leak.

3. **No raw upstream diagnostics reach a response.** Grepped every TEXT route/service file for `error.message`/`String(error)`/`error.stack` used in a response body — zero matches. All TEXT command failures go through the closed `TextCommandFailure` string-code union (`text-command-service.ts`) and `text-command-error.ts`'s hardcoded message map (this session's own addition) — never an echoed exception message.

4. **Custom annotation properties (user-entered) are defensively sanitized on export**, reusing the *existing*, already-audited `sanitizeExportJson`/`prohibitedKey` regex (`export-manifest.ts`, unmodified by this feature) — key names matching `password|secret|token|credential|access.?key|private.?url|storage.?key|storage.?bucket|cookie|session` are dropped, and any string value that looks like a URL is dropped too. TEXT's own domain-level `projectTextProperties`/`textCustomMapSchema` (`packages/domain/src/text-properties-contract.ts`) independently bounds custom-property keys/values (reserved-key rejection, size limits) before they're ever persisted.

5. **`TEXT_SOURCE_PREPARE`'s queue payload is `{jobId}`-only**, via the existing shared `enqueueExistingJob`/`buildDurableJobQueueDelivery` helpers — no TEXT-specific enqueue path was written, so there was no opportunity to accidentally widen the payload.

6. **No MinIO/Redis/DB credential strings are interpolated anywhere in the new TEXT code.** Grepped for `MINIO_SECRET`/`MINIO_ACCESS`/`REDIS_PASSWORD`/`DATABASE_URL` across every TEXT file — zero matches; all provider access goes through the existing shared `getWebProviders()`/`createWorkerMinio()` config plumbing, never a locally-read env var.

**Result**: PASS. No finding required a code change — this pass confirmed the design decisions already made throughout the feature (particularly T028's read-service boundary and T085's export projection) hold up under direct inspection, not merely by convention.
