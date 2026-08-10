# Feature Specification: Video Annotation MVP

**Feature Branch**: `019-video-annotation-mvp`  
**Created**: 2026-07-29  
**Status**: Draft  
**Input**: Phase 019 — Video Annotation MVP with revision-guarded object tracks, keyframes, linear interpolation, and temporal labels.

## Feature overview

This phase makes the existing shared VIDEO workspace manually editable. An
authorized user can create object tracks, persist bounding-box keyframes,
derive deterministic interpolation between keyframes, and create temporal
labels. All writes are authenticated PostgreSQL mutations with explicit,
resource-specific optimistic locking. The browser receives only safe metadata
and a short-lived view capability; video bytes continue to flow directly from
private MinIO to the browser.

The shared route is `/workspace/[datasetId]`, with the selected Asset carried
as a query parameter (`?image=`, `?video=`, `?audio=`, or `?text=`), not as a
`/workspace/[datasetId]/[assetId]` path segment. `Asset.modality` selects the
engine; a VIDEO Asset must never enter the Image engine.

## Repository and schema findings

The repository audit for this specification found:

- `VideoObjectTrack` already represents track identity, `VideoAsset` ownership,
  Label association, properties, status, and relationships to `Annotation`.
- `Annotation` already contains `trackId`, `isKeyframe`, `isInterpolated`,
  `timestampMs`, `frameIndex`, `startMs`, `endMs`, `geometry`, `modality`,
  `type`, and `revision`.
- The current `AnnotationType` enum already contains `BOUNDING_BOX`, `EVENT`,
  `SCENE`, and `SHOT_BOUNDARY`; these exact names are used here.
- The current `VideoObjectTrack` model does not yet expose the required
  `revision`, `annotationType`, or `interpolationMode` fields, and it has no
  track/timestamp uniqueness constraint. A later implementation plan MUST
  verify whether minimal additive migration work is required and obtain the
  normal migration approval before changing the schema. This specification
  does not generate a migration.
- Phase 017 establishes `Annotation.revision` for standalone Annotation
  writes. Video track-linked keyframes intentionally use a separate track
  revision domain defined below.

No replacement `VideoTrack`, `VideoKeyframe`, or `VideoTemporalLabel` model is
permitted.

## Architecture and security boundaries

- Dataset remains the central entity; no Project model is introduced.
- PostgreSQL is authoritative for metadata, annotations, revisions, and Job
  lifecycle. Manual track/keyframe/temporal-label writes create no Job.
- Redis/BullMQ is transport only. Any background payload remains exactly
  `{ jobId }`.
- Original video and derivatives remain private in MinIO. Next.js returns a
  short-lived authorized capability and does not proxy video bytes.
- Authentication is the existing opaque httpOnly PostgreSQL session. No JWT,
  browser token storage, or test bypass is allowed.
- Browser responses and UI state must not expose credentials, tokens,
  ciphertext, provider URLs, storage bucket/key, filesystem paths, queue
  internals, session cookies, or raw provider/ffprobe errors.
- Repository-imported video remains private-worker owned; this phase does not
  add repository synchronization or binary processing.

## User Scenarios & Testing

### User Story 1 — Inspect a private video (Priority: P1)

An authorized Dataset user opens a VIDEO Asset, plays and seeks it, sees safe
metadata, existing tracks/keyframes/temporal labels, and derived interpolation.

**Why this priority**: Editing must start from the server's current state and a
private video must remain accessible without exposing storage details.

**Independent Test**: With normal signup/login, open an owned or authorized
member VIDEO Asset, assert the browser obtains a view capability and the
read-model response contains safe tracks/annotations but no storage identity.

**Acceptance Scenarios**:

1. Given an authorized user and private VIDEO Asset, when the workspace opens,
   then video bytes load directly from MinIO and safe metadata is displayed.
2. Given persisted keyframes, when the playhead is between compatible
   keyframes, then the deterministic derived bounding box is displayed without
   a persisted interpolated row.
3. Given a foreign, malformed, or unknown Asset, when it is requested, then
   the existing concealed-resource policy is returned with no leakage.

### User Story 2 — Create and edit an object track (Priority: P1)

An authorized annotator creates a Label-associated `VideoObjectTrack`, draws
and edits bounding-box keyframes, changes allowed track properties or label,
and deletes the track.

**Independent Test**: Create one track and two keyframes over HTTP/UI, reload,
then update and delete them while checking durable state and safe responses.

**Acceptance Scenarios**:

1. A valid track uses a Label from the same Dataset and receives revision 1.
2. A valid keyframe uses the current timestamp and normalized bounding box and
   increments the track revision exactly once.
3. Track deletion atomically removes or safely retires its keyframes.
4. Cross-Dataset labels, non-VIDEO Assets, invalid geometry, and stale track
   revisions are rejected without partial writes.

### User Story 3 — Derive and commit interpolation (Priority: P1)

A user sees linear interpolation between persisted keyframes and can explicitly
choose “Add Keyframe Here” to persist the current derived geometry.

**Independent Test**: Persist keyframes at two timestamps, evaluate several
intermediate timestamps against the formula below, then add and reload a new
keyframe at an interpolated position.

**Acceptance Scenarios**:

1. Interpolation is deterministic, normalized, and identical in client preview
   and server/export derivation.
2. Interpolated geometry is never stored as an `Annotation` row.
3. Editing a derived position requires explicit keyframe creation and a
   current expected track revision.

### User Story 4 — Create temporal labels (Priority: P2)

An authorized user creates, moves, resizes, relabels, and deletes EVENT,
SCENE, or SHOT_BOUNDARY intervals.

**Independent Test**: Exercise each temporal type through authenticated HTTP,
including stale revision and cross-Dataset Label cases, then reload the
timeline.

**Acceptance Scenarios**:

1. A valid interval has `startMs < endMs` within video duration and receives
   an independent Annotation revision.
2. Temporal-label changes do not increment unrelated track revisions.
3. A stale `expectedRevision` returns conflict and leaves the row unchanged.

### User Story 5 — Recover safely from concurrent edits (Priority: P1)

Users see a visible conflict rather than silently overwriting newer track,
keyframe, or temporal-label state.

**Independent Test**: Submit concurrent writes with the same observed revision,
assert exactly one winner, then verify independent tracks and labels can still
be edited concurrently.

**Acceptance Scenarios**:

1. Two keyframe mutations with one expected track revision yield one success
   and one safe conflict.
2. Track metadata versus keyframe mutation races use the same track revision
   and yield one winner.
3. Temporal labels use independent Annotation revisions.
4. Local drafts remain visible after conflict; no stale request is retried
   automatically.

### User Story 6 — Autosave and navigate (Priority: P2)

After 1.5 seconds of inactivity, durable changes autosave per resource; safe
navigation flushes pending work and reload restores it.

**Independent Test**: Edit a track/keyframe and a temporal label, navigate,
reload, and assert dirty/saving/saved/error/conflict states and persistence.

### User Story 7 — Shared workspace engine/content registry (Priority: P1)

Before any VIDEO-specific UI is relocated, the shared workspace shell gains
one canonical registry — keyed by `WorkspaceSelection.engine` — that
`WorkspaceEngine`, `DatasetSidebar`, `PropertiesPanel`, and the shared status
surface all read from, instead of each independently deciding what content
belongs to which modality. A future fifth modality is added by writing one
registry entry, not by touching four component files.

**Why this priority**: The product goal is a long-term, scalable multi-modal
platform, not a four-modality one-off. A registry is what makes FR-040 ("a
future modality requires only a new Engine and one new case") actually true
structurally, rather than true only by convention that the next engineer has
to remember. Building the registry first also gives User Story 8's relocation
work a single place to add VIDEO's toolbox/tabs/status content, instead of
inventing per-component branching that would need to be revisited anyway.

**Independent Test**: Add one synthetic registry entry for a placeholder
modality with a stub Engine component, toolbox, tabs, and status fields.
Confirm `WorkspaceEngine`, `DatasetSidebar`, `PropertiesPanel`, and the shared
status surface each render it correctly with zero changes to their own source
files — only the registry module changed. Remove the synthetic entry and
confirm IMAGE/VIDEO/AUDIO/TEXT behavior is byte-for-byte unchanged.

**Acceptance Scenarios**:

1. Given the registry module, when it is queried by `engine`, then it returns
   one entry containing the Engine component and that engine's toolbox, tabs,
   and status-field specifications — no other module holds a second copy of
   this mapping.
2. Given `WorkspaceEngine`, `DatasetSidebar`, `PropertiesPanel`, and the
   shared status surface, when any of them needs modality-specific content,
   then it reads the registry entry for the active `engine`; none of them
   contains its own independent `switch`/`if` chain over `engine` or
   `asset.modality` beyond looking the entry up.
3. Given the registry currently contains IMAGE, VIDEO, AUDIO, and TEXT
   entries, when IMAGE's entry is read, then its toolbox/tabs/status fields
   match today's IMAGE-only behavior exactly (no regression).
4. Given a synthetic fifth entry is added to the registry only, when the
   workspace renders that modality, then all four shared surfaces pick it up
   correctly with no other file touched; removing the entry fully removes the
   modality from all four surfaces.
5. Given the registry is populated for VIDEO before User Story 8 relocates
   VIDEO's actual toolbar/details/temporal-label content into it, then VIDEO's
   registry entry may start with placeholder/minimal toolbox and tabs content
   that User Story 8 fills in — this story does not require VIDEO's UI to
   have moved yet, only that the lookup mechanism exists and IMAGE proves it
   end to end.

### User Story 8 — Consistent workspace shell across modalities (Priority: P1)

Building on User Story 7's registry, a user switching between IMAGE, VIDEO,
AUDIO, and TEXT Assets in the same Dataset experiences one identical page
shell; only the center engine surface changes. Every track/keyframe/temporal-label control a VIDEO Asset needs lives
in the shared sidebar, properties panel, and status surfaces rather than
inside the video canvas itself.

**Why this priority**: This is a prerequisite architecture correction, not new
functionality. Today `VideoEngine` embeds its own track toolbar, Video
Details, temporal-label list, and save-state footer inline in the canvas
area, duplicating layout responsibility that `DatasetSidebar`, `PropertiesPanel`,
and the shared status surface already own for IMAGE. Left uncorrected, every
future modality repeats the duplication instead of reusing one shell.

**Independent Test**: Open an IMAGE Asset, then a VIDEO Asset, in the same
Dataset session. Assert `DatasetSidebar`, `PropertiesPanel`, and the shared
status surface remain the same mounted component instances — not
modality-specific variants — while only `WorkspaceEngine`'s rendered child
changes. Assert `VideoEngine`'s rendered output contains no toolbar, details,
temporal-label, or save-state elements that duplicate content already owned
by `DatasetSidebar`/`PropertiesPanel`/the status surface.

**Acceptance Scenarios**:

1. Given a Dataset with IMAGE and VIDEO Assets, when the user navigates
   between them, then `DatasetSidebar`, `PropertiesPanel`, and the shared
   status surface keep the same outer component identity; only their internal
   content and `WorkspaceEngine`'s selected child differ.
2. Given a VIDEO Asset is open, when the user creates a track, adds a
   keyframe, edits track properties, or edits a temporal label, then the
   controls used are rendered by `DatasetSidebar`'s toolbox and
   `PropertiesPanel`'s tabs, not by `VideoEngine` itself.
3. Given a VIDEO Asset is open, when a shape or track row is selected in
   `PropertiesPanel`, then the player seeks to that shape's timestamp, the
   shape highlights, and its track becomes selected, using the same
   `WorkspaceSelection`/store data `VideoEngine` already reads today.
4. Given an IMAGE workflow that passed before this refactor, when the same
   workflow is exercised after it, then behavior, autosave timing, and
   conflict handling are identical.
5. Given no modality-switching change is intended in data or API contracts,
   when track/keyframe/temporal-label mutations are exercised, then the
   FR-005–FR-030 request/response shapes and revision semantics are
   unchanged.

## Functional Requirements

### Read model and workspace

- **FR-001**: The shared workspace MUST select `VideoEngine` only for
  `Asset.modality = VIDEO` and MUST NOT route non-VIDEO Assets into it.
- **FR-002**: An authorized read MUST return safe Video metadata, bounded
  tracks, persisted keyframes, bounded temporal labels, track revisions,
  temporal revisions, and derived frameIndex only when fps is reliable.
- **FR-003**: The read model MUST never return interpolated database rows,
  storage identity, provider data, credentials, lock internals, or queue state.
- **FR-004**: The browser MUST fetch video bytes directly from a short-lived
  backend capability; Next.js MUST NOT proxy or stream video binary.

### Track and keyframe lifecycle

- **FR-005**: The system MUST reuse `VideoObjectTrack` for track identity,
  Dataset/Asset ownership, Label, properties, status, annotation type, and
  interpolation mode.
- **FR-006**: Track create/update/delete MUST validate the current actor,
  Dataset permission, same-Dataset Label, VIDEO modality, bounded properties,
  and `expectedTrackRevision` where applicable.
- **FR-007**: A persisted keyframe MUST be an `Annotation` with VIDEO modality,
  non-null `trackId`, `isKeyframe=true`, `isInterpolated=false`, non-null
  `timestampMs`, valid BOUNDING_BOX geometry, null `startMs`/`endMs`, and the
  same Asset/Dataset as its track.
- **FR-008**: Keyframe create/update/delete MUST use
  `expectedTrackRevision`, mutate the keyframe and increment the track
  revision exactly once in one PostgreSQL transaction. Keyframe operations
  MUST NOT use `expectedAnnotationRevision`.
- **FR-009**: A track MUST have at most one persisted keyframe at a timestamp;
  duplicate timestamp requests must be rejected or safely idempotent under an
  approved database uniqueness boundary, never silently replaced.
- **FR-010**: Deleting a track MUST atomically remove or safely retire its
  keyframes and return the new safe track state.

### Temporal labels

- **FR-011**: Temporal labels MUST reuse standalone `Annotation` rows with
  `trackId=null`, `isKeyframe=false`, `isInterpolated=false`, an allowlisted
  type (`EVENT`, `SCENE`, or `SHOT_BOUNDARY`), non-null `startMs`/`endMs`, and
  no spatial geometry unless an existing approved representation requires it.
- **FR-012**: Temporal label create/update/delete MUST require
  `expectedRevision`, increment only that Annotation revision once, and MUST
  not change any VideoObjectTrack revision.
- **FR-013**: Temporal intervals MUST satisfy `startMs >= 0`, `endMs <= duration`,
  and `startMs < endMs`; overlapping intervals are allowed unless an existing
  Dataset taxonomy rule says otherwise.

### Geometry and time

- **FR-014**: The editable MVP geometry MUST be normalized BOUNDING_BOX
  `{kind:"BOUNDING_BOX",x,y,width,height}` with finite values, positive
  extents, `x,y >= 0`, and `x+width <= 1`, `y+height <= 1`.
- **FR-015**: NaN, Infinity, unknown unsafe fields, malformed geometry,
  frameIndex-only writes, and out-of-duration timestamps MUST be rejected.
- **FR-016**: `timestampMs` MUST be the only canonical persisted temporal
  coordinate. `frameIndex` is derived display data only when fps is finite,
  positive, and reliable, using one deterministic rounding rule; it MUST NOT
  control uniqueness or locking.
- **FR-017**: Future POINT, POLYGON, CIRCLE, POLYLINE, and
  SEGMENTATION_MASK types MUST remain extension points and are not editable or
  interpolated in this phase.

### Interpolation

- **FR-018**: For compatible keyframes K0 and K1 at `t0 < t < t1`, the system
  MUST derive `r=(t-t0)/(t1-t0)` and each box component as
  `v(t)=v0+r*(v1-v0)`.
- **FR-019**: Interpolation MUST be deterministic, normalized, and shared by
  client preview and server/export derivation; it MUST not numerically
  interpolate booleans or metadata.
- **FR-020**: There is no interpolation before the first or after the last
  keyframe; one-keyframe tracks render only at that timestamp unless a future
  hold mode is approved; disabled interpolation renders no derived geometry.
- **FR-021**: Outside/not-visible, occluded, incompatible, invalid, or deleted
  keyframes MUST follow one documented non-interpolating boundary policy.
  Seeking exactly to a keyframe uses the persisted keyframe; timestamps between
  decoded browser frames still use timestamp-based derivation.
- **FR-022**: Derived geometry MUST never create an Annotation row or change
  label, status, track revision, or properties. “Add Keyframe Here” is the only
  way to persist it.

### API and atomicity

- **FR-023**: Follow existing route conventions with safe authenticated
  endpoints equivalent to:
  `GET /api/assets/[assetId]/video-annotations`;
  `POST/PATCH/DELETE /api/assets/[assetId]/video-object-tracks` (or the
  repository's established track route); `POST/PATCH/DELETE` keyframe routes;
  and `POST/PATCH/DELETE` temporal-label routes. The implementation plan MUST
  confirm exact paths before coding.
- **FR-024**: Every endpoint MUST authenticate via opaque session, validate
  route/body with Zod, resolve Actor/Dataset/Asset/Label server-side, conceal
  foreign/unknown/malformed/cross-Dataset resources, validate VIDEO modality,
  validate the correct revision domain, mutate PostgreSQL atomically, and
  return safe DTOs.
- **FR-025**: Manual mutations MUST create no Job, JobEvent, BullMQ delivery,
  Redis entry, provider call, binary upload, or MinIO mutation.
- **FR-026**: Any failed item in a bounded transaction MUST roll back the
  complete requested change set; duplicate IDs, cross-track references,
  failed validation, permission failures, and revision conflicts have no
  partial side effects.

### Autosave and UI

- **FR-027**: The Video workspace MUST expose playback, timeline, current
  timestamp, previous/next keyframe, selection, pan/zoom, track creation,
  bounding-box drawing, Add Keyframe Here, keyframe deletion, and temporal
  label creation controls.
- **FR-028**: Timeline rendering MUST be bounded and must not create an
  unbounded DOM node for long videos. Keyframes may use pagination or bounded
  time-window reads.
- **FR-029**: Autosave MUST use 1.5-second inactivity per durable resource,
  one in-flight save per track or temporal label, flush safely on navigation,
  and preserve later local edits when an earlier response completes.
- **FR-030**: Conflict UI MUST expose dirty/saving/saved/error/conflict states,
  retain the local draft, offer reload/copy resolution, and never silently
  overwrite or force-retry stale writes.

### Shared workspace architecture

- **FR-032**: The shared workspace route MUST render one identical layout
  shell — `DatasetSidebar`, `WorkspaceEngine`, `PropertiesPanel`, and a shared
  status surface — for every `Asset.modality`; only the engine `WorkspaceEngine`
  selects may differ.
- **FR-033**: `WorkspaceEngine` MUST remain the only component that switches
  on `Asset.modality`/`WorkspaceSelection.engine` to decide layout placement.
  No sidebar, panel, status surface, or modality Engine may itself branch on
  modality to decide what layout region it belongs in.
- **FR-034**: `DatasetSidebar`, `PropertiesPanel`, and the shared status
  surface MUST each remain exactly one component; no per-modality variant
  (for example a Video-specific sidebar or properties panel) is permitted.
  Each renders modality-specific content internally, keyed off the same
  `WorkspaceSelection` union `WorkspaceEngine` already uses.
- **FR-035**: `DatasetSidebar`'s toolbox MUST present the tool set for the
  active engine (IMAGE: select/pan/bounding-box/polygon/circle/point/polyline;
  VIDEO: the IMAGE set plus temporal-segment and playback controls; AUDIO:
  waveform/segment tools; TEXT: entity/span/relation tools) while dataset
  navigation, asset navigation, and open-directory controls remain constant
  across modalities.
- **FR-036**: `PropertiesPanel` MUST present modality-appropriate tabs (IMAGE:
  Details/Labels/Shapes/Assets; VIDEO: Video Details/Tracks/Labels/Shapes/
  Properties/Assets; AUDIO: Audio Details/Labels/Segments/Properties; TEXT:
  Text Details/Labels/Annotations) from the same shell component. Selecting a
  VIDEO shape or track row MUST seek the player, highlight the shape, select
  the track, and load its properties without leaving the panel.
- **FR-037**: The shared status surface MUST always render save/dirty/saving/
  conflict state for the active resource, plus modality-specific fields
  (IMAGE: zoom, connection; VIDEO: current frame, timestamp, playback speed,
  latency; AUDIO: current time, playback speed; TEXT: selection state).
- **FR-038**: Each modality Engine (Image/Video/Audio/Text) MUST render only
  its canvas/player/waveform/document rendering and direct-manipulation
  surface; it MUST NOT render sidebar, properties/details, temporal-label, or
  save-state chrome. VideoEngine controls that currently render inline (track
  toolbar, Video Details, temporal-label list, inline save-state footer) MUST
  relocate to `DatasetSidebar`/`PropertiesPanel`/the shared status surface
  respectively, without changing the underlying track/keyframe/temporal-label
  data flow, revision contracts, or autosave behavior defined elsewhere in
  this spec.
- **FR-039**: This relocation MUST be behavior-preserving for IMAGE (the
  reference implementation) and MUST NOT alter any VIDEO API route, DTO, or
  revision domain defined in FR-005–FR-030; only the rendering location of
  existing controls changes.
- **FR-040**: Adding a future modality (a fifth engine) MUST require only a
  new Engine component and one new registry entry (FR-041); it MUST NOT
  require any structural change to `WorkspaceEngine`, `DatasetSidebar`,
  `PropertiesPanel`, or the shared status surface.
- **FR-041**: A single shared workspace registry, keyed by
  `WorkspaceSelection.engine`, MUST hold each engine's Engine component,
  toolbox specification, `PropertiesPanel` tabs specification, and status-field
  specification. This registry MUST be the only place this mapping exists;
  `WorkspaceEngine`, `DatasetSidebar`, `PropertiesPanel`, and the shared status
  surface MUST each read their modality-specific content from it rather than
  maintaining an independent `switch`/`if` chain over `engine` or
  `asset.modality`.
- **FR-042**: `WorkspaceEngine` MUST render the registry entry's Engine
  component for the active `engine`; this remains the only place selection
  ultimately renders a modality's canvas/player/waveform/document surface.
- **FR-043**: The registry MUST NOT carry storage identity, credentials,
  provider data, or any value excluded elsewhere in this spec from browser
  responses; it is a client-side composition mapping only (component
  references and display specifications), not a data contract.
- **FR-044**: Adding, removing, or editing a registry entry MUST NOT require
  editing `workspace-engine.tsx`, `dataset-sidebar.tsx`, `properties-panel.tsx`,
  or the shared status surface's source beyond the registry lookup already
  wired into each.

### Limits

- **FR-031**: Deployment-controlled finite limits MUST bound tracks per read,
  keyframes per track/read, temporal labels per read, tracks per Asset,
  keyframes per track, temporal labels per Asset, request body bytes, property
  depth/bytes, and label/string sizes. Long videos MUST use pagination or a
  time-window instead of an unbounded annotation graph.

## Revision-domain contract

There are exactly two optimistic-lock domains:

1. **Track domain** — `VideoObjectTrack.revision` is the sole token for track
   metadata, relabeling, properties, deletion, and every keyframe mutation.
   Each request supplies `expectedTrackRevision`; a successful atomic
   transaction verifies it, performs the mutation, increments once, and returns
   the new revision. A stale token returns the canonical safe conflict. A
   keyframe does not also use `Annotation.revision`.
2. **Temporal-label domain** — standalone `Annotation.revision` is the sole
   token for temporal-label update/delete. Each request supplies
   `expectedRevision`; success increments exactly once. Temporal-label writes
   never increment a track revision.

Editing Track A must not conflict with Track B. Asset revision is never a
global Video workspace lock. No stale write is force-retried.

## API response and authorization contract

The read DTO contains only safe Video metadata, bounded resources, revisions,
and derived display values. Track/keyframe responses include the safe track
summary and new track revision; temporal responses include the new Annotation
revision. All roles use the existing permission matrix: `dataset.read` gates
reads, `annotation.create` gates creation, and the established own/any update
permissions decide mutation; label-manager/review permissions remain separate.
ADMIN is the system override, while MANAGER access to a Dataset still depends
on ownership or Dataset membership. Non-members, foreign Assets, malformed IDs,
and cross-Dataset Labels follow concealed-resource policy.

## Key entities and reuse decisions

- **VideoObjectTrack**: existing track entity; add only the minimal approved
  revision/annotationType/interpolationMode fields if schema audit requires it.
- **Annotation**: existing entity for persisted keyframes and standalone
  temporal labels; no replacement tables.
- **VideoAsset**: duration/fps/codec metadata and track owner.
- **Label**: same-Dataset taxonomy identity; track owns keyframe label identity.

## Edge cases

- Negative, out-of-duration, non-finite, or frameIndex-only timestamps.
- Duplicate keyframe timestamp, equal interpolation timestamps, deleted or
  invalid keyframes, one-keyframe tracks, disabled interpolation, outside and
  occluded boundaries, and incompatible geometry.
- Stale track/keyframe races, stale temporal-label races, track deletion versus
  keyframe update, and independent-track concurrent edits.
- Foreign/unknown/malformed IDs, non-VIDEO Assets, cross-Dataset Labels,
  unauthorized roles, and a video with missing or unreliable fps.
- Long videos exceeding bounded read limits; use a time-window or pagination.
- Rapid modality switching (IMAGE → VIDEO → AUDIO → TEXT) MUST NOT remount
  `DatasetSidebar`, `PropertiesPanel`, or the shared status surface as a
  different component type; only their internal content re-renders for the
  new `WorkspaceSelection`.
- A VIDEO Asset with an in-flight track/keyframe autosave, when the user
  navigates to a different Asset, MUST still flush or guard navigation the
  same way the existing sidebar navigation guard does today, now triggered
  from the shared sidebar regardless of which engine owns the dirty state.

## Security and redaction requirements

No browser response, rendered data, event, metadata, or error may contain PATs,
tokens, ciphertext, Authorization headers, session cookies, provider/raw URLs,
storage bucket/key, MinIO credentials, queue metadata, filesystem paths,
stack traces, or infrastructure configuration. Structured log audit is N/A
unless a safe test-accessible logger exists; HTTP redaction remains mandatory.

## Migration impact and dependencies

Before implementation, audit existing data and constraints. Expected minimal
changes are additive fields on `VideoObjectTrack` (`revision` default 1,
`annotationType` if absent, `interpolationMode` if absent) and safe indexes or
uniqueness for `(trackId, timestampMs)`. Reuse `Annotation`; do not add tables.
Identify backfill/default handling for existing tracks. No migration is
created in this specification step, and no dependency is authorized.

This phase depends on completed shared workspace, Phase 017 Annotation API and
revision semantics, private MinIO view capabilities, and the existing Dataset
permission matrix.

## Success Criteria

- **SC-001**: An authorized user opens a private VIDEO Asset and plays/seeks it
  without receiving storage credentials or a backend-proxied binary.
- **SC-002**: One user can create a track and two persisted bounding-box
  keyframes, reload them, and see deterministic interpolation at an
  intermediate timestamp.
- **SC-003**: “Add Keyframe Here” persists exactly one keyframe; derived
  interpolation never persists a synthetic row.
- **SC-004**: Track/keyframe races yield exactly one winner per observed track
  revision; temporal-label races yield exactly one winner per Annotation
  revision, with no partial writes.
- **SC-005**: Temporal EVENT, SCENE, and SHOT_BOUNDARY intervals can be created,
  edited, relabeled, deleted, reloaded, and safely conflicted.
- **SC-006**: Independent tracks and temporal labels can be edited concurrently
  without a global Asset lock.
- **SC-007**: Authenticated denial, concealment, and redaction tests show no
  Job, queue, provider, MinIO, credential, or storage side effect.
- **SC-008**: Existing IMAGE revision behavior, Audio workspace, repository
  import, local-folder import, and exact `{ jobId }` queue payload regressions
  remain green.
- **SC-009**: `DatasetSidebar`, `PropertiesPanel`, and the shared status
  surface are each exactly one component in the codebase after this change;
  no modality-specific sidebar/panel/status-bar variant exists.
- **SC-010**: `VideoEngine`'s rendered output contains only playback/canvas/
  timeline surfaces; track toolbar, Video Details, and temporal-label controls
  render from `DatasetSidebar`/`PropertiesPanel` instead.
- **SC-011**: A synthetic fifth registry entry can be added, rendered
  correctly across all four shared surfaces, and removed again by editing
  only the registry module — no other shared-component file changes.
- **SC-012**: IMAGE's registry entry reproduces IMAGE's current toolbox, tabs,
  and status fields with no observable behavior difference.

## Known limitations

- Only VIDEO bounding boxes are editable/interpolated; polygon, circle,
  polyline, masks, keypoints, optical flow, and AI tracking remain future work.
- Frame stepping is timestamp-based when fps is missing, variable, or
  unreliable; derived frameIndex is display-only.
- No live collaboration, WebSockets, video export, transcoding, frame
  extraction, repository synchronization, or delete propagation is included.
- Final numeric limits and any required migration/backfill remain subject to
  the implementation audit and separate approval.
- AUDIO and TEXT engines remain intentionally read-only placeholders after
  this refactor. Their `DatasetSidebar` toolbox entries and `PropertiesPanel`
  tabs are structural placeholders consistent with that read-only state, not
  newly editable functionality; editable AUDIO/TEXT annotation stays out of
  scope for this phase.
- This refactor is a client-side component/layout reorganization only. It
  introduces no new data model entities, API routes, or revision domains, and
  does not change the `/workspace/[datasetId]` query-parameter-based route
  described in Feature overview; adopting a path-segment route remains a
  separate, unauthorized follow-up.
- The shared workspace registry (FR-041–FR-044) is a plain in-repo TypeScript
  module mapping a fixed, closed `engine` union to static component
  references and display specifications. It is not a runtime/dynamic plugin
  system, does not support third-party or externally loaded engines, and does
  not introduce a database-backed or admin-configurable registry; adding a
  modality still requires a code change (one registry entry) and a normal
  deploy, not a runtime toggle.

## Explicit non-goals

- AI/model-assisted tracking, optical flow, polygon/segmentation interpolation,
  keypoint skeletons, persisted per-frame interpolation rows, transcoding,
  complete frame extraction, live collaboration, WebSockets, full Video export,
  remote-linked playback, repository scheduling/synchronization/delete
  propagation, browser provider access, public worker routes, JWT, Project,
  or replacement VideoTrack/VideoKeyframe/VideoTemporalLabel tables.
