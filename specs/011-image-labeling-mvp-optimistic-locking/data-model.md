# Data Model: Image Labeling MVP and Optimistic Locking

## Persistence decision

Feature 011 uses existing models and fields. It introduces **no Prisma schema change and no migration**.

| Entity | Existing canonical fields used | Feature responsibility |
| --- | --- | --- |
| Dataset | `id`, `primaryModality`, members, labels | Authorization scope and taxonomy owner; primary modality is never an image-only invariant. |
| Asset | `id`, `datasetId`, `modality`, dimensions, `description`, `revision`, `status`, `batchIndex`, `orderIndex` | Selected image identity, safe navigation/listing, description optimistic lock, and status badge. |
| ImageAsset | `assetId` | Confirms image-specific metadata exists where needed; it does not select the workspace engine. |
| Annotation | `id`, `datasetId`, `assetId`, `labelId`, `modality`, `type`, `geometry`, `status`, `revision`, audit user fields | Canonical manual bounding-box record and annotation optimistic lock. |
| Label | `id`, `datasetId`, `name`, `normalizedName`, `color`, `modality` | Active taxonomy item. Label properties are metadata, never geometry. |
| User / DatasetMember | actor identity and Dataset role | Permission evaluation for read, create/update/review, and label management. |
| AuthSession | opaque credential hash, `userId`, expiry, revocation | Existing authenticated-browser lifecycle; public pages consume it only through HTTP-only cookie behavior. |

## Bounding-box geometry contract

```text
geometry = {
  x: number,       // left edge normalized to original image width
  y: number,       // top edge normalized to original image height
  width: number,   // positive normalized extent
  height: number   // positive normalized extent
}
```

Validation rules:

- All values are finite numbers.
- `x`, `y`, `width`, and `height` are in `[0, 1]`.
- `width > 0`, `height > 0`, `x + width <= 1`, and `y + height <= 1`.
- The annotation has IMAGE modality and BOUNDING_BOX type.
- Pixel conversion is derived from the original image dimensions at render/edit time and is never persisted as an additional canonical form.

## Lock and mutation rules

| Mutation | Required optimistic value | Allowed durable changes | Success | Conflict/no target |
| --- | --- | --- | --- | --- |
| Create box | None | New server-scoped Annotation | returns revision 1 | deny invalid/unavailable references without write |
| Geometry update | current Annotation revision | `geometry`, `updatedById`, revision | revision increments once | no write; current state remains authoritative |
| Label reassignment | current Annotation revision | `labelId`, `updatedById`, revision | revision increments once | no geometry/metadata overwrite |
| Delete annotation | current Annotation revision | remove/soft-delete according to existing lifecycle decision | annotation no longer reads as active | no delete when stale/unauthorized |
| Review | current Annotation revision | existing review fields/status only | existing separate review transition | ordinary editor cannot use it as a geometry route |
| Description update | current Asset revision | `description`, revision | revision increments once | no description overwrite |

## State model

### Browser-only workspace state

```text
selectedAssetId
selectedAnnotationId
activeLabelId
tool: select | pan | box
viewport: zoom + pan
draft geometry / label / description
saveState: idle | pending | saving | saved | failed | conflict
```

This state is not durable Job state and must not be stored in Redis.

### Annotation edit lifecycle

```text
loaded → local draft → pending autosave → saving → saved
                              │                │
                              └── failed ◄─────┘
                                               │
                                               └── conflict → explicit reload/discard/reconcile
```

Only a successful save replaces the local version with the returned durable revision.

## Authentication page state

Public login/registration forms retain only non-sensitive email/form error state in browser memory. Password input is never persisted after a response. Authentication success is represented only by the existing HTTP-only cookie, whose opaque raw credential is inaccessible to application JavaScript. A return target is a relative internal application path validated before redirect; it is not an external URL or authorization claim.

## Relationships and integrity checks

- `Annotation.datasetId`, `Annotation.assetId`, and `Annotation.labelId` must resolve inside the actor-authorized Dataset.
- The selected Asset must have IMAGE modality before Image Engine loading or annotation creation.
- A label assignment must belong to the same Dataset and be usable for image annotations according to its modality/scope.
- Geometry-only writes preserve the existing `labelId`, type, status, source, properties, and relationships.
- Label-only writes preserve existing geometry exactly.
- Description writes operate on the selected Asset only and do not change annotations.
