# TEXT domain and persistence design

This is a proposed additive design, not a migration. [Research decisions](research.md) establish the source and Unicode semantics. Existing domain entities remain authoritative.

## Source document

Keep `Asset` and its one-to-one `TextAsset`. Add nullable verified metadata to `TextAsset` so old rows remain readable as unprepared:

| Field | Meaning |
| --- | --- |
| `sourceIdentity` | Raw-byte SHA-256 identity, scoped to this asset. |
| `sourceEncoding` | `UTF8` after full fatal decoding. |
| `offsetUnit` | `UTF16_CODE_UNIT`. |
| `sourceByteLength`, `sourceCodeUnitLength` | Verified lengths; neither is inferred from filename or visual wrapping. |
| `boundaryArtifactKey`, `boundaryArtifactDigest` | Private MinIO pointer and integrity digest of the versioned grapheme map. Pointer never enters a browser DTO or export. |
| `boundaryProfile` | Validated JSON: artifact schema version, algorithm, actual Node/ICU/Unicode profile. |
| `preparedSourceFingerprint`, `preparedAt` | Detect source-pointer metadata changes since preparation; fingerprint is not a substitute for byte digest. |

Use the existing server-only Asset storage reference for the original object. Source and boundary artifact must agree on digest, unit and length. Return source identity and lengths only after authorization. `TextAsset.content` remains inert; no automatic removal or rewrite. Existing `tokenization` is not authoritative for durable indices. Existing language may be returned; absence remains null.

Readiness is `UNPREPARED | PREPARING | READY | UNAVAILABLE | INVALID_ENCODING | SOURCE_MISMATCH | UNSUPPORTED_SIZE | LEGACY_RECONCILIATION_REQUIRED`. Compute it from verified metadata, object checks and the latest relevant common Job. Do not create another independently writable lifecycle. Readiness failure can carry an allowlisted reason and permitted retry action, never upstream error text.

`TEXT_SOURCE_PREPARE` is an additive common Job type. Input contains actor/dataset/asset IDs, expected existing source metadata identity and allowlisted preparation mode; never full text or credentials. Recheck source metadata at commit so a stale preparation cannot bind a replaced source. Write derivatives under deterministic source/profile keys, reuse them on duplicate delivery, and commit metadata plus terminal Job outcome safely. Failed preparation leaves the source unchanged. Authorized retry follows existing predecessor/successor Job rules. First-delivery UI prepares object-backed sources; legacy-only repair is explicit maintenance, not a hidden fallback.

## Canonical annotation shapes

All records retain `Annotation.id`, dataset/asset IDs, author/updater, optional eligible `labelId`, status, properties, and revision. New annotations are manual DRAFT; asset approval does not rewrite individual statuses. Every shape has `schemaVersion: 1` and `sourceIdentity`.

```typescript
type TextGeometry =
  | { schemaVersion: 1; kind: "text-span"; sourceIdentity: string;
      offsetUnit: "UTF16_CODE_UNIT"; startOffset: number; endOffset: number }
  | { schemaVersion: 1; kind: "text-document"; sourceIdentity: string }
  | { schemaVersion: 1; kind: "text-relation"; sourceIdentity: string };
```

| Kind | Existing Annotation.type | Label and relationships |
| --- | --- | --- |
| Span | `NAMED_ENTITY_RECOGNITION` | Optional ENTITY label, compatible with TEXT. No endpoint refs. |
| Document | `TEXT_CLASSIFICATION` | Required CLASSIFICATION, SENTIMENT or INTENT label; membership/group derived from versioned dataset policy. No endpoints or range. |
| Relation | `TEXT_RELATION` | Required RELATION label and existing `fromAnnotationId`/`toAnnotationId`; both target span IDs. |

New TEXT writes leave `startChar`, `endChar`, token/sentence fields, `textValue`, image/video/audio fields null/default as appropriate. Do not accept those fields as alternate input. Selected text is `originalSource.slice(startOffset,endOffset)`; it is a derived inspector value, not persisted editable content. `properties.custom` and `propertyPatch` follow the explicit Custom property contract below; no unspecified existing definition registry is assumed. No arbitrary annotation-level review commands are exposed.

Validate finite safe integer endpoints, `0 <= start < end <= sourceCodeUnitLength`, and membership in the verified boundary map. Preserve whitespace. Allow overlaps/nesting; reject same asset/source/range/label duplicates (including null label) except an exact operation replay. Geometry patches cannot change source identity or annotation kind. Source replacement/rebasing is outside Phase 025.

Relations require distinct existing spans on the same dataset, asset and source; both endpoint labels must satisfy the relation policy. Unique directed `(asset, source, from, to, relationLabel)` is enforced under the transaction guard; reverse direction is distinct. Endpoint moves keep ID and relations. Incompatible relabeling fails. Deleting a referenced span fails until relations have been explicitly removed. Document or relation annotations cannot be endpoints.

## Dataset taxonomy policy

Add these fields to Dataset rather than a second taxonomy subsystem:

| Field | Default and contract |
| --- | --- |
| `textPolicy` JSON | Versioned empty policy: one implicit SINGLE document group, no invented labels/types. |
| `textPolicyRevision` integer | 1; increments on every relevant configuration or label-eligibility change. |
| `textMutationRevision` integer | 0; guarded increment serializes all TEXT writes and relevant taxonomy operations. Not a user-visible content revision. |

Policy schema contains `schemaVersion`, `classificationGroups` (`id`, name, `SINGLE|MULTI`, member label IDs), and `relationTypes` (relation label ID, allowed source/target entity label IDs, explicit unlabeled-endpoint booleans). Group IDs are generated durable identifiers. With no explicit groups all eligible document labels share the implicit SINGLE group. Once groups exist, every enabled document label belongs to exactly one group. Referenced labels must belong to the dataset with modality null or TEXT and an eligible scope. Unconfigured relation types are unavailable. Colors, hotkeys, languages and identities come from authorized records/configuration.

Expose changes through existing `label.manage` authorization and optimistic policy revision. Expand label configuration inputs/UI to set eligible scope/modality and policy. No read-time seeding. Reconfiguration that would invalidate current classifications or relations is rejected with safe affected counts/IDs only for authorized users; do not delete annotations implicitly. Block deletion or ineligible scope changes of referenced labels. Relevant existing generic label handlers must use the same transaction guard.

## Mutation receipts

Add `AnnotationMutationReceipt`: `id`, `assetId`, `actorId`, `operationId`, `requestHash`, bounded safe result JSON, `createdAt`; unique `(assetId,actorId,operationId)`, index asset ID. Store IDs/revisions/outcome only, no original source, selected text or private locators. Receipt lifetime is the asset lifetime, with authorized purge cleanup. It does not reference a live annotation as a required FK because deletion must not erase replay history.

Canonical hashing includes command kind, source/policy identity, expected revisions and all allowlisted command data (including property patches); distinguish omitted from explicit null according to the schema. Clients generate a new opaque operation ID for a new user intent and reuse it for transport retries. Identical receipt replay does not recreate deleted content, advance asset revision or emit another event; changed payload under the same ID conflicts. Receipt result is an acknowledgment, not permission to render stale annotation content; refetch authoritative state after replay when necessary.

## Atomic command algorithm

1. Validate strict Zod input and authenticate. Within the transaction, recheck current dataset membership and permissions, asset scope, archive/delete state and source authority.
2. Claim the Dataset mutation guard, then check an existing receipt. Authorized exact replay returns its outcome. New commands validate `expectedPolicyRevision` and acquire the editable Asset content guard in that order.
3. Validate annotation ownership using own/any permissions for every touched record, expected annotation revisions, current source, label policy, endpoint compatibility, duplicate rules and complete expected classification-group membership. Recheck authorization where membership changes can race using the established service policy.
4. Apply one semantic command atomically. Parent `Asset.revision` advances exactly once; each updated annotation revision advances once. Deletes require the current revision. Rejected validation or database conflict rolls back the parent claim too.
5. Commit receipt and `ANNOTATION_CHANGED` outbox record with the command. Only allowlisted entity IDs/revision hints are published after commit. Use the existing outbox dispatch Job; no content-bearing realtime payload.

Use Prisma Serializable transactions with existing bounded retry conventions for serialization/unique receipt races. Do not retry a stale client intent with newly fetched revisions. All interacting generic/bulk annotation deletes, policy edits, and label deletes must obey this boundary. Endpoint FK `onDelete: Restrict` and indexes on both endpoint columns provide additional protection; preflight existing data and test ordered asset/dataset cleanup before migration. No raw SQL is authorized.

Classification replacement takes the complete expected group member set of IDs and revisions, including the empty set. Membership mismatch conflicts even if the requested target label is otherwise valid. Remove only with applicable update/delete permissions, retain already selected identities where possible, and create only permitted new members. Group replacement, individual multi-label removal, relation changes and span changes are each a single semantic operation.

## Workflow and client state

Retain existing transitions: Start → IN_PROGRESS; Submit/Resubmit → NEEDS_REVIEW; Open Review records existing history without another state; Approve → REVIEWED; Reject → REJECTED; Start Rework → IN_PROGRESS. Existing service eligibility defines each origin state. NEEDS_REVIEW/REVIEWED/REJECTED reject prohibited content writes and inverse commands.

The per-asset TEXT store holds protected source, supplied boundaries, saved annotation snapshot, local semantic commands, save state and bounded undo history in memory only. Clear it on asset/scope/session changes. Selection, search, hover and relation previews are ephemeral. Serialize commands per asset, associate responses with operation and asset IDs, and never apply a late response to another asset or newer revision.

Undo/Redo submits a new revision-checked inverse command over the user's own command history. Undo delete creates a fresh ID and updates local history mapping; it cannot resurrect removed relationships implicitly. Each inverse follows current taxonomy/permission/workflow rules. Failed/conflicting inverse leaves the latest saved data intact. No global snapshot rollback and no undo of collaboration or workflow events.

The active engine implements `flush(assetId)` returning `{ok:true,assetRevision}` or `{ok:false,reason}`. Dirty work must finish before reading the current asset revision; header and every navigation caller await this result. A subsequent remote mutation is still caught by workflow's expected revision guard. Read failures do not count as successful flush. Explicit discard clears pending local intent and reloads protected current state.

## Migration and compatibility boundary

Proposed changes: nullable TextAsset verification metadata; Dataset policy/revision fields; mutation receipt table; endpoint indexes/restrictive FKs; common Job type; content/taxonomy invalidation enum additions. Use Prisma migrations only after target inventory passes. No historical rows are assigned guessed geometry, source digests or indices. No migration is generated/applied by this plan.

Unprepared TEXT reads expose readiness rather than crashing generic workspace reads. Existing IMAGE/VIDEO mutation and export schemas retain behavior. Safe TEXT serializers cover both new routes and generic annotation-read/export entry points so relation fields are not dropped and unsupported legacy geometry is never mistaken for a valid editable shape.

## Shared contracts and read-service boundary

The canonical TextSpanGeometry, TextDocumentGeometry, TextRelationGeometry, offset unit, source identity, schema version and safe serializer contracts are owned by `packages/domain/src/text-annotation-contract.ts`, exported through its package entry point. Both web and worker import this package; UI-only selection state may live in apps/web. Boundary artifact schemas, shared fatal decoding and validated source/annotation limits are sibling domain modules.

The web source-read service obtains a bounded private MinIO stream, verifies raw-byte digest and lengths/fingerprint, then loads the verified boundary artifact through the authorized bounded TTL/LRU loader. Cached maps are bound to dataset/asset/source/digest/profile and never bypass current authorization or durable identity checks. Source data is not cached or persisted in browser storage. Source reads and idempotent preparation require dataset.read, including frozen review states. Policy reads also use dataset.read; policy/eligibility writes use label.manage and a dataset-only guard. Only annotation mutations claim the editable asset and increment its review revision.

## Custom property contract (U2)

Audit: `apps/web/src/lib/validation/video-annotation.ts` uses `z.record(z.string(), z.unknown())`; `video-properties-tabs.tsx` edits track-specific fields with whole-property replacement. `annotation-service.ts` initializes IMAGE properties to `{}` and `safe-annotation.ts` exposes unknown JSON. None provides a reusable bounded TEXT custom schema/editor. Reuse the common Annotation storage/revisions/permissions, not those permissive validators or specialized editors.

Implement one shared `packages/domain/src/text-properties-contract.ts`. The only editable top-level property namespace is `custom`. Create accepts `properties: {custom: {...}}` (omission means empty). Read-safe custom fields use the same schema. Keys match `^[A-Za-z][A-Za-z0-9_]{0,63}$`, case-sensitive; reject `__proto__`, `prototype`, `constructor` and reserved system keys `geometry`, `sourceIdentity`, `revision`, `labelId`, `fromAnnotationId`, `toAnnotationId`. No label/class/business category is hardcoded by this protocol.

A custom value is null, boolean, finite number with absolute value <=1e15, or a string <=2048 UTF-16 units. No arrays or nested objects; depth is one map below `custom`. At most 32 keys and 16384 UTF-8 bytes in compact JSON of the resulting custom map. Protocol bounds are centralized exported constants, not duplicated literals in routes/UI. Unknown top-level fields, reserved keys, unsupported values and oversized results return 422 with no mutation.

Updates use `propertyPatch: {set: {key:value}, unset: [key]}`; require at least one entry, unique unset keys and disjoint set/unset keys. `set` shallowly merges, null stores a real null, `unset` removes a key, omission preserves it. Unsetting a missing key is harmless; deleting all keys leaves `custom:{}`. Validate the post-patch map atomically. Preserve unrelated existing stored metadata without allowing it through this editor or exposing unallowlisted fields in the safe projection. Never copy selected source text automatically into properties. Custom metadata is annotation content, not Discussion.

Every patch requires the annotation expected revision, current source/policy context and own/any permission; frozen workflow forbids it. A new valid patch command follows normal single annotation/asset revision advancement, including a semantic no-op; exact receipt replay advances neither. Inverses restore missing-vs-null precisely via new guarded patches. The generic typed key/value editor in `text-custom-properties-editor.tsx` owns add/edit/null/remove actions and validation feedback for spans, documents and relations; classification membership changes remain separate commands.

## Endpoint relabel integrity (C1)

The same Prisma Serializable transaction acquires the dataset then asset write guards before reading all attached incoming/outgoing relations. This guarded protocol serializes every endpoint relabel and relation writer for that asset; no raw SQL row locking is introduced. Revalidate the candidate label against every relation type and the other endpoint's current label/source. One incompatibility aborts the entire transaction, preserving span, relation and asset revisions and leaving receipt/outbox unchanged. Relation creation racing with relabel cannot evade this predicate because it uses the same guards. A valid relabel advances span and parent asset revisions; attached relation identities/revisions stay unchanged.

## Transactional count admission and legacy reads (C2)

Count all persisted canonical TEXT spans/documents/relations for the asset inside the common guarded command transaction, after resolving an existing receipt. Let C be current count, L current configured admission limit, and F the semantic command's final count. Standalone create requires C<L and F<=L. Updates/relabels/property edits and deletes consume no new slots. Atomic classification replacement can remove/add together: delta=F-C<=0 is allowed even when C>L; positive delta requires F<=L. Thus swapping at the limit is allowed; a legacy-over-limit replacement cannot increase count. Policy changes to L never delete data. Receipt replay neither recounts as a new admission nor allocates a slot. All failed commands roll back revisions/events.

L is a write-admission limit, not a read cap. Legacy over-limit annotations remain readable through bounded revision-consistent TEXT pages. The TEXT-specific and generic readers share this service. First page establishes assetRevision/sourceIdentity; subsequent opaque cursors bind asset, scope and snapshot revision, reauthorize each page, and require expectedAssetRevision. A changed asset revision produces 409 and an explicit restart, never a silently mixed snapshot. Return totalCount, configured limit and canCreate=false when full/over-limit. Default/max page sizes 500/1000 are shared protocol constants. Progressive clients do not present a partial collection as complete and keep legacy inspection/deletion accessible; use a paged/virtualized list. Existing IMAGE/VIDEO generic envelopes and behavior stay unchanged.
