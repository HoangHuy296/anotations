# Geometry and Optimistic-Locking Contract

## Canonical bounding box

All persisted bounding boxes use normalized original-image geometry:

```ts
type NormalizedBoundingBox = {
  x: number
  y: number
  width: number
  height: number
}
```

The stored JSON must satisfy `0 <= x, y < 1`, `0 < width, height <= 1`, and
`x + width <= 1`, `y + height <= 1`. Viewport pan, viewport zoom, display
pixels, stage offsets, and transformer handles are not persisted.

## Safe annotation read projection

```ts
type SafeImageAnnotation = {
  id: string
  assetId: string
  labelId: string | null
  type: "BOUNDING_BOX"
  geometry: NormalizedBoundingBox
  status: "DRAFT" | "IN_PROGRESS" | "COMPLETED"
  version: number
  updatedAt: string
}
```

The projection omits raw properties, unrelated source metadata, private storage
references, user credentials, and review identities unless an existing
authorized review contract requires a separate safe projection.

## Guarded mutation semantics

| Intent | Client submits | Server verifies | Durable update | Result |
| --- | --- | --- | --- | --- |
| Create | asset id, optional label id, normalized box | actor, Dataset/Asset/Label relation, IMAGE modality, create permission | creates one manual bounding box | safe annotation with version |
| Geometry edit | annotation id, current version, normalized box | actor, same Dataset/Asset, own-or-any permission, version | geometry only + revision increment | safe annotation with new version |
| Relabel | annotation id, current version, label id | actor, same Dataset/Label, own-or-any permission, version | label only + revision increment | safe annotation with new version |
| Delete | annotation id, current version | actor, same Dataset/Asset, own-or-any permission, version | delete/retire current record | success acknowledgement |
| Description | asset id, current Asset revision, text | actor, Dataset/Asset, update entitlement, revision | description only + Asset revision increment | safe Asset description/revision |

`409` is returned for a stale current record. The response identifies a safe
conflict condition without returning raw storage, credential, queue, or server
error data. A denied or invalid request has no side effect.

## Autosave protocol

- Browser interaction updates local state immediately.
- A 1.5-second quiet interval schedules one durable save for the changed
  annotation or description.
- New interaction resets the interval; pointer-move loops do not persist.
- A successful response becomes the only source of the next current version.
- On failure/conflict, the local draft remains visible and no automatic
  force-write is attempted.
- Conflict recovery is explicit: the user can reload the durable version,
  discard the local draft, or keep it visible for manual reconciliation. None
  of these choices submits a forced stale write.
