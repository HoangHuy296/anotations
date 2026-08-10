# Phase 019 Research Decisions

## Decision 1 — Reuse the existing annotation model

**Decision**: Persist object tracks in `VideoObjectTrack`, keyframes and
temporal labels in `Annotation`, and keep `VideoAsset` as the owner of tracks.

**Rationale**: The current Prisma schema already contains the required
relationships and temporal fields. Replacement `VideoTrack`, `VideoKeyframe`,
and `VideoTemporalLabel` tables would split the canonical annotation model and
violate the architecture lock.

**Required audit before implementation**: `VideoObjectTrack` currently lacks
`revision`, `annotationType`, and `interpolationMode`; the implementation must
confirm whether those are needed and obtain migration approval if so. Existing
`AnnotationType` names `BOUNDING_BOX`, `EVENT`, `SCENE`, and `SHOT_BOUNDARY`
are authoritative.

## Decision 2 — Use two explicit revision domains

**Decision**: `VideoObjectTrack.revision` protects the track and every linked
keyframe mutation. `Annotation.revision` protects standalone temporal-label
mutations.

**Rationale**: Keyframe and track changes must serialize together, while
unrelated temporal labels and tracks must remain independently editable. The
Phase 017 Annotation revision contract remains unchanged for image and
standalone annotation writes.

## Decision 3 — Use timestampMs as the canonical temporal coordinate

**Decision**: Persist and mutate keyframes using `timestampMs`; use
`frameIndex` only as a derived display value when reliable fps exists.

**Rationale**: fps is nullable and may be variable or approximate. Timestamp
semantics remain stable across providers and browsers and avoid treating a
derived frame number as identity or a lock key.

## Decision 4 — Derive, never persist, interpolation

**Decision**: Store only persisted bounding-box keyframes. Derive linear
interpolation at read/render time using the shared formula and never insert
`isInterpolated=true` rows.

**Rationale**: This keeps the database canonical and prevents duplicate rows,
stale derived state, and expensive per-frame storage. “Add Keyframe Here” is an
explicit persisted mutation.

## Decision 5 — Manual mutations remain synchronous PostgreSQL operations

**Decision**: Track, keyframe, and temporal-label endpoints execute bounded
Prisma transactions and create no Job or BullMQ delivery.

**Rationale**: These are interactive edits, not long-running processing. It
preserves PostgreSQL authority and the exact `{ jobId }` transport contract for
approved background work.

## Decision 6 — Bounded read model

**Decision**: Return bounded tracks/keyframes/temporal labels and use a
time-window or pagination contract for long videos; never materialize an
unbounded annotation graph or timeline DOM.

**Rationale**: A video can contain many keyframes and temporal labels. A
bounded contract is necessary for predictable browser memory and response
size.

## Decision 7 — Existing authorization and concealment remain canonical

**Decision**: Use the established `dataset.read`, `annotation.create`, and
own/any update permissions, with Dataset ownership/membership and ADMIN
override rules. Conceal foreign, malformed, and unknown resources.

**Rationale**: Phase 017 and Phase 004 already define the policy matrix. This
phase must not invent a modality-specific authorization model.

## Decision 8 — No provider or binary access for manual editing

**Decision**: The browser uses a backend-generated short-lived MinIO view
capability; manual annotation calls never access providers, Redis, BullMQ, or
binary storage.

**Rationale**: It keeps secrets and infrastructure server-side and ensures a
failed annotation mutation has no external side effect.

## Decision 9 — Migration gate

**Decision**: Do not generate a migration during planning. If schema audit
confirms missing track revision/metadata fields or safe uniqueness/indexes are
required, prepare a separately approved additive migration with explicit
backfill/default handling.

**Rationale**: The constitution requires approval for schema changes and the
existing nullable Annotation fields must be evaluated against all modalities
before adding constraints.

## Phase 019 live audit — 2026-07-29

The controlled Compose `postgres` service was queried read-only as database
`fieldframe`, user `fieldframe`. Prisma reported the same database as
`fieldframe` on `127.0.0.1:5433`; `prisma migrate status` reported the schema
up to date with 9 migrations.

Audit results:

- `VideoObjectTrack` rows: 0.
- Track-linked `Annotation` rows: 0.
- Valid persisted keyframes: 0.
- Missing `timestampMs`: 0.
- Duplicate `(trackId, timestampMs)` groups: 0.
- Persisted `isInterpolated=true` track rows: 0.
- Track-linked non-keyframe rows: 0.
- Invalid track shape rows: 0.
- Cross-Asset references: 0.
- Cross-Dataset references: 0.
- Invalid Label references: 0.
- Non-VIDEO Assets referenced by tracks: 0.
- Empty tracks: 0.
- Per-track type groups: none.
- Interpolation enum: none exists.

The empty database makes the deterministic backfill unambiguous: new tracks
may default to `BOUNDING_BOX`, `LINEAR`, and revision 1. No existing rows need
rewriting. The migration was approved after this audit and applied separately
as `20260729000000_add_video_track_revision_contract`; no row backfill or
annotation rewrite was required.

## Decision 10 — Shared workspace shell is a client-side relocation, not a data change

**Decision**: `DatasetSidebar`, `PropertiesPanel`, and the shared status
surface (`workspace-header.tsx`) become the single owners of VIDEO's track
toolbar, Video Details, temporal-label list, and save-state display,
generalized to branch on `WorkspaceSelection.engine`. `VideoEngine` keeps only
playback/canvas/timeline rendering and direct manipulation. No Prisma model,
API route, DTO, or revision domain changes.

**Rationale**: A 2026-08-07 code audit found `WorkspaceEngine` already
switches on `selection.engine` exclusively (correct), but `DatasetSidebar` is
hard-coded to the IMAGE toolbox and `PropertiesPanel` is typed to
`image: SafeImageWorkspaceAsset | null` only — neither reads
`WorkspaceSelection` for VIDEO/AUDIO/TEXT. `VideoEngine` compensates by
rendering `VideoToolbar`, `VideoDetailsPanel`, `VideoTemporalLabels`, and an
inline save-state footer itself. That is exactly the "engines own layout"
anti-pattern the shared-workspace principle forbids, and it does not scale to
AUDIO/TEXT editing without repeating the same duplication. Because the
underlying track/keyframe/temporal-label services, routes, and revision
contracts (Decisions 1–9 above) are already correct and fully implemented
(`tasks.md` all `[X]`), the fix is scoped to component boundaries only.

**Alternatives considered**: A `VideoPropertiesPanel`/`VideoSidebar` pair was
rejected — it satisfies nothing the current code doesn't already do wrong,
and permanently forks IMAGE and VIDEO layout code that FR-034 requires to stay
single. A brand-new bottom-mounted status-bar component (instead of
generalizing `workspace-header.tsx`) was rejected because it would create a
second, competing save-state source instead of extending the one that already
reads `useAnnotationStore`.

## Decision 11 — Build a shared engine/content registry before relocating VIDEO's UI

**Decision**: Before moving VIDEO's toolbar/details/temporal-label UI (spec
User Story 8), first build one registry module keyed by
`WorkspaceSelection.engine` (spec User Story 7, FR-041–FR-044) that holds each
engine's component and its `DatasetSidebar` toolbox, `PropertiesPanel` tabs,
and status-field specifications. `WorkspaceEngine`, `DatasetSidebar`,
`PropertiesPanel`, and the shared status surface each read from this one
registry instead of independently branching on `engine`.

**Rationale**: The stated product goal is a scalable, long-term multi-modal
platform, not a fixed four-engine special case. Without a registry, Decision
10's plan (each shared component grows its own `engine === "VIDEO"` branch)
technically satisfies FR-032–FR-040 for four known modalities, but a fifth
modality would still require editing `dataset-sidebar.tsx`,
`properties-panel.tsx`, and `workspace-header.tsx` in lockstep — the same
"every future modality repeats the duplication" failure mode this whole
refactor exists to close, just moved one level up. A registry makes FR-040
("a future modality requires only a new Engine and one new registry entry")
true structurally, verifiable by adding and removing a synthetic entry
(spec SC-011), not true only by the next engineer following convention.

**Alternatives considered**: Proceeding directly to Decision 10's per-component
branching (the original single-story plan) was rejected for the reason above —
it is not wrong for the four current modalities, but it does not scale, and
the user's stated goal is explicitly long-term scalability. A dynamic,
config-driven, or database-backed registry was rejected as over-scoped: the
`engine` union is closed and small, deploys already require a code change to
add a Prisma `Modality` value, and a runtime plugin system would need its own
security review (arbitrary component loading) with no requirement driving it.
