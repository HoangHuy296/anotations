# Code and execution-flow review — 2026-09-12

The repository-wide inventory, static searches, critical-flow review, build, and available tests are complete. Targeted fixes are applied. This is not a clean bill of health: AI lifecycle races and controlled integration verification remain open before further feature work.

The working tree already contained substantial AI/video changes and received additional dataset-library edits during the review. Those changes were preserved. The file list below identifies this review's edits, not ownership of every change in the working tree. No new feature phase was implemented.

## Remaining findings, in priority order

1. **P1 — AI failure transitions can disagree with the authoritative Job.** `apps/worker/src/jobs/ai-submit.processor.ts:49` writes `AiTask.FAILED` unconditionally before a separately guarded Job failure. `apps/worker/src/jobs/ai-poll.processor.ts:125` similarly updates the task and Job separately. Cancellation, lease takeover, or a database failure between writes can leave a terminal AiTask beside a nonterminal Job. Because the poll scanner selects only QUEUED/RUNNING AiTasks, some mismatches also remove the task from polling. Close this with one ownership-guarded Prisma transaction for each terminal outcome and real PostgreSQL tests for cancellation and lease takeover between provider response and persistence. The cancellation transaction at `ai-poll.processor.ts:155` also needs a guarded Job transition before task mutation; it currently does not check the supplied owner/token when finalizing.

2. **P1 — Exposed configuration needs operational remediation.** A provider API key was embedded as a Compose fallback. The fallback is removed, and a published demo password was removed from `REVIEW.md`. Rotate the provider key if it was valid, and replace any reused demo password. Removing a default does not revoke credentials or remove earlier copies. No credentials were rotated, and no deployment was restarted by this review.

3. **P2 — Generic retry does not support AI and several newer Job types.** `apps/web/src/lib/jobs/retry-job.ts` allowlists only dataset export and canonical repository import input. AI, bulk, and media Jobs return 409. Preserve the restrictive allowlist; do not copy arbitrary input to make retries appear to work. Define each successor's reconstruction and output-idempotency contract before enabling it. The AIOZ documentation was corrected so it no longer claims the generic retry service creates AI successors. The submit processor still contains an outdated retry comment.

4. **P2 — Malformed PNG input can become an internal error.** `apps/web/src/lib/upload-verification.ts:49` recognizes an eight-byte PNG signature and immediately reads dimensions at offsets 16 and 20. A truncated header throws instead of producing the intended invalid-media response. Add a bounded header-length/IHDR/dimension check and regression coverage for truncated inputs before expanding upload formats.

5. **P2 — Canvas drawing still updates React on every pointer move.** `apps/web/src/components/workspace/canvas-stage.tsx:287` calls `setDraft` during box/circle drawing. Existing shape drag/transform persistence occurs at action boundaries, but the drawing preview still violates the stated no-continuous-React-state rule. Move the preview into Konva/ref state and validate drawing, pan, selection, and autosave together in a browser. No geometry-format migration was attempted: Phase 011 explicitly specifies normalized coordinates relative to the original image, which the current implementation uses.

6. **P2 — Integration tests are not consistently gated.** The broad run without deployment variables encountered an unguarded realtime-ticket database test and cleanup hooks that still access PostgreSQL or storage when their tests are skipped. Examples include collaboration HTTP tests and repository-import-worker asset-access tests. Do not interpret skipped suites or file-process exit codes alone as successful integration evidence. Standardize the existing explicit integration gates and run against an isolated stack.

7. **P3 — Maintainability and documentation drift remain.** Worker/realtime code uses relative imports extensively despite the absolute-import rule. Many service/UI functions compress unrelated operations onto single lines, several phase comments describe superseded behavior, the model-registration script claims discovery registers models while discovery is read-only, and `REVIEW.md` still references a missing `.env.review.example` and historical machine addresses. Prefer small module-by-module cleanup alongside regression coverage; avoid a repository-wide formatting rewrite mixed with active feature changes. Parameterized raw SQL remains in locking/GC code; its exception scope should be reconciled with the narrow Phase 008 approval and later hardening documents before extending it.

## Applied fixes

| Problem | Change |
| --- | --- |
| Web/worker AI endpoints silently selected a developer host and recognized different aliases | Shared validated endpoint resolution in the domain provider-config contract. Both processes require explicit configuration, recognize the same aliases, reject credential-bearing URLs, and expose only a safe configuration error. |
| Compose retained machine-specific runtime defaults and a provider key fallback | Removed the key fallback; AI configuration is optional until used. Local service defaults use localhost/loopback and remain configurable. Gitea domain is configurable. The AI URL in `.env.example` is blank. |
| `z.coerce.boolean()` interpreted the string `false` as true | Strict `true`/`false` parsing with dry-run true by default. Invalid values fail validation. **An existing explicit `false` now enables the intended cleanup behavior on the next worker start.** |
| Image AI completion did not fence out a former owner | Added lock token and worker identity to the transactional Job completion guard, matching video completion. Also constrain assets and labels to compatible image modality. |
| Annotation create access used an impossible condition | Missing create access now returns NOT_FOUND before opening a write transaction. |
| Scheduled maintenance could overlap and reject without a handler | Added a shared local scheduler that coalesces overlapping ticks, handles failures without logging raw diagnostics, and drains active work before closing connections. Existing database coordination across replicas is unchanged. |
| Full export included annotations for excluded assets | Apply active-asset conditions to the annotation relation as well as the asset relation. |
| Health counts unnecessarily used raw SQL | Use Prisma queries and the generated `Job.fields.maxAttempts` field reference for column comparison. |
| Root validation omitted realtime | Root lint and typecheck now include all five workspace packages. |
| Dataset pagination-link helper rejected a valid full query object at compile time | Accept the complete validated query type while continuing to use the explicit pagination argument. |
| Verification script hardcoded a provider, image, model, and class list | Read validated deployment configuration and explicit verification inputs; create the artifact directory and reject redirects. The live script was not executed. |
| Operational logging printed a MinIO access key | Remove access-key values from sync-script log messages; sanitize the worker lifecycle-policy warning. |
| Source-import fixture used an obsolete credential field | Change the test fixture to the actual `personalAccessToken` contract. No production validation was relaxed. |

## Execution flows examined

| Flow | Evidence and boundary checked |
| --- | --- |
| Authentication and authorization | Session hashing/rotation, permission matrix, dataset membership, concealed resource lookup, annotation create/update boundaries. Authorization remains in Next.js. |
| Direct/local-folder upload | Capability validation, dataset access, object inspection, metadata publication, duplicate publication and cleanup paths. Binary storage remains MinIO. |
| Repository import | Preflight contracts, URL/redirect policy, durable creation, source resolution and worker dispatch. Port-bound fixture tests rerun outside the sandbox. |
| Job lifecycle | Post-commit enqueue, strict `{ jobId }` queue contract, durable claims, successor retries, recovery, maintenance scheduling and safe status projections. |
| Image/video annotation | Canonical geometry, revision-guarded updates, asset review freeze, workspace engine registry, canvas action boundaries and AI result persistence. |
| AI | Model catalog, task submission, provider resolution, durable external task handoff, polling, cancellation and image/video completion. Remaining race findings are listed above. |
| Export and cleanup | Manifest filtering/redaction, retry contract, orphan dry-run configuration, maintenance coordination and shutdown. Destructive GC was not run. |
| Collaboration/realtime | Transactional outbox, worker relay, ticket scope/expiry, gateway revocation, presence and validation coverage. ADR 024 explicitly approves the delivery-only gateway; it is not treated as a duplicate command API. |
| Deployment/tooling | Workspace scripts, Compose syntax/defaults, source configuration, production build and existing test organization. |

These are static/code/test findings, not proof of every runtime interleaving or a line-by-line certification of every file.

## Validation evidence

- `pnpm build`: passed, including Next.js compilation/type validation and worker compilation. The first attempt failed because the sandbox blocked Turbopack's local CSS-processing port; the approved rerun passed.
- `pnpm typecheck` and `pnpm lint`: passed across web, worker, domain, queue and realtime.
- Both Compose files passed `docker compose ... config --quiet`; the sync script passed `bash -n`; `git diff --check` passed.
- Worker node-test sweep: 63 files, 199 reported tests, 73 passed and 126 skipped. No reported test failures. Database/MinIO/Redis cases were not enabled.
- Web node-test sweep: 188 files, 493 reported tests, 151 passed, 11 failed and 331 skipped initially. Nine failures involved local server binding; the affected provider/security suites subsequently reported 10 passed and four skipped outside the sandbox. The stale source-import fixture was corrected and both of its tests passed. The unguarded realtime database test remains unverified, and skipped-suite cleanup errors mean this sweep is **not an integration pass**.
- Vitest workspace/source-policy suites: ten files, all 39 tests passed.
- New configuration, scheduler and annotation-authorization regressions passed. The dataset-library query test passed; its database test skipped. New image ownership and export consistency database regressions were added but skipped without PostgreSQL.
- No live AIOZ submission, migration application, destructive cleanup, full browser acceptance session, or multi-worker runtime exercise was performed.

## Completion record

**Files created**

- `apps/worker/src/queue/periodic-task.ts`
- `apps/worker/tests/config.test.ts`
- `apps/worker/tests/queue/periodic-task.test.ts`
- `apps/web/tests/annotation-api/annotation-create-authorization.test.ts`
- `docs/code-review-2026-09-12.md`

**Files modified by this review**

- `.env.example`, `package.json`, `docker-compose.yaml`, `docker-compose.review.yaml`, `REVIEW.md`
- `packages/domain/src/provider-config.ts`
- `apps/web/src/lib/ai/ai-model-service.ts`
- `apps/web/src/lib/annotations/annotation-service.ts`
- `apps/web/src/lib/datasets/dataset-library-query.ts`
- `apps/web/src/app/api/health/route.ts`
- `apps/web/src/components/imports/import-form.tsx`
- `apps/web/tests/ai/ai-model-catalog.test.ts`
- `apps/web/tests/ai/ai-model-labels.test.ts`
- `apps/web/tests/repository-preflight/source-import-contract.test.ts`
- `apps/worker/src/config.ts`, `apps/worker/src/readiness.ts`
- `apps/worker/src/jobs/ai-prediction-writer.ts`
- `apps/worker/src/jobs/export-manifest.ts`
- `apps/worker/tests/jobs/ai-prediction-writer.test.ts`
- `apps/worker/tests/queue/export-manifest.test.ts`
- `apps/worker/tests/providers/ai/aioz-annotation-services-provider.test.ts`
- `scripts/sync-dev-to-review.sh`, `scripts/verify-live-aioz.ts`
- `docs/aioz-annotation-services.md`

**Commands to run**

```sh
pnpm build
pnpm typecheck
pnpm lint
docker compose -f docker-compose.yaml config --quiet
docker compose -f docker-compose.review.yaml config --quiet
(cd apps/web && pnpm exec vitest run tests/workspace/*.vitest.spec.ts tests/workspace/*.vitest.spec.tsx tests/source-connections/*.vitest.spec.ts)
```

For node regressions, run from the relevant app directory:

```sh
# apps/worker; no deployment environment required
node --import tsx --test tests/config.test.ts tests/queue/periodic-task.test.ts
# apps/web; no deployment environment required
NODE_ENV=test node --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test tests/annotation-api/annotation-create-authorization.test.ts tests/ai/ai-model-catalog.test.ts tests/ai/ai-model-labels.test.ts
```

Run database/runtime suites separately with their existing explicit integration flags and isolated PostgreSQL/Redis/MinIO configuration. Do not source the development environment merely to turn every integration gate on.

**Environment variables needed**

AI: `AIOZ_ANNOTATION_SERVICES_URL`, `AIOZ_COMPANY_API_KEY`; optional `AIOZ_ANNOTATION_SERVICES_TIMEOUT_MS`. Existing endpoint aliases remain accepted. The optional live verification script additionally requires `AIOZ_VERIFY_IMAGE_URL`, `AIOZ_VERIFY_MODEL_ID`, and `AIOZ_VERIFY_CLASSES` (a JSON string array). `GITEA_DOMAIN` overrides the new local default. Remote deployments must configure their existing public MinIO/Gitea URLs and CORS origin explicitly. `MINIO_ORPHAN_SCAN_DRY_RUN` accepts only `true` or `false`. Existing foundation variables remain required for runtime/integration operation. No `.env` or `.env.local` file was changed.

**Database migration changes:** None. Existing migrations and generated Prisma sources were not edited by this review.

**Known limitations:** Remaining findings and skipped runtime verification above. Credentials must be handled operationally. The working tree contains other ongoing work, so rerun validation after combining further edits.

**Next recommended phase:** Close the current hardening findings and controlled integration evidence first. The shareable-invitation extension in Phase 024 still has explicit T095–T099 approval gates; this review does not approve or implement it. No future phase was implemented early.
