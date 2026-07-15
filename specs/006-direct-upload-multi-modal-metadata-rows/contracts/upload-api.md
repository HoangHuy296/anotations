# Upload and View API Contract

All paths are public application routes owned by the Next.js backend. Each resolves the active opaque-cookie session before validation or storage access. Error responses are safe and never include storage credentials, private object keys, provider tokens, or server configuration.

## `POST /api/assets/presigned-upload`

Creates a constrained upload capability after Dataset authorization.

### Request

```json
{
  "datasetId": "cuid",
  "filename": "example.png",
  "contentType": "image/png",
  "sizeBytes": 12345
}
```

| Field | Validation |
| --- | --- |
| `datasetId` | Required Dataset identifier; resolved through `asset.upload` permission. |
| `filename` | Required display filename; normalized and bounded; no path semantics. |
| `contentType` | Required hint from the browser; must be among initial candidate types but is not authoritative. |
| `sizeBytes` | Required positive bounded integer; later compared to the observed object size. |

### Success: `201`

```json
{
  "data": {
    "uploadUrl": "short-lived presigned URL",
    "method": "POST",
    "formFields": { "key": "server-generated object key", "Content-Type": "image/png" },
    "fileId": "opaque server-signed completion reference",
    "expiresInSeconds": 600
  }
}
```

The returned URL and form fields are the only permitted browser-to-MinIO capability. The signed fields are a transient POST-only exception and are bound to one bucket, exact key, exact content type, a 1-byte-to-configured-maximum size range, and short expiry. The response must not expose top-level `objectKey`, `bucket`, or `storageKey`. `fileId` is opaque and contains no storage credential or plaintext private object identity.

### Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | Invalid filename, declared candidate type, or size. |
| 401 | `UNAUTHENTICATED` | Missing, expired, or revoked session. |
| 403 | `FORBIDDEN` | Known member lacks `asset.upload`. |
| 404 | `NOT_FOUND` | Dataset is absent, archived, or not visible to the actor. |
| 409 | `UPLOAD_CONFLICT` | An active deterministic object reference cannot safely be issued. |

## `POST /api/assets/complete-upload`

Verifies the expected private object and publishes metadata exactly once.

### Request

```json
{
  "fileId": "opaque server-signed completion reference"
}
```

The browser must send only `fileId`; the strict request schema rejects bucket, storage key, modality, checksum, owner id, uploaded-by id, and any other extra field.

### Success: `200` or `201`

```json
{
  "data": {
    "asset": {
      "id": "cuid",
      "datasetId": "cuid",
      "modality": "IMAGE",
      "filename": "example.png",
      "mimeType": "image/png",
      "sizeBytes": "12345",
      "status": "READY",
      "createdAt": "2026-07-14T00:00:00.000Z"
    },
    "replayed": false
  }
}
```

- First publication returns `201` and `replayed=false`.
- A safely reconciled completion retry returns `200` and `replayed=true` for the same Asset.
- No storage bucket, key, raw metadata, child identifier, or credential is exposed.

### Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | Missing or malformed completion capability. |
| 401 | `UNAUTHENTICATED` | Missing, expired, or revoked session. |
| 403 | `FORBIDDEN` | Capability actor/Dataset does not match the authenticated actor or permission is absent. |
| 404 | `NOT_FOUND` | Dataset is not visible to the actor. |
| 409 | `UPLOAD_CONFLICT` | A publication conflict was safely rolled back and its unreferenced object was cleaned up. |
| 409 | `UPLOAD_NOT_READY` | Expected object is missing, mismatched, or not yet consistently available. |
| 415 | `UNSUPPORTED_MEDIA` | Verified object type is unsupported or conflicts with allowed policy. |
| 422 | `INVALID_MEDIA` | Empty, corrupt, ambiguous, or otherwise invalid object. |

## `GET /api/assets/[assetId]/view-url`

Issues one short-lived asset-scoped viewing capability.

### Success: `200`

```json
{
  "data": {
    "viewUrl": "short-lived presigned URL",
    "expiresAt": "2026-07-14T00:00:00.000Z"
  }
}
```

The URL is the sole controlled exception that may encode the private object location. No separate object key or reusable credential is returned.

### Errors

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `UNAUTHENTICATED` | Missing, expired, or revoked session. |
| 403 | `FORBIDDEN` | Known Dataset member lacks `dataset.read`. |
| 404 | `NOT_FOUND` | Asset/Dataset is absent, archived, or undiscoverable to the actor. |
| 409 | `ASSET_UNAVAILABLE` | Asset exists but has no verified private object. |

## Browser transfer contract

1. Browser requests `presigned-upload` from the authenticated application.
2. Browser performs exactly the returned multipart `POST` to the returned URL, including all signed form fields and the file.
3. Browser calls `complete-upload` with only opaque `fileId`.
4. Browser obtains a view capability only through the authorized `view-url` route.

The browser never calls a bucket listing endpoint, creates its own object key, provides storage credentials, or uses the MinIO console.

## Runtime security contract

- `MINIO_PUBLIC_ENDPOINT` is the browser-reachable object-service endpoint used only to construct signed URLs; the application continues to use the internal endpoint for verification and cleanup.
- `MINIO_CORS_ALLOWED_ORIGIN` must identify the application browser origin and MinIO must permit `POST` from it. The bucket remains private and the console is not exposed by this flow.
- `UPLOAD_CAPABILITY_SECRET` is server-only signing material. The completion token is authenticated-encrypted and never exposes a reusable object key or storage credential.
