# Phase 018 Research

## Decision: Keep one Asset per media Job

**Decision**: Schedule `EXTRACT_VIDEO_METADATA` only for one VIDEO Asset and
`GENERATE_AUDIO_WAVEFORM` only for one AUDIO Asset. A durable Job input holds
safe single-Asset identity and processor/source identity only; transport is
strictly `{ jobId }`.

**Rationale**: Existing claim-lock, cancellation, retry lineage, and
idempotent-delivery contracts operate at Job granularity. Per-Asset work gives
one failure/compensation boundary and avoids a failed Asset affecting the
Dataset.

**Alternatives considered**: One Dataset-wide media Job was rejected because it
would combine retries, cancellation, progress, and cleanup for unrelated
Assets.

## Audit record — 2026-07-29

- `JobType` already defines `EXTRACT_VIDEO_METADATA` and
  `GENERATE_AUDIO_WAVEFORM`; neither is currently transport-supported.
  `packages/queue/src/job-contract.ts` permits only `IMPORT_DATASET` and
  `EXPORT_DATASET`, while `apps/worker/src/queue/queue-router.ts` invokes only
  their processors. `runPendingJobRecovery` uses the same queue-type gate.
- Existing enqueue construction is correct for the new types once they are
  allowlisted: `buildDurableJobQueueDelivery` validates strict `{ jobId }` and
  `enqueueExistingJob` runs after the durable row has committed. Existing retry
  lineage remains the canonical behavior.
- `Asset.sourceFingerprint` is the primary current logical source identity;
  Asset checksum, size, source revision, and current AssetVersion fields are
  additional verification inputs. Repository and local-folder imports already
  persist private binary metadata before media work.
- `VideoAsset` and `AudioAsset` are singleton children. `Asset.durationMs`
  carries duration; VideoAsset has fps/totalFrames/codec; AudioAsset has sample
  rate/channels/codec/bitRate/waveformKey. Existing Annotation temporal fields
  and `VideoObjectTrack` cover the planned video MVP without a schema change.
- No worker subprocess/materialization helper exists. The approved
  `apps/worker/Dockerfile` now installs FFmpeg, which supplies both `ffmpeg`
  and `ffprobe`; T017 still needs a rebuilt-image validation record.

**Schema conclusion**: no migration is required for the current per-Asset MVP.
`AudioAsset.waveformKey` is the one canonical private derivative reference and
safe metadata records its source identity/format version. A future derivative
history or stronger database uniqueness requires separate schema approval.

**Historical implementation blocker**: worker media work was blocked until
the user explicitly approved `ffprobe`/`ffmpeg` installation. That approval
is now recorded below.

## Recorded worker-image approval — 2026-07-29

The user explicitly approved and installed `ffprobe`/`ffmpeg` in the private
worker image at `apps/worker/Dockerfile` for bounded VIDEO metadata and AUDIO
waveform processing. This approval is limited to the private worker image; it
does not authorize a schema migration, npm dependency, browser media access,
or queue payload change. T017 still requires a rebuilt-image validation record
before it is complete.

## Decision: Use existing media models for the MVP

**Decision**: Use `Asset.durationMs` for duration, `VideoAsset` for fps/frame
count/codec/safe metadata, and `AudioAsset` for sample rate/channels/codec/
bitrate/waveform key/safe metadata. `AudioAsset.waveformKey` is the canonical
private waveform reference; safe metadata records waveform contract version and
the Asset source identity it represents.

**Rationale**: The schema already has singleton modality children and Asset has
the source fingerprint/checksum/revision authority. This supports an MVP
without a migration.

**Alternatives considered**: A derivative table and additional unique indexes
may improve future multi-derivative history, but require separate schema
approval and are not needed to prove one current immutable waveform per Asset
identity.

## Decision: Worker-only media inspection

**Decision**: The private worker materializes the current private MinIO source
in a Job-scoped temporary directory, runs approved bounded media tools, and
removes only files it created.

**Rationale**: The browser never receives source credentials or private storage
identity. Bounded tools permit cancellation/timeout and safe error projection.

**Alternatives considered**: Browser media probing and public worker HTTP were
rejected by the architecture and security boundaries.

## Decision: Approved worker image gate

**Decision**: Before implementation changes the worker image, record approval
for installing `ffprobe` and `ffmpeg` in that image. The audit confirms the
current image contains only OpenSSL and therefore cannot satisfy media work.

**Rationale**: The tools are needed only by the private worker and change the
runtime image. Explicit approval keeps the phase compliant with dependency and
operational governance.

**Alternatives considered**: A host-installed binary or browser tool is not
portable, cannot be validated in Compose, and weakens privacy controls.

## Decision: Shared shell dispatches engines

**Decision**: `WorkspaceEngine` receives a safe selected Asset and dispatches
IMAGE, VIDEO, AUDIO, or TEXT engines. Each engine receives only its safe
modality DTO. ImageCanvas is IMAGE-only and performs no modality switch.

**Rationale**: The current fallback confirms that `Asset.modality` already
selects the workspace conceptually, but non-IMAGE Assets are blocked. Explicit
shell dispatch prevents VIDEO/AUDIO/TEXT data from reaching image-only canvas
state.

**Alternatives considered**: Making ImageCanvas polymorphic was rejected
because it entangles image geometry/viewport state with video playback and
audio readiness.

## Decision: Reuse existing video temporal model

**Decision**: Use current Annotation frame/time fields and `VideoObjectTrack`
for frame annotations, keyframes, interpolation state, and temporal labels;
the audit must map exact mutation guards during task design.

**Rationale**: Existing fields include `frameIndex`, `timestampMs`, `trackId`,
`isKeyframe`, `isInterpolated`, `startMs`, and `endMs`, plus relevant indexes.

**Alternatives considered**: New keyframe/temporal tables would require an
unapproved migration before proving the existing model's capability.

## Decision: Mask remains a visible placeholder

**Decision**: IMAGE and VIDEO toolboxes show segmentation mask as unavailable/
read-only. It receives no surrogate geometry or unvalidated persistence path.

**Rationale**: A mask needs a separate geometry, storage, editing, and
concurrency contract. Pretending it is a polygon would corrupt semantics.

**Alternatives considered**: Implementing mask editing inside Phase 018 was
rejected as an unbounded future geometry engine.
