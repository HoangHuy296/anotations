# AUDIO annotation contract — audit and proposal (design only)

Status: **proposal for owner approval. Nothing here is implemented.** No Prisma migration was created or applied. AUDIO annotation editing is deliberately
gated in the workspace (`audio-tool-capabilities.ts`): the toolbox shows the time-segment, timestamp and speaker tools as disabled with an accurate reason.
This phase supports AUDIO playback, the properties panel and the Asset description only. Editing a description is metadata editing, not AUDIO annotation.

## 1. What exists today

| Area | State |
| --- | --- |
| `Annotation` columns | `startMs`, `endMs`, `timestampMs`, `speakerId`, `textValue`, `modality`, `type`, `geometry` (Json, default `{}`), `properties`, `revision`, `labelId`. Index `(assetId, startMs, endMs)` and `(assetId, timestampMs)`. |
| `AnnotationType` values usable for AUDIO | `AUDIO_CLASSIFICATION`, `SPEAKER_DIARIZATION`, `SPEAKER_IDENTIFICATION`, `NATURAL_LANGUAGE_UTTERANCE`, `ACOUSTIC_EVENT`, `TRANSCRIPT`. |
| `AudioAsset` / `AudioSpeaker` | `AudioAsset(assetId unique, sampleRate, channels, codec, bitRate, waveformKey, metadata)`; `AudioSpeaker(audioAssetId, externalId?, name?, role?, color?, properties)` with `@@unique([audioAssetId, externalId])`. `Annotation.speakerId` is a plain FK to `AudioSpeaker`. |
| Database constraints | None specific to AUDIO annotations: no `startMs < endMs`, no non-negative check, no "speaker belongs to the same Asset", no type↔modality check. M24/M25/M26 only guard `Asset.modality = Dataset.modality`. |
| Validation / service / API | **None for AUDIO.** The annotation service rejects non-IMAGE/VIDEO writes (`WRITE_UNSUPPORTED`, asserted by `annotation-service.test.ts`). TEXT has its own guarded command services; AUDIO has no equivalent. |
| Frontend | AUDIO engine: playback with waveform, properties panel (description autosave via `audio-mutations.ts`). No annotation list, no timeline regions, no speaker editor. |
| Export | The JSON manifest is generic over shapes; COCO is bounding-box-only. No AUDIO export contract exists. |

## 2. Is the existing schema suitable?

**Mostly yes for storage, no for integrity.** The columns that an AUDIO time-segment, a timestamp mark and a speaker assignment need already exist, so a
new table is **not** required. What is missing is enforcement: nothing prevents a segment with `endMs <= startMs`, a negative time, a `speakerId` that
belongs to a different Asset, a `TRANSCRIPT` with no text, or an AUDIO row written with an IMAGE type. Today those would be prevented only if a service
exists, and none does.

Reuse rules (hard requirements from the phase brief):

- Do **not** reuse IMAGE geometry (`{x,y,width,height}` / vertices in image coordinates).
- Do **not** reuse the VIDEO keyframe structure (`frameIndex`, `trackId`, `isKeyframe`, `isInterpolated`, `VideoObjectTrack`). An audio segment has no frame and no track.

## 3. Proposed data model

Follow the TEXT precedent: `geometry` is the canonical, versioned payload; the scalar columns are a queryable projection written in the same
transaction by the same service and never edited independently.

| Tool (UI) | `type` | `geometry` (canonical) | Projection columns |
| --- | --- | --- | --- |
| Time segment | `AUDIO_CLASSIFICATION`, `ACOUSTIC_EVENT`, `NATURAL_LANGUAGE_UTTERANCE`, `TRANSCRIPT` (by label scope / task) | `{ "schema": "audio.segment.v1", "startMs": int, "endMs": int }` | `startMs`, `endMs`, `timestampMs = null`, `textValue` for transcript/utterance |
| Timestamp | `ACOUSTIC_EVENT` (point event) | `{ "schema": "audio.timestamp.v1", "timestampMs": int }` | `timestampMs`, `startMs = endMs = null` |
| Speaker turn | `SPEAKER_DIARIZATION` / `SPEAKER_IDENTIFICATION` | `{ "schema": "audio.segment.v1", "startMs", "endMs" }` | `startMs`, `endMs`, `speakerId` |

Invariants (service-enforced, and optionally DB-enforced, see §4):

1. `0 <= startMs < endMs`; `endMs <= AudioAsset duration` when the duration is known (`AudioAsset.metadata.durationMs`; if unknown the upper bound is not checked and this is reported, not guessed).
2. `timestampMs >= 0`; a timestamp row has no `startMs`/`endMs`, a segment row has no `timestampMs`.
3. `speakerId`, if set, references an `AudioSpeaker` whose `audioAssetId` is the `AudioAsset` of this row's `assetId`.
4. `modality = AUDIO`, equal to `Asset.modality` and `Dataset.modality`; `type` is one of the six AUDIO types; `frameIndex`, `trackId`, `isKeyframe`, `isInterpolated`, `startChar…` are null/false.
5. `labelId`, if set, is a Label eligible for AUDIO (modality `AUDIO` or null) and its scope is allowed for the type.
6. Overlap policy: **overlapping segments are allowed** (diarization legitimately overlaps); this must be a recorded product decision, not an accident.

## 4. Migration need — two options

**Option A — no migration (recommended first step).** Ship the service, API and UI against the current schema. Integrity is enforced in one write
service (the only AUDIO writer), with an integration test that proves each invariant, as TEXT does. Zero migration risk; M24/M25/M26 checksums untouched.
Residual risk: a direct database write can still store an invalid row; mitigated by the Dataset/Asset writer-inventory test, which already classifies
AUDIO writers.

**Option B — constraint-hardening migration (needs explicit owner approval).** Additive `CHECK` constraints (`startMs >= 0 AND endMs > startMs` when both
set; `timestampMs >= 0`) and a trigger "speaker's AudioAsset belongs to the annotation's Asset". Nullable, backward compatible, no data rewrite. Risks:
existing rows (none are known to exist for AUDIO, but this must be verified read-only on the canonical copy before applying), a new migration checksum
chain after M26, the G1 chain runner and image-verification pins (`PINNED_M26`) all need a reviewed update, and the canonical database cannot be changed
without the promotion gate. **This phase did not create or apply it; per the brief, any schema change stops here for owner approval.**

No new model is needed under either option.

## 5. API and persistence contract

- Reads: `GET /api/assets/{assetId}/annotations` already returns rows generically; AUDIO rows serialize `geometry`, `startMs`, `endMs`, `timestampMs`, `speakerId`, `textValue`, `revision`.
- Writes (new): create / update / delete through an AUDIO command service that mirrors the guarded TEXT commands: authorize (member role), load the Asset and require `Asset.modality = AUDIO`, validate with Zod (`audio.segment.v1` / `audio.timestamp.v1`), then write geometry + projection in one transaction.
- `Annotation.revision` is required on every update and a stale revision is rejected (`REVISION_CONFLICT`, same envelope as IMAGE/VIDEO). Create is idempotent through an operation id, as in TEXT (`operationId` replay record), so a duplicate delivery cannot create a duplicate row.
- Description/properties edits stay on the existing Asset-level path (`audio-mutations.ts`) and are independent of annotation revisions.
- Errors are public-safe: no storage keys, bucket names, tokens, or stack traces.

## 6. Frontend state

- Region state (segment start/end, drag handles) is committed only at action boundaries (pointer up, drag end, delete, label assignment, explicit save, versioned autosave) — the same canvas rule as IMAGE: no React state or persistence per drag tick; live preview by refs/DOM mutation.
- Playhead position is viewport state, separate from persisted geometry. Persist times in milliseconds of the original media, never in pixels or zoom-dependent units.
- The properties panel shows the selected segment's range, label, speaker and text with the same revision/conflict handling as IMAGE.
- Until this is implemented, the toolbox stays gated by `AUDIO_ANNOTATION_EDITING_AVAILABLE = false`; flipping it is a code change that must come with the tests in §7.

## 7. Tests required before AUDIO can be called annotation-capable

1. Pure validation tests for every invariant in §3 (boundaries: `startMs = 0`, `endMs = startMs`, `endMs = duration`, negative, non-integer, speaker from another Asset, wrong type, wrong modality).
2. Service integration tests on a disposable database: create/update/delete, stale-revision rejection, idempotent duplicate delivery, label eligibility, cross-Dataset access denial, `WRITE_UNSUPPORTED` removed only for AUDIO.
3. Writer-inventory update (the new writer is classified) and, if Option B is approved, the migration chain, checksum and image-verification pin updates.
4. Browser acceptance: create a segment, adjust it, assign a label and speaker, reload, and see the same range and revision; cancel and asset switch write nothing.
5. Export: JSON manifest carries the AUDIO shapes; COCO states plainly that AUDIO is excluded.
6. Regression: IMAGE, VIDEO and TEXT suites unchanged and green.

## 8. Risks

- Migration/back-compat: Option A has none; Option B changes the migration chain after M26 and touches every pin that names it.
- Existing data: no AUDIO annotations are expected, but this has not been proven on the canonical copy; any check must be read-only.
- Overlap and duration semantics are product decisions the owner has to confirm (§3.6 and the unknown-duration case).
- Speaker management (create/rename/merge `AudioSpeaker`) is out of scope of the minimal contract and needs its own API if speaker tools ship.
- Real-time collaboration on regions would need conflict rules beyond per-row revision; not designed here.

## 9. Decision requested

Approve Option A (service-enforced, no migration) as the starting point, decide the overlap policy, and decide whether Option B hardening is wanted
before or after the first AUDIO editing release. Implementation is a separate phase.
