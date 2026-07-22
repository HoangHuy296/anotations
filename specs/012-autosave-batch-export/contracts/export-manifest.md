# Export Manifest Contract

## Format

The Phase 012 export is one private JSON artifact. It is metadata-only, versioned, and deterministically ordered so retry/reconciliation can validate an existing result.

```ts
type DatasetExportManifestV1 = {
  schemaVersion: "1";
  exportedAt: string;
  dataset: SafeDatasetMetadata;
  assets: SafeExportAsset[];
  labels: SafeExportLabel[];
  annotations: SafeExportAnnotation[];
};
```

## Required metadata

| Section | Required content | Exclusions |
| --- | --- | --- |
| `dataset` | Safe Dataset identity, name, description, type, primary modality, lifecycle-safe metadata | owner/session/provider/source-connection credentials, tokens, private repository details |
| `assets` | Asset identity, Dataset identity, filename, modality, media metadata, status, batch/order metadata, description, safe logical storage reference | binary, bucket, object key, filesystem path, presigned URL, credentials |
| `labels` | Label identity, Dataset identity, name, normalized name, color, scope/modality metadata | unrelated Dataset labels |
| `annotations` | Annotation identity, Dataset/Asset/optional label identity, modality/type/status/source, canonical `geometry`, `properties`, safe timestamps/revision | reviewer/session credential, raw actor secrets, binary masks/derived binary payloads |

## Safe logical storage reference

An exported Asset may include a logical reference such as:

```ts
type SafeStorageReference = {
  assetId: string;
  provider: "MINIO" | "EXTERNAL" | "LOCAL";
  contentType: string | null;
  sizeBytes: string | null;
  checksum: string | null;
};
```

It is deliberately not a storage locator. `storageBucket`, `storageKey`, private URL, credentials, and source path are prohibited.

## Ordering and completeness

- Assets are ordered by `batchIndex`, `orderIndex`, then id.
- Labels are ordered by normalized name, then id.
- Annotations are ordered by Asset order, creation timestamp, then id.
- Every exported Asset, Label, and Annotation must belong to the exported Dataset.
- Annotations reference an included Asset and, where present, an included Dataset Label.
- The worker validates the final JSON before completing the Job; a failed validation produces a safe failure rather than a downloadable partial artifact.

## Prohibited content

The manifest contains no source or export binary payload, Base64 content, MinIO/S3 credential, database/Redis credential, provider token, encrypted secret, session/cookie/token, private repository URL, private object key, presigned URL, raw Job input/state/result, raw JobEvent data, queue identifier, or worker lock token.
