# Research: Image Labeling MVP and Optimistic Locking

## Decision: Reuse opaque cookie sessions; do not introduce JWT

**Decision**: Build public login and registration pages over the existing signup/login endpoints and opaque HTTP-only cookie session. Protected page redirects carry only a validated internal return path; the browser never receives a JWT, session credential, or refresh credential in page data or storage.

**Rationale**: `AuthSession` in PostgreSQL is the existing revocation and expiry authority. The current proxy already validates the opaque cookie before protected access, while current auth endpoints create/rotate/revoke sessions safely.

**Alternatives considered**:

- Browser-readable JWT — rejected because it conflicts with the existing revocable server-managed session architecture and expands token exposure.
- Add another auth provider or identity flow — rejected because existing signup/login APIs already meet Feature 011 needs.
- Preserve `/unauthorized` as the only unauthenticated destination — rejected because it does not provide the required login path or safe return flow.

## Decision: Use the existing shared workspace route and modality selection

**Decision**: Keep `/workspace/[datasetId]` as the single workspace route. Resolve the selected Asset server-side and select the Image Engine only when `Asset.modality` is IMAGE.

**Rationale**: This follows Architecture Lock: `Asset.modality` is the workspace-engine source of truth and routes must not split by modality.

**Alternatives considered**:

- Separate `/image-workspace/...` routes — rejected because it duplicates workspace routing and makes future modality engines harder to compose.
- Use `Dataset.primaryModality` as an invariant — rejected because a Dataset can be mixed and its primary modality is only a UI default.

## Decision: Persist normalized original-image bounding boxes

**Decision**: Persist canonical geometry as `{ x, y, width, height }`, all finite numbers in the inclusive range `[0, 1]`, with positive width and height. Convert between original-image coordinates and canvas/viewport coordinates only at the browser boundary.

**Rationale**: Original-image-relative geometry remains stable when an image is displayed at a different size, panned, zoomed, or revisited.

**Alternatives considered**:

- Persist canvas pixels — rejected because resize and zoom cause drift.
- Persist viewport transform with each annotation — rejected because it is personal UI state, not annotation meaning.
- Add polygon/circle schemas now — rejected because Feature 011 is intentionally bounding-box-only.

## Decision: Treat geometry, label assignment, and description as independent guarded mutations

**Decision**: Keep geometry-only and label-only annotation mutations separate from description mutation. Each annotation mutation requires the current Annotation revision; description mutation requires the current Asset revision. A guarded write returns a new revision only on success.

**Rationale**: This makes the rule “moving/resizing changes only coordinates” enforceable, avoids metadata loss, and allows a stale update to be rejected atomically.

**Alternatives considered**:

- Send a full annotation object for every edit — rejected because move/resize could overwrite label/status/properties.
- Last-write-wins autosave — rejected because it silently destroys newer work.
- Add a separate version column — rejected because Annotation and Asset already have canonical revisions.

## Decision: Autosave only at interaction boundaries after 1.5 seconds

**Decision**: Canvas pointer movement updates only local draft state. Draw end, drag end, transform end, label change, delete, and description typing schedule autosave after 1.5 seconds of inactivity. Starting another eligible edit resets that timer.

**Rationale**: It gives users responsive feedback without continuous persistence or a flood of version increments.

**Alternatives considered**:

- Save every pointer move — rejected by Canvas Rules and causes needless conflicts.
- Require a manual save button only — rejected because the requested workflow explicitly needs autosave.
- Add durable undo/redo history — deferred; current schema has no approved annotation-history model.

## Decision: Conflict handling preserves the local draft and requires explicit action

**Decision**: On a revision conflict, leave the local draft intact, show conflict state, load or present current durable data, and offer explicit reload/discard/reconcile. Do not auto-retry a stale write.

**Rationale**: This meets stale-overwrite safety without guessing user intent.

**Alternatives considered**:

- Automatically overwrite with local state — rejected as data loss.
- Automatically merge arbitrary rectangle and description edits — rejected because concurrent edits can be semantically incompatible.

## Decision: Use existing authorized view capability for image loading

**Decision**: The browser requests an authorized short-lived view capability through the existing application boundary. It never knows storage credentials or durable object storage references.

**Rationale**: This retains the Phase 006/010 private-storage model and allows preview expiry to be handled safely.

**Alternatives considered**:

- Expose MinIO client credentials or a permanent object URL — prohibited by Architecture Lock.
- Proxy image binary through a new backend download endpoint — out of scope and unnecessary for the existing capability model.

## Decision: Label defaults are idempotent and only taxonomy managers mutate labels

**Decision**: Establish object, person, vehicle, animal, and text only when an authorized label manager requests defaults for an empty taxonomy; use normalized-name uniqueness to avoid duplicates. Deletion is allowed only for unreferenced labels.

**Rationale**: It supports immediate annotation without overwriting user taxonomy or detaching historical annotation meaning.

**Alternatives considered**:

- Re-seed labels on every workspace visit — rejected because it risks duplicate/overwritten taxonomy.
- Delete referenced labels and null annotation labels — rejected because it weakens annotation semantics.

## Decision: Search full Dataset and page at 100

**Decision**: Apply case-insensitive filename filtering before result pagination. Use stable batch/order/id ordering, page at a maximum of 100, and preserve the current result ordering for previous/next navigation.

**Rationale**: Filtering only the loaded page fails the 10,000-image usability requirement and gives surprising navigation.

**Alternatives considered**:

- Load a fixed 250-image list — rejected because it truncates the Dataset and violates requested batching.
- Search only current batch — rejected because it misses matching files elsewhere.
