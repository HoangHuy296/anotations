# Data Model: Phase 016

No migration is planned. Existing schema constraints are sufficient and remain
the source of truth.

## Existing durable entities used

| Entity | Phase 016 use | Invariants |
| --- | --- | --- |
| `Job` | Authoritative import lifecycle, safe repository input, counters, stage, and summary. | Queue payload remains `{ jobId }`; mutations require current lock token. |
| `SourceConnection` | Server-only credential reference for private source access. | Re-resolve active/owned/unexpired state; decrypt only in worker memory. |
| `Asset` | One mirrored source file. | `@@unique([datasetId, sourceFingerprint])`; `storage*` identifies private MinIO object. |
| `ImageAsset` / `VideoAsset` / `TextDocument` / `AudioAsset` | One child metadata row selected by `Asset.modality`. | Exactly one matching child; no incompatible child row. |
| `JobEvent` | One safe aggregate event per completed batch. | Never one event per file or raw provider/object data. |

## Ephemeral structures

### SourceFileCandidate

```ts
type SourceFileCandidate = {
  path: string;
  filename: string;
  sizeBytes: number | null;
  mimeType: string | null;
  providerFileId: string | null;
  sha: string | null;
};
```

It exists only while the worker is processing an immutable ref. It is not Job
input, Redis content, a persisted manifest, or browser response.

### ImportBatchOutcome

```ts
type ImportBatchOutcome = {
  processed: number;
  imported: number;
  skipped: number;
  failed: number;
};
```

It is folded into the canonical Job counters and a safe batch-level event.

## State transitions

`QUEUED/RETRYING → RUNNING → COMPLETED|FAILED|CANCELED` is unchanged. A cancel
request observed between batches is acknowledged through `cancelJob`; no new
batch begins. Expired RUNNING jobs remain outside this phase's claim policy.
