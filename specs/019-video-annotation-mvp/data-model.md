# Phase 019 Data Model

## VideoObjectTrack (existing, minimal additive extension under migration gate)

Represents one labeled object through a VIDEO Asset.

- `id`: stable identifier.
- `videoAssetId`: owning VideoAsset; therefore one Dataset and Asset scope.
- `labelId`: optional same-Dataset Label identity owned by the track.
- `createdById`, `name`, `color`, `properties`, `status`: existing safe track
  metadata.
- `revision`: required track concurrency token, default 1 if absent.
- `annotationType`: MVP `BOUNDING_BOX` if absent.
- `interpolationMode`: MVP `LINEAR` or disabled if absent.
- `annotations`: linked persisted keyframe Annotations.

Potential indexes/constraints requiring audit: `videoAssetId`, `labelId`, and
unique linked keyframe timestamp `(trackId, timestampMs)` without breaking
non-video annotations where nullable fields are used. Track deletion must
cascade or explicitly retire linked keyframes atomically.

## Annotation (existing)

### Keyframe role

`modality=VIDEO`, `trackId` non-null, `isKeyframe=true`,
`isInterpolated=false`, `timestampMs` non-null, `type=BOUNDING_BOX`, valid
normalized geometry, `startMs/endMs` null, and same Asset/Dataset as the track.
The track owns label identity; keyframe writes do not independently relabel it.
`Annotation.revision` remains stored but is not the client lock token for this
role.

### Temporal-label role

`modality=VIDEO`, `trackId=null`, `isKeyframe=false`, `isInterpolated=false`,
`type` in `EVENT | SCENE | SHOT_BOUNDARY`, `startMs/endMs` non-null with
`startMs < endMs`, `timestampMs` null unless existing compatibility requires a
derived value, and no unapproved spatial geometry. `Annotation.revision` is
the sole concurrency token.

## VideoAsset (existing)

Owns duration/fps/codec metadata and tracks. Duration bounds temporal-label
intervals and keyframe timestamps. Missing or unreliable fps prevents a
canonical frameIndex mutation.

## Label (existing)

Must belong to the same Dataset as the Asset/track. Label taxonomy metadata is
not changed by geometry moves or resizes.

## Derived interpolation value

Not a persisted entity. For adjacent compatible keyframes `(t0, box0)` and
`(t1, box1)`, derive `r=(t-t0)/(t1-t0)` and interpolate x, y, width, and height
independently. Derived values are returned/rendered as a safe display object
only.

## Shared workspace shell and registry (no new entity)

The Phase 4/5 shell refactor (spec FR-032–FR-044) introduces no Prisma model,
API DTO, or revision domain. `WorkspaceSelection` (`src/types/workspace.ts`)
— the existing discriminated union keyed by `engine` — remains the only shape
consumed both by `WorkspaceEngine` and by the new client-side
`workspace-engine-registry.ts` module (a plain TypeScript map, not a
database-backed entity) that `DatasetSidebar`, `PropertiesPanel`, and the
shared status surface read to decide their internal content. It is unchanged
by this refactor beyond whatever narrow, non-sensitive fields the Phase 5
audit finds missing for a panel to render what `VideoEngine` already reads
today (e.g. `readiness`, `annotations`). No storage identity, credential, or
provider field is added to `WorkspaceSelection` or the registry.

## State and invariants

- Track/keyframe mutations use one expected track revision and increment once.
- Temporal-label mutations use one expected Annotation revision and increment
  once.
- No persisted `isInterpolated=true` row.
- No Job, Event, Redis, BullMQ, provider, or MinIO mutation from manual edits.
- Property objects and list sizes are bounded by deployment policy.
