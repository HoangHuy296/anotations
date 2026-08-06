# Research: Annotation API Foundation

## Decision 1 — Use `Annotation.revision` as the sole concurrency field

**Decision**: The API exposes and requires `revision` for every existing-row
update or deletion.

**Rationale**: The current Prisma model already owns an integer `revision`,
and existing image mutation code guards updates with it. A second `version`
field would split the optimistic-lock source of truth and require an
unapproved migration.

**Alternatives considered**:

- Add `Annotation.version`: rejected because it duplicates durable concurrency
  state and conflicts with current schema/constitution terminology.
- Use timestamps as concurrency tokens: rejected because they are less exact
  and would require a different locking contract.

## Decision 2 — Use explicit change lists, not omission-as-delete

**Decision**: The bulk request contains separate creates, geometry updates,
and explicit deletes.

**Rationale**: A workspace may hold a partial list after a failed load or
pagination change. Explicit deletion prevents a partial client snapshot from
silently deleting durable annotations.

**Alternatives considered**:

- Treat the body as a complete replacement snapshot: rejected because it makes
  accidental loss likely and complicates stale snapshot recovery.
- One HTTP request per annotation: rejected because it cannot make a related
  edit set atomic and multiplies autosave conflict windows.

## Decision 3 — Bound geometry validation to supported canonical shapes

**Decision**: Start with a strict normalized bounding-box schema and a
discriminated validation scaffold for future shapes; unsupported shapes are
rejected rather than stored as arbitrary JSON.

**Rationale**: Bounding boxes are the current editable workspace engine.
Rejecting unknown geometry preserves `Annotation.geometry` as trustworthy
canonical data while leaving a clear extension path.

**Alternatives considered**:

- Accept any JSON object: rejected because malformed/out-of-range geometry
  would become canonical data.
- Implement every future geometry type now: rejected as scope expansion beyond
  the API foundation.

## Decision 4 — Atomic Prisma transaction with guarded mutations

**Decision**: Validate and mutate one Asset-scoped change set in a single
Prisma transaction; use revision-guarded writes and abort/rollback if any
guarded update or delete affects zero rows.

**Rationale**: It gives a stable no-partial-write result without raw SQL and
matches the existing optimistic-lock approach.

**Alternatives considered**:

- Application find-then-write: rejected because concurrent saves can pass the
  read and overwrite a later write.
- Raw SQL bulk update: rejected because it is not approved or needed.

## Decision 5 — Reuse existing Dataset permission policy

**Decision**: Create uses `annotation.create`; an existing annotation chooses
`annotation.updateOwn` or `annotation.updateAny` based on server-read
creator identity. Asset/Dataset scope is concealed using the established
guards.

**Rationale**: It preserves the approved role matrix and never trusts a
browser-provided actor or owner.

**Alternatives considered**:

- Apply one broad update permission to every mutation: rejected because it
  would permit labelers to alter others' annotations.
- Add new permissions: rejected because this phase defines API plumbing, not a
  role-policy amendment.

## Decision 6 — Synchronous annotation persistence only

**Decision**: Annotation saves do not create Jobs or contact BullMQ, Redis,
MinIO, or the private worker.

**Rationale**: They are small durable metadata updates and must be immediately
version-aware for autosave.

**Alternatives considered**:

- Queue autosave writes: rejected because it weakens read-after-write and
  concurrency behavior while adding no value to the requested foundation.
