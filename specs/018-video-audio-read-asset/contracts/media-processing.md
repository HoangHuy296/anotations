# Media Processing Contract

## Scheduling

An authorized request targets exactly one eligible Asset.

| Asset modality | Durable Job type | Result |
|---|---|---|
| VIDEO | `EXTRACT_VIDEO_METADATA` | Validated VideoAsset/Asset metadata |
| AUDIO | `GENERATE_AUDIO_WAVEFORM` | Validated AudioAsset/Asset metadata and one private waveform derivative |

The request is idempotent for the Asset, current source identity, and processor
version. A current equivalent Job is returned/reused. A changed source identity
creates/requires new work according to the existing retry/reconciliation
policy. The browser cannot supply a source identity, policy limit, storage
identity, or Job payload.

## Queue boundary

Every delivery, replay, recovery, and retry uses exactly:

```ts
{ jobId: string }
```

No queue message may contain an Asset list, dataset ID, source connection,
repository/source URL, token/ciphertext, storage bucket/key, manifest, raw Job
input/state, error, or binary.

## Safe readiness response

Authorized status reads may expose:

```ts
type SafeMediaReadiness = {
  assetId: string;
  modality: "VIDEO" | "AUDIO";
  state: "NOT_REQUESTED" | "QUEUED" | "RUNNING" | "RETRYING" | "COMPLETED" | "FAILED" | "CANCELING" | "CANCELED";
  stage: string | null;
  progress: number | null;
  counters: { total: number | null; processed: number | null; succeeded: number | null; failed: number | null; skipped: number | null };
  outcome: { code: string | null; message: string | null } | null;
  video?: { durationMs: number | null; fps: number | null; totalFrames: number | null; codec: string | null };
  audio?: { durationMs: number | null; sampleRate: number | null; channels: number | null; codec: string | null; bitRate: number | null; waveformReady: boolean };
};
```

It never exposes raw Job input/state, `waveformKey`, storage location, signed
URL/query, tokens, source connection data, tool output, stack traces, or
infrastructure configuration. Foreign/unknown/malformed identifiers use the
existing concealed-resource policy.

## Worker reconciliation

1. Claim the Job and reload Job/Asset/current source identity.
2. Reject a wrong modality, missing/stale source, inactive Dataset, expired
   lock, or cancellation at a safe boundary.
3. Inspect private source under finite policy.
4. Validate and reconcile only current-source metadata; audio uploads a single
   immutable private attempt object before the atomic AudioAsset reference.
5. Complete/fail/cancel using the active lock. Cleanup may remove only the
   exact unreferenced attempt object under the approved derivative prefix.
