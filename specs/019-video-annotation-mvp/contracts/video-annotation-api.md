# Video Annotation API Contract

All endpoints require the normal opaque-cookie session and return safe DTOs.
Foreign, unknown, malformed, and cross-Dataset resources follow concealed
resource policy.

## Read model

`GET /api/assets/{assetId}/video-annotations`

Returns bounded safe Video metadata, tracks, persisted keyframes, temporal
labels, track revisions, temporal revisions, and derived display `frameIndex`
only when fps is reliable. It never returns storage bucket/key, credentials,
provider data, raw Prisma records, lock internals, queue state, or derived rows
as persisted Annotations.

## Track lifecycle

The Phase 019 route contract uses the following paths:

- `POST /api/assets/{assetId}/video-object-tracks`
- `PATCH /api/video-object-tracks/{trackId}`
- `DELETE /api/video-object-tracks/{trackId}`

Track update/delete and all keyframe mutations require
`expectedTrackRevision`. A successful response includes the safe track summary
and the new revision.

## Keyframe lifecycle

- `POST /api/video-object-tracks/{trackId}/keyframes`
- `PATCH /api/video-keyframes/{annotationId}`
- `DELETE /api/video-keyframes/{annotationId}`

Requests operate on existing `Annotation` rows, require timestampMs and strict
normalized BOUNDING_BOX geometry, and never accept `expectedAnnotationRevision`.

## Temporal-label lifecycle

- `POST /api/assets/{assetId}/temporal-labels`
- `PATCH /api/temporal-labels/{annotationId}`
- `DELETE /api/temporal-labels/{annotationId}`

Updates/deletes require `expectedRevision`. Responses include the new safe
Annotation revision.

## Common validation and failures

Every route validates with Zod, resolves actor/Asset/Dataset/Label server-side,
checks VIDEO modality and the correct revision domain, and mutates in one
atomic PostgreSQL transaction. Stable outcomes include:

- `400` validation for malformed body, unsafe fields, non-finite values,
  invalid bounds, unsupported geometry, or invalid temporal ranges;
- concealed `404`/policy denial for foreign, unknown, malformed, or
  cross-Dataset resources;
- `409 VIDEO_TRACK_REVISION_CONFLICT` for stale track/keyframe operations;
- `409 ANNOTATION_REVISION_CONFLICT` for stale temporal-label operations;
- safe unsupported-modality response for non-VIDEO writes.

Failures create no Job, JobEvent, queue delivery, Redis entry, provider call,
binary upload, or MinIO mutation. No response contains credentials, storage
identity, raw errors, stack traces, or infrastructure configuration.
