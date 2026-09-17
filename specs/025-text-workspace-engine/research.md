# Phase 025 research and decisions

Date: 2026-09-15. Scope: planning against the current working tree; no application implementation. Read this with [spec.md](spec.md), [data-model.md](data-model.md), and [plan.md](plan.md).

## Evidence and limits

| Area inspected | Finding | Consequence |
| --- | --- | --- |
| `apps/web/src/lib/workspace/workspace-engine-registry.tsx`, `workspace-read.ts` | TEXT is registered but receives a metadata-only read model. IMAGE/VIDEO have mature editing paths. | Extend the engine capability boundary and safe TEXT projection; retain the common workspace route. |
| `apps/web/src/components/workspace/text-engine.tsx`, `text-toolbox.tsx` | Placeholder reader; toolbox uses image annotation state and unavailable controls. | Replace with a TEXT store, reader, semantic commands, and capability-driven controls. |
| `workspace-header.tsx`, `properties-panel.tsx`, `placeholder-properties-tabs.tsx` | Shared navigation/save integration explicitly calls image/video flush; workflow submission does not establish a successful current-revision save barrier. | Introduce an active-engine save contract, then adapt each existing engine and regression-test callers. |
| `apps/web/src/lib/asset-upload.ts`, repository import worker | TEXT objects are stored in MinIO; new `TextAsset` rows contain empty tokenization/metadata, not inline content. | Prepare the existing object; do not invent another source. |
| `apps/web/src/lib/upload-verification.ts` | TEXT validation decodes a 64 KiB prefix; this does not establish complete UTF-8 validity and may cut a multibyte character. Existing fingerprint is not a raw-byte digest. | Full bounded verification is required for workspace readiness. Correct prefix-boundary handling in the affected import path without expanding supported formats. |
| `prisma/schema.prisma` | Generic Annotation has geometry, revision, label, TEXT types, and endpoint self-relations; TextAsset has optional legacy content. | Reuse Annotation; do not infer semantics from unused columns. |
| Annotation/workflow services | Ownership distinctions and parent revision updates already exist. | Reuse authoritative permission checks and editable-asset transaction guards. |
| Label mutation validation | Basic label metadata is supported; TEXT scope/group/cardinality/endpoint policies are not a complete existing capability. | Add a small validated taxonomy configuration surface, including concurrency semantics. |
| Export manifest builders | Generic geometry is exported; existing endpoint scalar fields are not projected. | Add explicit TEXT export metadata and endpoint references to both export paths. |
| Realtime/outbox enum | No annotation-content invalidation event exists. | Add a metadata-only content invalidation through the existing transactional outbox; no direct browser/worker event authority. |
| Structure metadata | No authoritative linguistic tokenizer was found. | Defer durable token/sentence/paragraph indices. |

Read-only Prisma inventory of the configured database succeeded on this date: **3 TEXT assets; 3 object-only; 0 inline-only; 0 both; 0 missing both; 0 with annotations**. Only aggregate counts were emitted. The default package Prisma client was unsuitable; the repository's existing generated client was used without regeneration. Initial sandbox connection failed; the permitted external read succeeded. No rows were written. Object bytes, other deployments, and production runtime behavior were not validated. An object reference does not prove that an object is readable or valid UTF-8. Repeat the inventory for the actual rollout target and validate every source before declaring it ready.

The tree already contains unrelated application, migration, generated-client, and review changes. This plan does not claim those changes pass runtime checks. `docs/code-review-2026-09-12.md` and the specification checklist contain broader findings; only blockers in affected TEXT/shared paths enter this phase.

## D1 / G1: positions and Unicode

**Decision:** UTF-8 is the source encoding; `UTF16_CODE_UNIT` is the sole durable offset unit. Ranges are half-open `[startOffset,endOffset)`. Valid endpoints must be in the authoritative extended-grapheme boundary map. Preserve BOM, normalization form, whitespace, and original CR/LF sequences. Reject invalid UTF-8; never replace malformed bytes or normalize source text.

**Rationale:** DOM text offsets and JavaScript string slicing use UTF-16 code units. Grapheme-boundary validation prevents splitting a surrogate pair, combining sequence, emoji sequence, or CRLF. Source bytes and position units are distinct concepts. Fatal decoding with `ignoreBOM: true` preserves a UTF-8 BOM as U+FEFF in the decoded source. See the [Encoding Standard](https://encoding.spec.whatwg.org/#interface-textdecoder), [ECMAScript string slicing](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.slice), and [Unicode grapheme rules](https://www.unicode.org/reports/tr29/#Grapheme_Cluster_Boundary_Rules).

**Alternatives considered:** UTF-8 byte offsets complicate DOM mapping; code-point offsets require a second translation everywhere; grapheme ordinals depend on segmentation versions and do not match standard string offsets. Browser-only segmentation can differ between clients. None is a second accepted wire format.

| Original decoded source | UTF-16 length | Valid endpoints | Required example |
| --- | --- | --- | --- |
| `OpenAI builds AI.` | 17 | Every integer 0–17 | `OpenAI` = `[0,6)` |
| `A😀B` | 4 | 0,1,3,4 | Emoji = `[1,3)`; byte range would be `[1,5)`, code-point range `[1,2)`; reject endpoint 2. |
| `e\u0301` | 2 | 0,2 | Whole accented grapheme `[0,2)`; reject endpoint 1. |
| `é` | 1 | 0,1 | `[0,1)`; never normalize it into the preceding fixture. |
| `👩‍💻` | 5 | 0,5 | Whole emoji `[0,5)` only. |
| `中文` | 2 | 0,1,2 | First character `[0,1)`. |
| `\uFEFFA\r\nB\rC\n` | 8 | 0,1,2,4,5,6,7,8 | BOM counts; CRLF `[2,4)` is indivisible. |
| empty string | 0 | 0 | No span; document classification remains possible. |

The local measured profile was Node 22.23.1 / ICU 78.2 / Unicode 17.0. Pin and verify a deployment profile before preparing sources; this local measurement is not a declaration of deployed versions. The private worker writes a versioned boundary artifact in MinIO with the source digest and actual profile. Web reads and validates that artifact; it does not recompute with a different ICU. Browser consumers use supplied boundaries. Existing sources keep their recorded boundaries across runtime upgrades; unsupported/corrupt artifact versions block writes pending explicit repair.

## D2 / G2: immutable source and readiness

**Decision:** MinIO is the canonical binary authority. A worker verifies the complete bounded byte stream, computes SHA-256 of those original bytes, decodes exactly, and stores only safe source metadata in PostgreSQL. `sourceIdentity` is `sha256:<lowercase raw-byte hex digest>`; it is always scoped by asset ID, not an access capability. The approved source pointer is server-only and immutable for Phase 025. Persist the grapheme map in a private MinIO derivative. Do not rewrite the original to a normalized copy.

**Rationale:** Current imports already use objects. Binding spans to an exact digest prevents offsets silently attaching to a different document. A normal workspace GET is read-only; an explicit authorized prepare request creates/reuses a common `Job` of proposed type `TEXT_SOURCE_PREPARE`. Worker claims, attempts, terminal state and retries use the existing Job lifecycle. BullMQ receives only `{jobId}`. Source readiness is a projection of verified source metadata plus this Job, not a second job-state table.

**Alternatives considered:** Treating `TextAsset.content` as canonical duplicates binary authority; silently preferring either conflicting copy loses information; decoding partial objects as complete text invalidates ranges. Expensive/legacy reconciliation in a page render violates execution boundaries.

| Stored population | Handling |
| --- | --- |
| Object only | Verify entire supported source and bind identity; existing configured DB population is this case. |
| Object plus identical decoded inline content | Bind object; leave legacy content inert and unchanged. |
| Conflicting copies | `SOURCE_MISMATCH`; block editing until explicit reconciliation outside automatic preparation. |
| Inline content only | Explicit maintenance reconciliation Job creates an immutable MinIO object idempotently; reject lone surrogates and ambiguous old ranges; retain the legacy field. Do not silently migrate on read. |
| Neither / unreadable object | `SOURCE_UNAVAILABLE`; safe retry only when recoverable. |
| Existing annotations with unproven units/source | Quarantine from editable TEXT projection; separately verified migration required, never guess. |

Initial configurable whole-document envelope: 1,048,576 source bytes and 100,000 UTF-16 code units, inclusive. Reject above either bound with `UNSUPPORTED_SIZE`; no truncation. Existing upload limits remain intact: an accepted import can be too large for this initial reader. Validate limits once on the server and return effective capabilities, not environment variables, to the UI. Raising limits requires the performance suite; future chunked reading is outside Phase 025. Source requests verify source digest and boundary metadata before exposing editable readiness, use authorized application routes, and send `Cache-Control: private, no-store`.

## D3 / G3: annotation authority

**Decision:** Extend generic Annotation using existing types `NAMED_ENTITY_RECOGNITION`, `TEXT_CLASSIFICATION`, and `TEXT_RELATION`. Geometry holds a tagged source-bound shape; document scope has no range. Existing `fromAnnotationId`/`toAnnotationId` are the only relation endpoint authority. Existing start/token/text-value columns stay null for new TEXT writes. API/export projections derive selected text/ranges from geometry and source; no second persisted text copy.

**Rationale:** Existing revision, ownership, workflow, labels, exports, and audit apply directly. An unlabeled NER span is a generic highlight until an eligible entity label is assigned. Sentiment uses a configured classification label, not a new state machine.

**Alternatives considered:** Separate span/classification/relation tables duplicate annotation lifecycle and require cross-table review coordination. A sidecar per annotation adds joins without new authority. Storing endpoints and ranges entirely in untyped properties loses relationship checks. Chosen additions are source/policy metadata and durable mutation receipts, not parallel annotations.

## D4 / G4: transactions, policy and referential integrity

**Decision:** Every TEXT mutation uses a single Prisma transaction with authorization recheck, a dataset row guard, then the existing editable-asset write guard. All TEXT writers and taxonomy writers follow this ordering. After obtaining guards, validate current source/policy, annotation revisions and endpoints, perform writes, advance parent revision once, store replay receipt, and create the content invalidation outbox event atomically. Use Serializable isolation and bounded retries for retryable database conflicts only; stale expected revisions return 409.

Add `Dataset.textPolicy`, `textPolicyRevision`, and `textMutationRevision`. Ordinary annotation transactions increment only the mutation guard counter; actual taxonomy changes also increment the configuration revision. This deliberately serializes TEXT taxonomy-sensitive writes within one dataset initially. Measure contention before considering finer locks; do not introduce raw SQL locks.

All relevant label edits/deletes must participate in this guard. Validate existing dependent annotations before policy changes; reject changes that invalidate classification membership/cardinality, endpoint compatibility, or label references. Physical deletion of referenced labels is refused, including existing generic delete entry points. Relations use same-source span IDs and directed pair/type uniqueness. Block referenced-span deletion. Generic/bulk deletion paths cannot bypass these checks; dataset/asset cleanup removes relation rows before endpoints in one authorized transaction. Add explicit restrictive endpoint FKs and supporting indexes through Prisma after migration preflight.

Single-label classification replacement requires the current group's complete membership `{id,revision}` set. Validate permissions for each removed annotation; atomically retain, remove or create members. Multi-label is explicit. No hidden replacement of someone else's annotation through a create permission. Policy absence means one implicit document group with SINGLE cardinality. Groups and label/type compatibility are persisted configuration, never sample constants.

Durable mutation receipts keyed by actor, asset and operation ID store a canonical request hash and safe result revisions/IDs, not source content. A repeated identical command returns the committed receipt without another revision bump/event; different input under the same key returns conflict. Receipts survive annotation deletion and are retained until asset purge. Replays recheck current authorization and do not overwrite a newer client projection with an old receipt.

**Alternatives considered:** Client UUID alone cannot distinguish a stale recreate after delete; check-then-write without guards races; JSON-only references permit dangling endpoints; cascading endpoint deletion hides related work; unconditional single-label replacement loses concurrent edits. Database scalar constraints alone cannot enforce same-source JSON geometry or compatibility rules, so transactional validation remains mandatory.

## D5 / G5: derived structure

**Decision:** No durable linguistic token, POS, sentence or paragraph indices in this delivery. Word-wrap and search matches are ephemeral presentation. Language is existing metadata or unavailable, never guessed. Grapheme boundaries support safe character annotation and are not linguistic tokenization.

**Rationale:** No versioned tokenizer authority exists. Character spans satisfy the core use case without an AI provider or package.

**Alternatives considered:** Splitting on spaces fails multilingual text; visual lines change on resize; browser sentence segmentation varies with runtime. Future processing must use the same common Job/source identity boundary and record a versioned derivation contract.

## D6: shared workspace and export integration

**Decision:** Add a TEXT engine store and domain services, with an active-engine save barrier shared by the existing header/navigation. A barrier returns success plus current asset revision or an explicit failure/conflict; Submit uses that returned revision. Reconnect refetches protected data and explicitly reconciles dirty state. Presence reports only VIEWING/EDITING through semantic activity, never selections. Add `ANNOTATION_CHANGED` as a metadata-only outbox event and a taxonomy invalidation event through existing delivery; do not use workflow events to impersonate content edits.

Use normal selectable escaped DOM text with stable source segments, preserving `white-space: pre-wrap` and literal search mapping. Annotation highlights are derived intervals, not editable DOM or a full document copy per annotation. An accessible list/inspector resolves overlap and relation endpoints. No additional permanent workspace column. Existing image canvas remains react-konva.

Exports add an optional `text` projection to TEXT annotation records and safe source metadata to TEXT asset records within the existing manifest version. Existing IMAGE/VIDEO shapes stay unchanged. Both export builders use the same projection and a consistent database snapshot; every exported relation must resolve in the export set or the Job fails safely. See [contracts/workspace.md](contracts/workspace.md).

**Alternatives considered:** A TEXT route, workflow, websocket content channel or separate exporter would duplicate established boundaries. Full rich-text editors and new tokenizers add unsupported source transformations/dependencies.

## Gate disposition

G1, G3, G4 and G5 have concrete design decisions above. G2 has code plus actual configured-database inventory and a deterministic reconciliation policy; per-object verification and target-deployment inventory remain rollout prerequisites. The design does not certify unread objects. If target inventory reveals ambiguous old annotations/copies, stop migration and reconcile before proceeding. No architecture exception or new package is requested.

## Implementation-readiness review amendment

The shared contracts and reader ownership are defined in contracts/workspace.md and tasks.md. Both apps use packages/domain contracts; web source/boundary services use real private MinIO providers, not the local-file StorageProvider fallback. Limit defaults live once in the shared validated config module, wired to both deployments.

Preparation/read authorization is **dataset.read**. Repository evidence: `apps/web/src/lib/authorization.ts` grants it to every existing dataset member role; REVIEWER currently also has annotation.create. Tests must therefore verify gate independence without asserting a nonexistent built-in read-only role. `apps/web/src/lib/media-processing/ensure-media-processing-job.ts` currently gates media preparation with asset.upload; that is a contrasting existing policy, not evidence that TEXT preparation already uses dataset.read. The explicit TEXT decision makes read-required derivative preparation available during review, while retaining ordinary Job retry/cancel authorization and idempotent common-Job deduplication. Nonmembers remain concealed; policy reads use dataset.read and policy writes use label.manage.

Taxonomy writes use the dataset guard only; annotation writes also claim the editable asset. Replays resolve before asset revision increments. All policy/label changes share reference validation, configuration revision and transactional invalidation. Undo/Redo acceptance expands from spans in US5 to classifications in US3 and relations in US4. Shared IMAGE/VIDEO save checks run at adapter integration and again when TEXT/navigation integration lands. Closure evidence is recorded per command/suite, never as one generic quickstart result.

## Follow-up decisions for implementation readiness

## Custom property contract (U2)

Audit: `apps/web/src/lib/validation/video-annotation.ts` uses `z.record(z.string(), z.unknown())`; `video-properties-tabs.tsx` edits track-specific fields with whole-property replacement. `annotation-service.ts` initializes IMAGE properties to `{}` and `safe-annotation.ts` exposes unknown JSON. None provides a reusable bounded TEXT custom schema/editor. Reuse the common Annotation storage/revisions/permissions, not those permissive validators or specialized editors.

Implement one shared `packages/domain/src/text-properties-contract.ts`. The only editable top-level property namespace is `custom`. Create accepts `properties: {custom: {...}}` (omission means empty). Read-safe custom fields use the same schema. Keys match `^[A-Za-z][A-Za-z0-9_]{0,63}$`, case-sensitive; reject `__proto__`, `prototype`, `constructor` and reserved system keys `geometry`, `sourceIdentity`, `revision`, `labelId`, `fromAnnotationId`, `toAnnotationId`. No label/class/business category is hardcoded by this protocol.

A custom value is null, boolean, finite number with absolute value <=1e15, or a string <=2048 UTF-16 units. No arrays or nested objects; depth is one map below `custom`. At most 32 keys and 16384 UTF-8 bytes in compact JSON of the resulting custom map. Protocol bounds are centralized exported constants, not duplicated literals in routes/UI. Unknown top-level fields, reserved keys, unsupported values and oversized results return 422 with no mutation.

Updates use `propertyPatch: {set: {key:value}, unset: [key]}`; require at least one entry, unique unset keys and disjoint set/unset keys. `set` shallowly merges, null stores a real null, `unset` removes a key, omission preserves it. Unsetting a missing key is harmless; deleting all keys leaves `custom:{}`. Validate the post-patch map atomically. Preserve unrelated existing stored metadata without allowing it through this editor or exposing unallowlisted fields in the safe projection. Never copy selected source text automatically into properties. Custom metadata is annotation content, not Discussion.

Every patch requires the annotation expected revision, current source/policy context and own/any permission; frozen workflow forbids it. A new valid patch command follows normal single annotation/asset revision advancement, including a semantic no-op; exact receipt replay advances neither. Inverses restore missing-vs-null precisely via new guarded patches. The generic typed key/value editor in `text-custom-properties-editor.tsx` owns add/edit/null/remove actions and validation feedback for spans, documents and relations; classification membership changes remain separate commands.

PolicyWrite uses `expectedRevision` end-to-end in HTTP, service and tests; it compares the durable `textPolicyRevision`. The annotation command envelope retains `expectedPolicyRevision` because it distinguishes policy from each annotation expectedRevision. These are different command domains, not two aliases for PolicyWrite.

Foundation verification is scoped to transaction primitives; command-specific replay and policy/span/classification/relation races run only after their story commands exist. The guarded endpoint-relabel and count-admission protocols are specified in data-model.md. Generic TEXT reads share safe projection/pagination; no admission limit is used to suppress existing records. The single benchmark contract is benchmark/reference.json and quickstart.md; timing and correctness verdicts are separate mandatory closure gates.

Implementation setup: branch 025-text-workspace-engine created preserving the existing dirty tree. Configured database inventory repeated (3 object-only TEXT, zero annotated/legacy-inline rows). Local and deployed web/worker Unicode profiles match; evidence is in verification/runtime-profile.md.
