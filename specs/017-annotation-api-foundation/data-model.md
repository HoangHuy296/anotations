# Data Model: Annotation API Foundation

## Existing durable entities

### Annotation

The existing Asset-scoped durable annotation remains the central record.

| Field/group | Role in Phase 017 | Rules |
| --- | --- | --- |
| `id`, `datasetId`, `assetId` | Identity and scope | Server-resolved; an existing ID must belong to the route Asset and its Dataset. |
| `labelId` | Existing label assignment | Create validates same-Dataset label; geometry-only update does not change it. |
| `createdById`, `updatedById` | Actor audit | Derived from current session actor; never accepted from browser input. |
| `modality`, `type` | Geometry interpretation | Derived/validated against the Asset and supported schema. |
| `geometry` | Canonical durable shape | Normalized values only; strict supported geometry schema. |
| `properties`, `status`, review fields | Annotation metadata | Preserved by geometry-only updates; review semantics remain outside this phase. |
| `revision` | Optimistic concurrency | Starts at existing schema default, increments once per successful update; required for update/delete. |
| timestamps | Safe projection/audit | Server-managed only. |

### Asset and Dataset

The route Asset resolves its Dataset server-side. The actor must have the
established Dataset permission, and the Asset cannot be deleted or archived.
No request body value may choose a different Dataset or owner.

### Label

A label referenced at create time must belong to the Asset's Dataset and be
compatible with the Asset modality under current policy. Label taxonomy fields
are never changed through this API.

## Change-set request model

| Component | Required fields | Validation |
| --- | --- | --- |
| `creates[]` | supported type, canonical geometry, optional same-Dataset label | Actor and Asset scope are server-derived; no client owner/Dataset/creator. |
| `geometryUpdates[]` | annotation ID, current `revision`, geometry | Existing row must match route Asset; geometry is strict and normalized. |
| `deletes[]` | annotation ID, current `revision` | Existing row must match route Asset and current revision. |

All lists are bounded by a server-side request limit selected during planning;
the implementation must reject over-limit bodies before mutation. An omitted
existing annotation is unchanged.

## State transitions

| Operation | Preconditions | Durable result |
| --- | --- | --- |
| Create | actor has create permission; Asset/Label valid; geometry valid | one new Annotation at default revision. |
| Geometry update | actor has own/any permission; annotation belongs to Asset; revision matches | geometry and updater change; revision increments. |
| Explicit delete | actor has own/any permission; annotation belongs to Asset; revision matches | annotation is removed. |
| Conflict | any existing row revision differs | entire change set rolls back; no state change. |
| Validation/authorization failure | any invalid reference, geometry, or access | no state change. |

## Safe response model

A safe annotation DTO contains only workspace-required annotation identity,
Asset identifier, label reference/safe display data where authorized, type,
canonical geometry, permitted annotation state/properties, `revision`, and
timestamps. It excludes ownership/session details, source connections,
storage/provider details, raw database errors, and server configuration.

## Migration impact

None. Phase 017 uses the existing `Annotation.revision` model field and does
not add or rename database fields.
