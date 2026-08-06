# Phase 018 Data Model

## Existing canonical entities

| Entity | Phase 018 use | Canonical rules |
|---|---|---|
| Asset | Single source Asset, modality, current source identity, duration, private source reference | `Asset.modality` selects workspace engine; `sourceFingerprint`/checksum/revision determine freshness; source storage stays private. |
| Job | One durable processing request for one Asset | Type is video metadata or audio waveform; Job state/progress/events/retry/cancel/lock are canonical; queue payload is `{ jobId }`. |
| VideoAsset | Singleton validated video metadata child | fps, totalFrames, codec, and safe metadata reconcile only after current source verification. |
| AudioAsset | Singleton validated audio metadata/derivative child | sampleRate, channels, codec, bitRate, waveformKey, and safe metadata reconcile only after current source verification. |
| Annotation | Video frame geometry/keyframe/temporal label state | Asset-scoped; revision guarded; `frameIndex`, `timestampMs`, `trackId`, `isKeyframe`, `isInterpolated`, `startMs`, `endMs` are the existing temporal fields. |
| VideoObjectTrack | Asset-scoped object identity for video annotations | Track and label must belong to the same Dataset; tracks cannot cross Assets. |
| JobEvent | Safe aggregate media progress/outcome history | Never carries tool output, storage identity, credentials, source URLs, or temporary paths. |

## Derived identity

`mediaRequestIdentity` is a credential-free deterministic hash of:

- Asset identifier;
- media Job type;
- current Asset source fingerprint;
- checksum/size/source revision when present; and
- processor contract version.

It excludes storage key, bucket, source URL, token, ciphertext, provider data,
and binary bytes. It is used to create/reuse equivalent current work and to
detect stale results.

## State transitions

```text
eligible Asset → durable QUEUED Job → RUNNING claim
  → validated metadata/derivative reconciled → COMPLETED
  → safe failure → FAILED
  → cancellation requested/acknowledged → CANCELED
```

Only the active Job lock may advance work. A stale source or stale lock cannot
reconcile a result. A retry follows the existing successor-lineage policy and
does not duplicate the canonical child metadata/derivative.

## Media readiness projection

The safe read model contains: Asset id/modality, processing state/stage, safe
aggregate counters, safe error code/message, processor/source freshness state,
and validated public video/audio metadata. It excludes Job input/state,
lock/queue fields, storage key/bucket, private URLs, credentials, raw tool
output, and infrastructure configuration.

## Workspace engine boundary

```text
safe selected Asset
  └─ modality dispatch in shared shell
       ├─ IMAGE → ImageEngine → ImageCanvas only
       ├─ VIDEO → VideoEngine
       ├─ AUDIO → AudioEngine
       └─ TEXT  → TextEngine
```

No non-IMAGE Asset enters ImageEngine or ImageCanvas. Viewport, playback, and
timeline position are transient state; durable frame/track/temporal edits are
Asset-scoped and revision guarded.
