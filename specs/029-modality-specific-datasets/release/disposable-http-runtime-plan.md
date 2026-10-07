# Receipt-owned disposable HTTP runtime — design v3 (FROZEN in design)

**Status: design APPROVED/FROZEN 2026-10-06 (release-owner decisions D1, D11 and the runtime decisions below). No code, command-catalog entry, container, network or run has been added; implementation is a separate change set on the A2 branch. Shared dev is never involved.**

**Approved runtime decisions:** the separate disposable-HTTP-runtime change set is approved in design; the existing pinned MinIO and Redis images are reused; R-B (receipt-owned container from the exact worker image) is the worker form. Approved worker limits: **2 CPUs, 1 GiB memory, 256 MiB tmpfs, `--pids-limit 256`, read-only root, all capabilities dropped, no bind/host mounts, no external egress** — verification-runtime defaults only, **not** production capacity acceptance. **R9 = M1 is approved** (prefix-scoped MinIO identities); this runtime is where it is proven first (step S0 below). **Stage 1** is the canonical 25-migration HTTP-runtime proof with no A2-worker dependency; **Stage 2** is the future 26-migration A2 end-to-end proof; **neither stage closes G3 or G5.**

Written for: the release owner and the engineer who will implement the runtime plan.

## 0. Separation from the current rollout (D1)
This runtime is part of the **follow-on A2 workstream** and of the HTTP-suite repair; it must not touch, delay or re-pin the current M24/M25 rollout. Binding rules:
- New files only (`scripts/db-safety/runtime-http-suite.mjs`, new catalog entries, new offline tests, new container-pin verification module). **No edit** to `runtime-suite.mjs`, `runtime-check.mjs`, `runtime-child.mjs`, `runtime-authority.cjs`, `guard.mjs`, `disposable-test.mjs`'s existing plans, the `g4:*`/`g5:*`/`release:*` commands, `PROPOSAL_CHAIN`, `RELEASE_COUNTS`, the launcher pins or `release/shared-dev-execution-package.md`. (Anything unavoidably shared is *imported read-only*; if a shared module truly needs a change it is split out as its own reviewed change, outside the rollout window.)
- Stage 1 runs on the canonical **25-migration** chain and needs nothing from A2. Stage 2 (A2) runs only on the future **26-migration** chain through its own plan id; the 25-chain plans stay untouched.
- The work lives on a branch separate from the one used to build the rollout images; it never alters a file in `IMPLEMENTATION_FILES` or the image-verifier source list before the rollout completes.

## 1. Why this is needed (evidence)
- `apps/web/tests/dataset-metadata/http-routes.test.ts` asserts `"A receipt-owned disposable HTTP runtime is required before fixture writes."` (`runtime = process.env.G1_RUNTIME_RECEIPT ? authority.receipt() : null`). The generic focused plan provides none, so 3 of its 21 tests fail with that assertion (run `20261006T082826Z-e66ff174`: 18/21).
- `upload-routes.test.ts` and the `local-folder-import` HTTP suites start their own `next start` (ports 3115/3113) and use compose-network names (`http://minio:9000`); they cannot run under a receipt. `web:test:direct-upload` / `web:test:local-folder-import` are not in `SUPPORTED_COMMANDS`.
- The only receipt-owned HTTP runtime is the G4/G5 supervisor (`runtime-suite.mjs`: roles `probe/provider/web/worker/legacy`, web 55470, provider 55472, launched via `g3-rehearse.py`), bound to the exact commands `g4:runtime:safety|e2e` / `g5:runtime:e2e` and part of the G4/G5 evidence trail — it must not be edited or reused as-is.

## 2. Topology (all disposable, receipt-registered, loopback or plan-owned internal network)

| Component | Form | Notes |
| --- | --- | --- |
| PostgreSQL 16 | fresh container (maintenance-plan provisioning), G1 pins, `127.0.0.1:5549x`, system id ≠ application's | canonical chain via receipt-bound deploys (25 for stage 1, 26 for stage 2) with history/manifest assertions identical to the chain plans |
| Redis 7 | fresh container, random password, per-plan BullMQ prefix/DB | |
| MinIO | fresh container, random root credentials, bucket `g1-<token>` | real presigned POST, CORS, stat/copy; **from step S0 onward the web, worker and verifier run as three non-root identities** (I-WEB, I-WORKER, I-VERIFIER; contract §5.5) with prefix-scoped policies; the root credential exists only inside the supervisor for provisioning and verification and is never passed to web, worker or test processes |
| Web | host process, existing `runtime-child.mjs web` role | env generated in-process; `MINIO_PUBLIC_ENDPOINT` = the disposable MinIO's loopback endpoint |
| **Worker (stage 2)** | **receipt-owned container from the exact worker image (R-B)** | §3 |
| Test processes | host children, allowlisted files only | each with its own child receipt |
Ports for the new plan come from a range disjoint from G4/G5 (55470/55472 are not reused), e.g. 55480–55489, allocated by the plan and recorded.

## 3. Worker container (R-B) — isolation and pinning

**Image pinning.** The container is created from an image referenced by **content digest** (`sha256:…`), never a tag. Before use: `release-image-verify.mjs --service worker --revision <R'>` must pass (labels, no migrate/seed startup path, no credentialed ENV, byte-identity of key files against the commit, no `.env`), and the plan records `{imageId, revision, ffprobeVersion}` in its evidence (`processorVersion` for `MediaVerification` is derived from the same values). A floating `:latest` or an unverified image refuses the run (`RUNTIME_WORKER_IMAGE_UNPINNED`). The host gets **no** ffmpeg/ffprobe install (D11).

**Network.** A plan-owned user-defined bridge network `phase029-http-<token>` created with `--internal` (no route to the host or the internet, DNS by alias only). PostgreSQL, Redis and MinIO are attached to **both** their loopback-published default bridge (for the host web/test processes) and this internal network (aliases `pg`, `redis`, `minio`). The worker container is attached to the internal network **only** — no published ports, no default bridge, no host network, no access to ports 3000/5433/6379/9000 of the application stack. Because the Node-level `network-fence.cjs` preload does not exist inside the container, **the Docker network is the fence**; its identity (id, `internal: true`, member list) is verified before and after start and a mismatch aborts (`RUNTIME_WORKER_NETWORK_MISMATCH`).

**Container hardening and secrets.** `--read-only` root filesystem with a size-bounded `tmpfs` for the media temp workspace (`maxTemporaryBytes`), `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root user, `--pids-limit`, memory/CPU limits, no bind mounts, no Docker socket, no `--env-file`, no `.env` (the image is `.dockerignore`d of `.env*`). Environment variables are supplied by name (`-e NAME`) from the supervisor's process environment, never on a command line or in an evidence file; values are generated in-process (database password, Redis password, MinIO credentials are the disposable ones; the worker alias hosts replace the loopback ones). Labels: `annotation.safety=runtime-http-worker`, `annotation.run=<token>`.

**Role boundary.** The worker consumes only the disposable Redis queue and reads/writes only the disposable PostgreSQL and MinIO; it also runs the image's periodic scanners against those same disposable stores (orphan/recovery/import-timeout), which is intended and part of what the suite exercises. It never receives the application's DATABASE_URL or credentials (clean env, receipt-checked env allowlist).

## 4. Receipt boundaries (nothing weakened, one new record type)
1. **G1 base receipt per deploy/seed child** — unchanged, bound to an exact command name; registry entries removed by exact id at cleanup.
2. **Runtime receipt** (`G1_RUNTIME_RECEIPT`/`runtime.json`) lists the roles: `probe`, `web`, `worker-container`, and the allowlisted test children. Tests discover the runtime through `runtime-authority.receipt()` exactly as `http-routes.test.ts` does and **stop spawning their own servers**.
3. **Child receipt per allowlisted test command**, pinned in the plan topology like `MAINTENANCE_COMMANDS`; a test file that is not in the pinned table cannot run (`RUNTIME_TEST_NOT_ALLOWLISTED`). Static import allowlists (as for `verify-test:*`) keep tests inside the disposable environment.
4. **`test-entry.cjs` as the first line of every test file** (the policy test that enforces it is unchanged).
5. **Container record (new):** `{role:"worker", imageId(digest), networkId, containerId, labels, command, envKeys(sorted names only), readOnly, capDrop, internalNetworkOnly}` written to the evidence and re-verified by a new `verifyWorkerContainer()` module before the first test and after the last; any drift aborts and fails the run. This is a new module — it does not modify `guard.containerIdentity`.
6. **Probe first:** the existing `probe` role proves the host-side fence denies ambient ports (3000, 5433, 6379, 9000); an additional **container probe** (a throwaway container on the same internal network) proves the internal network has no egress and no route to the host (`RUNTIME_INTERNAL_NETWORK_HAS_EGRESS` on failure).
7. **No ambient configuration, no secrets in evidence:** clean child env, no `.env`, secrets generated in-process; evidence redaction and secret scan as in the maintenance plan.
8. **Cleanup:** identity-based removal of every container, volume, network and registration by exact recorded id, then the independent verifier (`cleanup-verify.mjs` extended with the network and worker container expectations as a new verifier module, no change to the existing expectations format for old plans). PASS requires both.
9. **Scope flags:** `countsAsG3Evidence:false`, `countsAsG5Evidence:false`, `notAuthorizationForSharedDevExecution:true`, `notPartOfRolloutPackage:true`.

## 4a. Step S0 — storage-authority proof (first deliverable; no A2 code, no worker, no M26)
Runs on the stage-1 topology (PostgreSQL optional; MinIO + web/test processes are what matter) **before** any A2 implementation uses the sealed namespace. Command id `http:storage-authority`, a fixed allowlisted test file plus a provisioning module:
1. **Provisioning (supervisor-only, root):** create the bucket, the three users and their policies exactly as contract §5.5 (explicit `Deny` on `verified-uploads/*` for I-WEB and I-WORKER; no bucket-admin for any app identity; lifecycle set here, not by the apps). Tooling: MinIO has no admin API in `minio-js`, so provisioning uses a **receipt-owned, short-lived `minio/mc` container pinned by digest** on the internal network, credentials passed by environment name only (never on a command line or in evidence). *Decision R10 (pinned `mc` digest) is required; the locally present `minio/mc:latest` is not acceptable as-is.*
2. **Negative evidence battery** (each identity's own credentials; matrix, positive controls and the "re-stat unchanged" check are specified in contract §5.5): PUT overwrite/create, copy-to-S, delete, multipart verbs, tagging/retention/legal-hold, presigned PUT/POST signed by I-WEB naming S (fail at use), tampered POST `key`, bucket-level admin, plus positive controls (I-WEB uploads/deletes in staging and reads S; I-WORKER writes O and reads S; I-VERIFIER copies T→S, reads/deletes S, deletes T, cannot write T/O).
3. **Static audit test** (`apps/web/src`, `apps/worker/src`, `packages/*/src`) against the recorded allowlist (contract §5.5); fails on any new mutating MinIO site.
4. **Readiness probe check:** a process started with a root or shared credential must fail its sealed-write readiness probe closed.
PASS requires the standard evidence set (run id, cleanup of the `mc` container too, independent verification) and counts as neither G3 nor G5 evidence.

## 5. Stages and suites (exact allowlist, one command id each)
| Stage | Command id | File | Worker container |
| --- | --- | --- | --- |
| S0 (storage authority) | `http:storage-authority` | new suite + provisioning module (§4a) | no |
| 1 (25-chain, no worker) | `http:dataset-metadata` | `apps/web/tests/dataset-metadata/http-routes.test.ts` (the 3 blocked tests) | no |
| 1 | `http:direct-upload` | `upload-routes.test.ts` after the rewrite (IMAGE/AUDIO/TEXT cases, mismatches, POST-policy, CORS against the runtime MinIO) | no |
| 1 | `http:local-folder-modality-assets` (+ `start-route`, `commit-route` as separate ids) | after `http-fixtures.ts` sends `modality` and uses the runtime port | no |
| 2 (26-chain, A2) | `http:media-verification` | new A2 suite (contract §13 rows 7–21) | **yes (R-B)** |
Stage 1 provisions Redis for enqueue with no consumer (also the correct fixture for "delivery pending" cases). Stage 2 is blocked until M26 exists and passes its own G-MIG disposable proof.

## 6. Acceptance criteria for the plan itself
- PASS requires: expected migration count with frozen M24/M25 checksums (+ M26 for stage 2); schema manifest count for that chain; probe and container-probe denials; web readiness; worker container identity verified; each allowlisted suite exits 0 with the exact expected test count; primary + independent cleanup (including network and worker container); no leftover `annotation.safety` object; secret scan clean.
- Negative controls: wrong runtime command, ambient target, non-allowlisted test file, tampered receipt, unpinned/mismatched worker image, worker attached to the default bridge, network without `internal` — each refused.
- Offline unit tests (fakes) for topology, catalog, receipt-per-child, container-record verification and cleanup land before any real run; a mutation check (disable the port discovery, the network check or the image pin) must make the plan fail.

## 7. Relation to the blocked tests (receipt requirement not weakened)
- `web:test:dataset-metadata`: the 3 HTTP tests move to `http:dataset-metadata` in stage 1; the focused plan keeps its 18 passing tests and is documented as "HTTP tests covered by `http:dataset-metadata`" — it is not modified to pass.
- `upload-routes.test.ts` and the `local-folder-import` HTTP suites are rewritten only after the T022/A2 behavior exists and this runtime is available; until then they stay unexecuted and are reported as not-evidence.

## 8. Work breakdown (on the A2 branch)
0. **S0 first** (§4a): provisioning module + negative-evidence suite + static audit, offline fakes first, then a real disposable run.
1. Offline tests + catalog + supervisor skeleton with fakes (no containers).
2. Stage 1 real run: trivial smoke test, then `http:dataset-metadata`.
3. Fixture/helper refactor (Dataset-per-modality, runtime port discovery), corrected IMAGE/AUDIO/TEXT suites.
4. Worker-container module + container/network verification + cleanup extension (offline first).
5. Stage 2 with the A2 suites after M26.
Each step ends with the standard evidence set (run id, cleanup, independent verification).

## 9. Remaining decisions
- **R9 (M1), R10 and R11 are decided.** R10: `minio/mc` is a provisioning-only tool for the disposable runtime, pinned by immutable digest (floating tags never authoritative; the S0 receipt records repository/digest, resolved image identity, mc version, artifact hashes and cleanup evidence; never added to application/release images). R11: bucket creation/administration, identity/policy provisioning and lifecycle administration belong to the provisioning boundary; applied fail-safely (provision → verify → prove startup without admin authority → disable obsolete application startup administration), replay-tested, missing/wrong policy fails closed, and infrastructure lifecycle rules must not replace A2's explicit object-cleanup/audit semantics. **S0 is implemented** — see `release/s0-storage-authority.md`; its candidate image digests await the owner's freeze before any run counts as authoritative.
- Adding the new supervisor/modules under `scripts/db-safety/` as a separate change set on the A2 branch: **approved in design**.
- Reuse of the pinned `minio/minio` and `redis:7-alpine` images: **approved**.
- Resource limits including `--pids-limit 256`: approved (see header).
