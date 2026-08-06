# Feature Specification: Video and Audio Readiness

**Feature Branch**: `018-video-audio-read-asset`  
**Created**: 2026-07-29  
**Status**: Draft  
**Input**: User description: "Process each VIDEO or AUDIO Asset independently so
video metadata and audio waveform readiness can be safely derived from private
source binaries."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See a Video Asset Become Ready (Priority: P1)

An authorized user imports or uploads a video Asset and can see that its media
metadata is being prepared, then see safe validated video metadata when the
work completes.

**Why this priority**: Video workspaces need trustworthy dimensions, duration,
frame rate, frame count, and codec information before they can make sound
playback or timeline decisions.

**Independent Test**: Given one valid private VIDEO Asset, schedule its
processing and verify that exactly one Asset-scoped request reaches a completed
state with validated video metadata, while its source binary remains private.

**Acceptance Scenarios**:

1. **Given** an authorized actor can access a VIDEO Asset with a stable source
   fingerprint, **When** readiness is requested, **Then** one independent
   media-processing request is created or reused for that Asset.
2. **Given** the request completes successfully, **When** the actor reads the
   Asset, **Then** they see safe validated video metadata and readiness state,
   without a private storage location or processing internals.
3. **Given** the video source is invalid, missing, or changes before it is
   processed, **When** readiness runs, **Then** the request fails safely and
   no misleading metadata is presented as current.

---

### User Story 2 - See an Audio Asset Become Ready (Priority: P1)

An authorized user imports or uploads an audio Asset and can see validated
audio metadata plus a waveform derivative that is available for a future
audio workspace without exposing the original binary.

**Why this priority**: Audio annotation needs duration, sample rate, channels,
codec, bitrate, and a bounded waveform representation before a timeline can be
useful.

**Independent Test**: Given one valid private AUDIO Asset, schedule its
processing and verify it reaches one completed state with validated audio
metadata and one private, versioned waveform derivative linked to that Asset.

**Acceptance Scenarios**:

1. **Given** an authorized actor can access an AUDIO Asset with a stable source
   fingerprint, **When** readiness is requested, **Then** one independent
   Asset-scoped request is created or reused.
2. **Given** audio processing succeeds, **When** the actor reads the Asset,
   **Then** they receive safe audio metadata and waveform readiness, but never
   a storage key, private URL, credential, or raw media payload.
3. **Given** an attempt is canceled or fails before its durable reconciliation,
   **When** cleanup occurs, **Then** only that attempt's uncommitted derivative
   may be removed and any already published canonical result remains intact.

---

### User Story 3 - Recover Safely from Duplicate Delivery or Cancellation (Priority: P1)

An authorized user can rely on one media-processing request per Asset and
source revision even when a request is retried, delivered more than once, or
canceled.

**Why this priority**: Per-Asset work isolates failures and makes retry,
cancellation, and compensation understandable without affecting another Asset
in the Dataset.

**Independent Test**: Deliver the same Asset-scoped request to two workers,
cancel a long-running audio case, and retry controlled failures; verify one
durable outcome, no duplicate child record or derivative, and no stale worker
mutation.

**Acceptance Scenarios**:

1. **Given** the same request is delivered concurrently, **When** workers try
   to process it, **Then** only one worker performs source access or durable
   reconciliation and the other performs no media side effect.
2. **Given** a request is retried after a failure at a defined safe boundary,
   **When** it runs again against the same source revision, **Then** it
   converges on one current metadata result and, for audio, one canonical
   waveform derivative.
3. **Given** cancellation wins before terminal completion, **When** the worker
   reaches its next safe boundary, **Then** it stops future work, preserves
   already published canonical data, and never reports completion.

---

### User Story 4 - Inspect Media Readiness Without Seeing Internals (Priority: P2)

An authorized Dataset user can view media readiness and request reconciliation
for an eligible VIDEO or AUDIO Asset; a user outside the Dataset cannot learn
whether the Asset or its processing request exists.

**Why this priority**: Readiness needs to be actionable in the Asset list and
detail view while preserving existing Dataset ownership and concealed-resource
rules.

**Independent Test**: Read readiness as an owner and permitted member, then
repeat as a foreign actor, unknown identifier, and malformed identifier; verify
safe authorized data only and concealed out-of-scope outcomes.

**Acceptance Scenarios**:

1. **Given** a permitted actor reads a VIDEO or AUDIO Asset, **When** media
   readiness is available, **Then** they see state, safe aggregate progress,
   safe outcome, and validated metadata appropriate to the modality.
2. **Given** a permitted actor requests reconciliation for an eligible Asset,
   **When** an equivalent current request already exists, **Then** the existing
   request is reused rather than a duplicate being created.
3. **Given** an actor lacks Dataset access, **When** they read or request
   media readiness, **Then** the response follows the established concealed
   resource policy and has no durable side effect.

---

### User Story 5 - Work in the Correct Modality Workspace (Priority: P2)

An authorized user opening a Dataset Asset is taken to a workspace chosen by
that Asset's modality. VIDEO Assets open an interactive video workspace rather
than an “unavailable” error; AUDIO Assets open a readiness-aware audio surface;
IMAGE Assets retain their existing image canvas and supported shape tools.

**Why this priority**: An Asset remains usable only when the shared workspace
route resolves its real modality into an appropriate experience, rather than
assuming every Asset is an image.

**Independent Test**: Open authorized IMAGE, VIDEO, and AUDIO Assets through
the shared workspace route. Verify the selected engine matches the Asset
modality, the correct safe data is displayed, and a foreign Asset remains
concealed.

**Acceptance Scenarios**:

1. **Given** an authorized user opens a VIDEO Asset, **When** its workspace is
   selected, **Then** it loads safe Asset metadata, labels, existing video
   annotations, tracks, keyframes, temporal labels, and a short-lived video
   view capability into a video player with a frame overlay.
2. **Given** a user plays, pauses, seeks, or steps through an authorized video,
   **When** the current frame changes, **Then** the timeline, timestamp, frame
   indicator, and frame-scoped overlays remain synchronized.
3. **Given** an authorized user edits a supported video annotation or track,
   **When** autosave runs after 1.5 seconds of inactivity or navigation occurs,
   **Then** the current durable revision is used, stale changes are surfaced as
   conflicts, and newer durable state is never silently overwritten.
4. **Given** an authorized user opens an AUDIO Asset, **When** its workspace is
   selected, **Then** it shows the safe audio readiness/metadata and waveform
   state when available, without presenting the image editor or an unavailable
   workspace error.

### Edge Cases

- Every media-processing request concerns exactly one Asset; a request cannot
  carry or fan out to multiple Asset identifiers.
- A non-VIDEO request for video metadata, a non-AUDIO request for waveform
  generation, or an Asset without a stable private source is rejected before
  source materialization.
- A changed fingerprint, checksum, size, or source revision makes a previous
  result stale; a worker must not attach stale metadata or a derivative to the
  newer binary.
- A malformed or excessive media file, source download, subprocess output, or
  waveform peak set is rejected under finite server-controlled policy limits
  without persisting raw diagnostic output.
- Cancellation is checked before source access, during bounded processing,
  before durable reconciliation, and before terminal completion.
- A stale worker lock, expired claim, duplicate delivery, or retry cannot
  overwrite a newer durable media result.
- A cleanup failure is recorded only as a safe aggregate outcome; it cannot
  remove a referenced derivative, an object outside the Asset's approved
  derivative prefix, or another attempt's object.
- An unsupported or stale VIDEO/AUDIO readiness state does not prevent Asset
  navigation; it is shown as a safe state in the correct modality workspace.
- Segmentation masks are visible as a clearly marked placeholder in the IMAGE
  and VIDEO toolsets. They are not silently represented as another geometry
  type or persisted as an unsupported editable shape.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST treat VIDEO metadata extraction and AUDIO
  waveform generation as separate Asset-scoped processing kinds. Each accepted
  request MUST identify exactly one Asset and one current source identity.
- **FR-002**: The system MUST create or reuse at most one active processing
  request for the same Asset, processing kind, source identity, and processor
  version. Concurrent equivalent requests MUST converge on the same durable
  request rather than create duplicates.
- **FR-003**: The system MUST create the durable processing request before it
  becomes available to a worker. Transport delivery MUST contain only the
  durable request identifier and no Asset list, repository information,
  credentials, storage identity, manifest, or binary data.
- **FR-004**: A media-processing request MUST be derived only from an
  authorized VIDEO or AUDIO Asset whose private source is available and whose
  fingerprint/checksum/revision is still current. It MUST validate modality,
  Dataset scope, source identity, and bounded media policy before accepting
  work.
- **FR-005**: The system MUST preserve PostgreSQL as the canonical source for
  request state, claims, progress, counters, safe events, retry lineage, and
  terminal outcome. Queue transport MUST not become a second media state
  store.
- **FR-006**: A worker MUST re-read the durable request and Asset after it has
  obtained the active claim. Every progress, failure, cancellation,
  reconciliation, and terminal update MUST require that active claim.
- **FR-007**: The system MUST inspect a VIDEO source using bounded media
  probing and persist only validated video metadata that is compatible with
  the existing VideoAsset model. Invalid or incomplete probe data MUST not
  replace current valid metadata.
- **FR-008**: The system MUST inspect an AUDIO source using bounded media
  probing and decoding, persist only validated audio metadata compatible with
  the existing AudioAsset model, and create one immutable versioned waveform
  derivative in private storage for the current source identity.
- **FR-009**: The waveform derivative format MUST have a stable documented
  version and bounded multi-resolution peak data. It MUST contain no original
  audio bytes, credentials, source URL, private storage credential, raw probe
  output, or local temporary path.
- **FR-010**: Audio reconciliation MUST atomically associate the current
  AudioAsset metadata and canonical derivative reference with the Asset's
  verified source identity. A retry or duplicate delivery MUST not create a
  second canonical derivative for that identity.
- **FR-011**: The system MUST use deterministic, credential-free source and
  derivative identities. It MUST reuse an existing object only when source
  revision/checksum/size validation proves it is the same content; conflicting
  bytes MUST fail safely rather than overwrite the existing object.
- **FR-012**: If an attempt fails before its metadata reconciliation, cleanup
  MAY remove only that exact unreferenced attempt object under the approved
  media derivative prefix. It MUST NOT remove a published reference, another
  Asset's object, or an object outside that prefix.
- **FR-013**: The system MUST apply finite, server-controlled limits for file
  count, source bytes, duration, decoded audio work, output bytes, subprocess
  capture, temporary workspace size, and processing time. Browser requests
  MUST NOT override those limits.
- **FR-014**: The system MUST terminate bounded media subprocesses and remove
  only the job-scoped temporary files it created when cancellation, timeout, or
  failure occurs. Raw command output and local paths MUST be normalized to safe
  public errors.
- **FR-015**: Source binaries and waveform derivatives MUST remain private.
  Browser access, if needed, MUST use existing short-lived, object-scoped view
  capabilities and MUST NOT reveal storage keys, bucket names, credentials, or
  signed query strings in safe status/readiness DTOs.
- **FR-016**: The system MUST expose an authorized media-readiness projection
  for VIDEO and AUDIO Assets. It MAY contain modality, processing state, safe
  aggregate counters, safe error code/message, and validated public metadata;
  it MUST NOT contain raw request input/state, claim metadata, queue metadata,
  source connection information, storage identity, raw provider/probe output,
  credentials, or infrastructure configuration.
- **FR-017**: Authorized reconcile requests MUST use the existing Dataset and
  Asset permission model, must be idempotent for equivalent current work, and
  must conceal foreign, unknown, and malformed Asset/request identifiers under
  the established policy.
- **FR-018**: The shared workspace route MUST select its engine from the
  server-resolved `Asset.modality`. IMAGE Assets MUST retain the image canvas;
  VIDEO Assets MUST open a video workspace; AUDIO Assets MUST open an
  audio-readiness surface. A valid authorized VIDEO or AUDIO Asset MUST NOT
  receive an “engine unavailable” outcome solely because of its modality.
- **FR-019**: The VIDEO workspace MUST load only safe, authorized data for the
  selected Asset: Asset and video metadata, labels, existing frame annotations,
  object tracks, keyframes, temporal labels, readiness state, and a scoped
  video-view capability. Its initial read MUST use the same canonical
  server-side workspace boundary as the existing workspace, not duplicate
  ownership or data-access logic in the browser.
- **FR-020**: The VIDEO workspace MUST support play, pause, seek, previous/next
  frame navigation, current timestamp, current frame, duration, and timeline
  display. Frame overlays MUST stay associated with the displayed frame while
  viewport pan and zoom remain transient client state.
- **FR-021**: The VIDEO workspace MUST support select, pan, zoom, and ghost
  drawing feedback for frame-scoped bounding boxes, polygons, circles, points,
  and polylines. It MUST support selection, label assignment, deletion, and
  an annotation list without changing label taxonomy metadata when only
  geometry changes.
- **FR-022**: The VIDEO workspace MUST support object-track creation,
  selection, and deletion; keyframe creation, editing, and deletion; safe
  interpolation between compatible keyframes; and temporal action/event labels
  with a validated start time and end time. Track, keyframe, and temporal data
  MUST be scoped to the selected Asset and follow the established Dataset
  ownership, revision, and concealed-resource policies.
- **FR-023**: Video annotation and track changes MUST autosave after 1.5
  seconds of inactivity and MUST flush before Asset navigation. Each save MUST
  use the observed durable revision; a conflict MUST preserve the local draft
  for user resolution and MUST NOT silently retry or overwrite newer data.
- **FR-024**: The VIDEO workspace MUST present the requested top bar, toolbox,
  center player/canvas, right management sidebar, and bottom engine controls.
  The management sidebar MUST include Asset description, video metadata, label
  taxonomy, shape/track/keyframe/temporal lists, Asset search, batch navigation,
  and Asset status. Selecting another Asset MUST preserve the active management
  tab when possible.
- **FR-025**: The AUDIO workspace MUST show safe audio metadata, waveform
  readiness, Asset navigation, search, batch/status information, and an
  explicit no-edit state. Audio timeline annotation, speaker editing, and
  other audio-write semantics are outside this phase.
- **FR-026**: The IMAGE workspace MUST remain available with its current
  editable bounding box, polygon, circle, point, and polyline tools. A mask or
  other future shape type MUST remain visibly scaffolded/read-only until its
  geometry, concurrency, and validation contract receives separate approval.
- **FR-027**: The system MUST normalize all media failures to stable safe
  codes and aggregate-safe events. It MUST NOT persist or return tokens,
  ciphertext, authorization headers, credentialed URLs, raw probe/decoder
  output, stack traces, signed URLs, storage locations, database/Redis/MinIO
  configuration, or binary content.
- **FR-028**: The system MUST preserve existing repository-import and
  local-folder import behavior. Scheduling media readiness from an Asset commit
  MUST create independent per-Asset work without changing the import request's
  payload or causing an import failure for another Asset.
- **FR-029**: The phase MUST begin with an audit that records the existing
  media-related request kinds, routing/recovery behavior, VideoAsset and
  AudioAsset fields, source fingerprint authority, idempotency boundary,
  import commit boundary, worker image/process capabilities, and whether an
  approved schema alignment is actually necessary.
- **FR-030**: Any change to the worker image to provide the approved
  `ffprobe`/`ffmpeg` media tooling MUST be explicitly recorded before
  implementation. A schema migration or new dependency is prohibited unless
  the audit identifies a concrete mismatch and receives separate approval.

### Key Entities

- **Media-processing request**: A durable, single-Asset request for one
  processing kind and one verified source identity. It has safe lifecycle,
  retry, cancellation, and progress information.
- **Source identity**: The credential-free combination of an Asset's current
  fingerprint, checksum, size, and/or source revision used to decide whether a
  previously derived result remains valid.
- **Video metadata**: Validated public facts needed for video readiness, such
  as dimensions, duration, frame rate, frame count, and codec where available.
- **Audio metadata**: Validated public facts needed for audio readiness, such
  as duration, sample rate, channels, codec, and bitrate where available.
- **Waveform derivative**: A versioned, bounded representation of an audio
  Asset's amplitudes. It is private, immutable for a source identity, and is
  referenced canonically by the associated AudioAsset.
- **Media readiness projection**: The authorized, redacted view of processing
  state, safe outcome, and validated modality-specific metadata shown to a
  user.
- **Video workspace state**: Safe, Asset-scoped player, frame, timeline,
  overlay, track, keyframe, temporal-label, selection, and save state. Viewport
  and playback position are transient; durable edits are revision-aware.
- **Object track and keyframe**: An Asset-scoped object identity and its
  time/frame-specific geometry states. Interpolation may derive view state but
  cannot silently overwrite a durable keyframe.
- **Temporal label**: An Asset-scoped action or event label with a validated
  start and end time, distinct from a frame geometry annotation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In controlled valid-video tests, 100% of accepted VIDEO Assets
  produce exactly one completed Asset-scoped processing request and one
  validated video metadata record for the current source identity.
- **SC-002**: In controlled valid-audio tests, 100% of accepted AUDIO Assets
  produce exactly one completed Asset-scoped processing request, one validated
  audio metadata record, and one private waveform derivative for the current
  source identity.
- **SC-003**: In controlled duplicate-delivery, retry, and concurrent
  scheduling tests, 100% of equivalent attempts converge on at most one
  canonical metadata result and one canonical waveform derivative per eligible
  Audio Asset/source identity.
- **SC-004**: In controlled stale-lock and cancellation tests, 100% of losing
  or stale workers make no durable metadata, derivative, progress, or terminal
  state mutation after they lose authority.
- **SC-005**: In controlled authorization, malformed input, stale source, and
  failure tests, 100% of rejected requests leave unrelated Assets and
  derivatives unchanged and expose no secret, private storage identity, raw
  tool output, or internal configuration.
- **SC-006**: In controlled workspace tests, 100% of authorized IMAGE, VIDEO,
  and AUDIO Assets select their corresponding workspace engine; VIDEO Assets
  never present an unavailable-engine error merely because of modality.
- **SC-007**: In controlled video-workspace tests, 100% of supported
  frame-scoped shape, track, keyframe, interpolation, and temporal-label
  operations remain Asset-scoped and revision-safe; stale autosaves preserve
  the local draft without overwriting newer durable state.
- **SC-008**: In controlled readiness UI tests, authorized users can identify
  the state of every eligible VIDEO/AUDIO Asset, while unauthorized users
  receive no existence disclosure.

## Assumptions

- The current JobType catalogue already contains the two required
  media-processing kinds; Phase 018.1 will verify that their routing and
  recovery handling are intentionally absent or ready to extend.
- Existing VideoAsset fields can hold the approved video metadata and existing
  AudioAsset fields can hold audio metadata plus a canonical waveform
  reference. The audit, not this specification, determines whether a schema
  alignment is required; none is authorized implicitly.
- The established per-Job PostgreSQL claim-lock contract, retry lineage, safe
  Job status projection, and exact single-identifier queue payload remain
  authoritative.
- The source binary was already committed to private object storage by an
  existing upload or repository-import flow. Media processing does not clone a
  repository, create a Dataset, or create Assets.
- A worker-image change to make approved media tooling available is a planned
  implementation prerequisite that requires recorded approval; it does not
  authorize a new application dependency.
- The finite numeric media-policy thresholds are deployment configuration to be
  finalized in planning after capacity and security review. Browser input never
  supplies them.
- VIDEO workspace editing is in scope only for frame-scoped bounding boxes,
  polygons, circles, points, polylines, tracks, keyframes, interpolation, and
  temporal action/event labels. Segmentation-mask editing is explicitly a
  placeholder; audio-write semantics remain out of scope.
- Repository scheduling, periodic synchronization, delete propagation,
  browser provider access, browser credential storage, and generalized media
  transcoding are out of scope.
