# Annotation API Contract

## Common rules

- All routes use the normal opaque-cookie session.
- The route parameter identifies the Asset; Dataset and actor identity are
  resolved server-side.
- Foreign, unknown, and malformed Asset/Annotation references follow the
  existing concealed-resource policy.
- Responses are safe DTOs only. They never include database internals,
  ownership/session values, credentials, source data, storage references, or
  stack traces.
- `revision` is the API's optimistic concurrency field. GET supports all Asset
  modalities; PUT is IMAGE-only in this phase.

## `GET /api/assets/{assetId}/annotations`

### Success — `200`

```json
{
  "data": { "annotations": [
    {
      "id": "annotation-id",
      "assetId": "asset-id",
      "label": { "id": "label-id", "name": "person", "color": "#0EA5E9" },
      "type": "BOUNDING_BOX",
      "geometry": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
      "status": "DRAFT",
      "properties": {},
      "revision": 1,
      "createdAt": "2026-07-29T00:00:00.000Z",
      "updatedAt": "2026-07-29T00:00:00.000Z"
    }
  ] }
}
```

An authorized Asset with no annotations returns `{ "data": { "annotations": [] } }`.

## `PUT /api/assets/{assetId}/annotations`

### Request

```json
{
  "creates": [
    {
      "id": "stable-client-replay-id",
      "type": "BOUNDING_BOX",
      "labelId": "label-id",
      "geometry": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 }
    }
  ],
  "updates": [
    {
      "id": "annotation-id",
      "revision": 1,
      "geometry": { "x": 0.15, "y": 0.2, "width": 0.3, "height": 0.4 }
    }
  ],
  "deletes": [
    { "id": "annotation-id", "revision": 2 }
  ]
}
```

The final request shape uses `creates`, `updates`, and `deletes`; each update
contains `id`, `revision`, optional geometry, and optional explicit `labelId`.
Creates carry a stable client-generated identity for safe replay. Existing
annotations absent from every list are unchanged. IMAGE writes accept strict
bounding boxes, polygons, circles, points, and polylines only.

### Success — `200`

```json
{
  "data": { "annotations": ["safe current annotation DTOs"] }
}
```

### Failure behavior

| Condition | Outcome | Side effect |
| --- | --- | --- |
| Invalid body or geometry | stable validation error | none |
| Asset/label/annotation outside scope | concealed/not-authorized policy outcome | none |
| Revision mismatch | `409 ANNOTATION_REVISION_CONFLICT` | entire change set rolls back |
| Valid change set | `200` safe current DTOs | only requested durable Annotation changes |

No failure creates a Job, JobEvent, Redis/BullMQ entry, MinIO object, or
binary-storage mutation.
