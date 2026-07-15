# Data Model: Direct Upload and Multi-modal Metadata Rows

This feature uses the finalized Prisma schema as the source of truth. It does **not** authorize a schema or migration change.

## Existing persisted entities

### Dataset

- Central authorization boundary for every upload and view.
- Must be active when a capability is issued and again when completion publishes metadata.
- `Dataset.sourceMode` remains independent from the direct-upload Asset source mode.

### Asset

| Field group | Planned value/rule |
| --- | --- |
| Dataset and actor | `datasetId` comes from the verified upload capability; `uploadedById` is the server session actor. |
| Classification | `modality` and `mimeType` come from server-side verification, never a browser claim. |
| Display metadata | `filename` is safely normalized for display; `originalFilename` preserves safe input when allowed; `sizeBytes` is server-observed. |
| Storage reference | `storageProvider=MINIO`, configured bucket, and a server-derived deterministic private key. These values never appear in normal metadata responses. |
| Provenance | `sourceMode=UPLOAD`; `sourceFingerprint` is server-derived from the verified object/checksum context. |
| Lifecycle | `status=READY` only after object verification and transactionally successful metadata/child-row publication. |

Existing constraints used for idempotency:

- Unique `(storageProvider, storageBucket, storageKey)` identifies one published object.
- Unique `(datasetId, sourceFingerprint)` prevents a duplicate source in one Dataset.

### ImageAsset

- Exactly one row for an IMAGE Asset.
- Initial fields: `exif={}` and optional `thumbnailKey=null`; dimensions may be stored on Asset only when the bounded detector can verify them.

### VideoAsset

- Exactly one row for a VIDEO Asset.
- Initial optional metadata (`fps`, `totalFrames`, `codec`, thumbnail/frame keys) remains unset unless safely detected. No frame extraction or thumbnail object is created.

### TextDocument

- Exactly one row for a TEXT Asset.
- `content` remains `null`; full uploaded text remains a private binary object.
- `language`, `tokenization`, and metadata remain empty unless future approved processing can verify them.

### AudioAsset

- Exactly one row for an AUDIO Asset.
- Optional sample rate, channels, codec, bitrate, and waveform key remain unset unless safely detected. No waveform object is created.

## Ephemeral, non-persisted concepts

### Upload capability

A signed server-generated value with a random nonce. It binds:

- actor id and Dataset id;
- a single deterministic private object key and configured bucket;
- requested safe filename and bounded expected size/type constraints;
- issue/expiry timestamps and a purpose (`upload` or `view`).

It is not stored as a database record, is not a MinIO access credential, and is never placed in a queue. Its authenticity and expiry are verified by server-only signing material.

### Verification result

A transient server-side result containing object existence, observed size, bounded signature/text inspection, accepted MIME type/modality, optional safe common metadata, and a source fingerprint. Only allowed safe fields are persisted.

## State and idempotency transitions

```text
authorized Dataset
  → upload capability issued (no database row)
  → private object transferred
  → server verification
      → rejected / private cleanup attempt (no Asset)
      → Prisma transaction: Asset READY + exactly one child row
      → same completion replay: resolve same Asset + child row
```

- An authorization failure, expired capability, missing object, type mismatch, or verification failure creates no Asset/child row.
- A transaction failure leaves no published metadata; its object cleanup is server-side best effort.
- A completed replay resolves the same Asset by private object reference and verifies Dataset scope before returning it.

## Invariants

1. One completed Asset has exactly one modality-specific child row matching `Asset.modality`.
2. One private object reference publishes at most one Asset.
3. An Asset and its child row always share the same Dataset through the Asset relation.
4. No binary body, object bytes, MinIO credential, provider token, or full private text content is persisted in PostgreSQL.
5. `Asset.modality` remains the only future workspace-engine selector; this feature adds no modality-specific workspace route.
