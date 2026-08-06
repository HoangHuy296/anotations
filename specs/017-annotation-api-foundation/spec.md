# Feature Specification: Annotation API Foundation

**Feature Branch**: `017-annotation-api-foundation`  
**Created**: 2026-07-29  
**Status**: Draft  
**Input**: User description: "Phase 17 — Annotation API Foundation"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Load an Asset's Annotations (Priority: P1)

An authorized workspace user opens an Asset and receives the durable
annotations already associated with that Asset before drawing or editing.

**Why this priority**: The workspace cannot render a trustworthy overlay or
avoid duplicate work until it reads the current annotation state.

**Independent Test**: As an authorized Dataset member, request an Asset's
annotations and verify that existing annotations are returned in their saved
order-safe DTO form, while an Asset with none returns an empty array.

**Acceptance Scenarios**:

1. **Given** an authorized actor opens an Asset with saved annotations,
   **When** they request its annotation list, **Then** they receive the current
   annotation metadata, canonical geometry, and `revision` for each annotation.
2. **Given** an authorized actor opens an Asset with no annotations,
   **When** they request its annotation list, **Then** the request succeeds and
   returns an empty array.
3. **Given** an actor is not allowed to access an Asset's Dataset,
   **When** they request that Asset's annotations, **Then** the resource is
   concealed according to the existing ownership policy and no annotation data
   is disclosed.

---

### User Story 2 - Save Valid Annotation Changes Safely (Priority: P1)

An authorized annotator can create, update, or explicitly remove annotations
for one Asset through one validated save operation.

**Why this priority**: Durable, server-validated annotation persistence is the
foundation for canvas autosave and future reviewing workflows.

**Independent Test**: Submit a mixed valid change set for a permitted Asset and
verify that the intended annotations are created or updated atomically, with
canonical normalized geometry and no changes to another Asset or Dataset.

**Acceptance Scenarios**:

1. **Given** an authorized annotator submits valid normalized geometry,
   **When** they save it for an Asset in their Dataset scope, **Then** the
   annotation is persisted against that exact Asset and receives a revision.
2. **Given** a save request contains an invalid annotation, label reference, or
   geometry value, **When** it is submitted, **Then** the request is rejected
   and none of the requested annotation changes are persisted.
3. **Given** an actor tries to write annotations for an Asset outside their
   Dataset scope, **When** they save, **Then** the request is concealed or
   denied under the existing resource policy and has no side effect.

---

### User Story 3 - Prevent Stale Annotation Overwrites (Priority: P1)

Two collaborators cannot silently overwrite one another's saved annotation
geometry.

**Why this priority**: Autosave is only safe when it detects that an annotation
changed after the user last loaded it.

**Independent Test**: Load an annotation twice, save one copy, then submit the
other copy with its old revision and verify that it receives a conflict without
changing the current durable annotation.

**Acceptance Scenarios**:

1. **Given** an existing annotation and its current `revision`, **When** an
   authorized actor submits a valid update with that revision, **Then** the
   update succeeds and the returned revision increases.
2. **Given** an existing annotation was changed after an actor loaded it,
   **When** that actor submits an update using an earlier revision, **Then**
   the request returns a stable conflict outcome and does not overwrite the
   current annotation.
3. **Given** a batch contains any stale revision, **When** it is submitted,
   **Then** the batch is not partially applied and the client can reload the
   current annotation list.

### Edge Cases

- An Asset identifier that is malformed, unknown, or outside the actor's scope
  follows the existing concealed-resource policy.
- A geometry coordinate, extent, radius, or point outside normalized bounds is
  rejected; a rectangle that extends beyond an image boundary is also rejected.
- A geometry payload that is not a supported canonical shape, contains
  non-finite numbers, or contains an invalid point structure is rejected.
- An existing annotation from another Asset or Dataset cannot be updated,
  deleted, or reassigned by supplying its identifier in a different Asset's
  request.
- Omitted annotations do not imply deletion. Deletion must be explicit so a
  partial client state or failed page load cannot erase durable work.
- A geometry-only change retains the annotation's assigned label and other
  annotation metadata; moving or resizing must not modify Label taxonomy
  metadata.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide an authorized annotation-list read for
  one IMAGE, VIDEO, TEXT, or AUDIO Asset that returns its existing annotations
  or an empty array when none exist.
- **FR-002**: The list response MUST contain only safe annotation data needed
  by the workspace: annotation identifier, Asset identifier, label reference
  and safe display metadata where already authorized, canonical geometry,
  annotation state, properties, timestamps, and current `revision`.
- **FR-003**: The system MUST provide one authorized bulk annotation mutation
  for a single Asset. The mutation MAY create new annotations, update existing
  annotations, and explicitly delete existing annotations; it MUST apply as
  one all-or-nothing change set.
- **FR-004**: The system MUST derive the actor from the current opaque session
  and enforce the existing Dataset, Asset, Label, and Annotation ownership
  rules. It MUST NOT trust a browser-provided owner, Dataset, or creator
  identifier.
- **FR-005**: Every referenced existing annotation MUST belong to the Asset in
  the request. Every assigned label MUST belong to the same Dataset as that
  Asset. Cross-Asset and cross-Dataset references MUST be rejected without
  mutation.
- **FR-006**: The system MUST validate the supported geometry scaffold before
  persistence. `Annotation.geometry` remains the canonical JSON shape and all
  saved coordinates are normalized to the original Asset dimensions.
- **FR-007**: The geometry validator MUST reject non-finite values and values
  outside `0..1`, including shapes whose extents leave the normalized image
  boundary. It MUST validate the required structure for each supported shape.
- **FR-008**: Geometry-only updates MUST change geometry only. They MUST retain
  label assignment, Label taxonomy metadata, and unrelated annotation metadata.
- **FR-009**: Existing annotation updates and explicit deletions MUST include
  the currently known `revision`. The server MUST reject stale revisions with
  a stable conflict result and MUST NOT partially apply a conflicting batch.
- **FR-010**: A successful mutation MUST return safe, current annotation DTOs
  including their incremented `revision` values. `revision` is the public
  version-aware concurrency field; this phase MUST NOT introduce a second
  version column or rename the established canonical field.
- **FR-011**: Annotation creation, update, deletion, and geometry validation
  failures MUST have no MinIO, Redis/BullMQ, Job, or binary-storage side
  effects. Annotation saves are synchronous metadata mutations, not Jobs.
- **FR-012**: Browser-visible responses and errors MUST NOT expose sessions,
  credentials, source connections, private storage details, raw database
  errors, stack traces, or unrelated annotation data.
- **FR-013**: The browser-facing endpoints for this phase are `GET` and `PUT`
  at `/api/assets/[assetId]/annotations`. `GET` is read-only; `PUT` is the
  single Asset-scoped mutation boundary for the supported bulk change set.
- **FR-014**: PUT MUST accept IMAGE writes only. Its supported canonical
  geometry types are BOUNDING_BOX, POLYGON, CIRCLE, POINT, and POLYLINE.
  Segmentation masks and every non-image write are explicitly unsupported in
  this phase.
- **FR-015**: A create MUST carry a bounded stable replay identity. Replaying
  that identity for the identical actor, Asset, type, label, and geometry is
  idempotent; a conflicting reuse is rejected.

### Key Entities

- **Annotation**: A durable, Asset-scoped record whose canonical `geometry`
  describes the selected image region and whose `revision` protects it from
  stale writes.
- **Annotation change set**: The validated desired creates, updates, and
  explicit deletions for one Asset. It is accepted or rejected as one unit.
- **Geometry**: The normalized canonical shape data for an annotation. It is
  distinct from label taxonomy metadata and from viewport state.
- **Revision conflict**: The outcome when a submitted update refers to a prior
  revision of an annotation that has already changed durably.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An authorized workspace user receives the current annotation
  list for an Asset, including an empty list, in 100% of controlled read tests.
- **SC-002**: In controlled valid mutation tests, 100% of saved annotations
  belong to the requested Asset and retain normalized canonical geometry.
- **SC-003**: In controlled invalid-geometry, cross-Asset, cross-Dataset, and
  denied-access tests, 100% of rejected requests leave the annotation set
  unchanged.
- **SC-004**: In controlled stale-write tests, 100% of stale updates are
  rejected and the newer durable annotation remains unchanged.
- **SC-005**: In controlled response and error audits, no response exposes a
  credential, session value, private storage location, raw server error, or
  annotation data outside the actor's authorized Dataset scope.

## Assumptions

- The established `Annotation.revision` field is the canonical optimistic
  concurrency field. The user's requested “version-aware” behavior is
  satisfied by that field without a schema change.
- Existing Dataset role permissions remain authoritative: create/update-own,
  update-any, and review capabilities are enforced according to the current
  ownership policy; this phase does not redefine roles.
- Reads support IMAGE, VIDEO, TEXT, and AUDIO through one safe projection.
  Writes are IMAGE-only in this phase and fully validate bounding boxes,
  polygons, circles, points, and polylines; segmentation and future types stay
  unsupported for writes.
- This phase supplies the API foundation only. Canvas rendering, autosave
  scheduling, annotation review decisions, bulk import/export, and label
  taxonomy management are outside its scope.
- No schema migration, new dependency, queue change, worker processing, or
  binary storage change is assumed or authorized by this specification.
