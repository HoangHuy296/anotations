# Feature Specification: Image Labeling MVP and Optimistic Locking

**Feature Branch**: `011-image-labeling-mvp-optimistic-locking`

**Created**: 2026-07-17

**Status**: Draft

**Input**: User description: "Build the first fully functional image annotation engine with bounding-box labeling, image workspace management, 1.5-second autosave, and optimistic locking that prevents stale overwrites."

## User Scenarios & Testing *(mandatory)*

### User Story 0 - Register and sign in safely (Priority: P1)

A visitor can create an account or sign in through clear public pages, then enter the protected application without handling an authentication credential directly.

**Why this priority**: A usable image-labeling workspace requires a reliable entry point for new and returning users, while preserving the existing authorization boundary.

**Independent Test**: A new visitor registers through the registration page, is signed in, reaches an authorized protected destination, signs out, and is denied when attempting to revisit that protected destination. A returning user can sign in through the login page with the same result.

**Acceptance Scenarios**:

1. **Given** a visitor has no active session, **When** they visit a protected workspace or Dataset page, **Then** they are directed to the login page and can return to the originally intended safe in-application destination after successful sign-in.
2. **Given** a visitor supplies valid registration details, **When** they submit the registration page, **Then** an account and authenticated server-managed session are created and the visitor is directed to an authorized application destination.
3. **Given** a returning user supplies valid credentials, **When** they submit the login page, **Then** they are authenticated and directed to the intended safe destination or the default authenticated landing page.
4. **Given** credentials are malformed, invalid, or already registered, **When** the visitor submits either form, **Then** the page shows a safe actionable error without disclosing a password, session credential, token, or internal implementation detail.
5. **Given** an authenticated user visits login or registration, **When** the page loads, **Then** they are directed away from the public authentication form to an authorized application destination.

---

### User Story 1 - Open and annotate an image (Priority: P1)

An authorized annotator opens an image Asset from a Dataset, sees the image centered in a workspace, selects a label, and draws, selects, moves, resizes, or deletes an axis-aligned bounding box.

**Why this priority**: This is the first complete user-value loop: imported images become durable, human-created annotations.

**Independent Test**: An authorized user opens an image, draws one box, assigns a label, moves and resizes it, and reloads the workspace to see the same geometry in the same original-image-relative location.

**Acceptance Scenarios**:

1. **Given** an authorized user selects an IMAGE Asset, **When** its workspace opens, **Then** the image preview, existing annotations, labels, and saved description are shown without exposing storage credentials or private object keys.
2. **Given** an active label and bounding-box tool, **When** the user drags over the image, **Then** a ghost box provides feedback and releasing the pointer creates exactly one labeled bounding-box annotation.
3. **Given** a selected bounding box, **When** the user moves or resizes it, **Then** its saved geometry changes while its annotation id, type, assigned label, and other metadata remain unchanged.
4. **Given** a selected annotation, **When** the user deletes it, **Then** it disappears from the canvas and Shapes list and is not shown after reload.
5. **Given** an Asset whose modality is not IMAGE, **When** a user reaches the shared workspace route, **Then** the image engine is not selected and the user receives a safe, modality-appropriate state rather than an image canvas.

---

### User Story 2 - Work accurately at any viewport (Priority: P1)

An annotator pans and zooms an image without changing the meaning of saved annotations, and can select an existing shape from either the canvas or Shapes panel.

**Why this priority**: A labeling tool is only trustworthy when viewport changes never distort or corrupt image-relative data.

**Independent Test**: Create a box, apply pan and multiple zoom levels, move/resize it, then verify the saved geometry remains within normalized bounds and renders in the same original-image-relative position after reload.

**Acceptance Scenarios**:

1. **Given** an image larger than the center panel, **When** it opens, **Then** it is centered and scaled to fit while retaining a usable full-image view.
2. **Given** an annotator zooms or pans, **When** they view or edit a box, **Then** overlay alignment remains correct and only viewport state changes until an edit is committed.
3. **Given** a shape is selected in the Shapes panel, **When** the user clicks its row, **Then** the corresponding canvas shape is highlighted with a stronger visual treatment and becomes editable.
4. **Given** a user clicks an existing shape on the canvas, **When** it becomes selected, **Then** the matching Shapes row is selected and editing/deletion controls become available.

---

### User Story 3 - Save safely during concurrent work (Priority: P1)

An annotator receives reliable autosave feedback and never silently overwrites a newer annotation or image description saved by another session or collaborator.

**Why this priority**: Reliable collaboration and recovery are essential before annotations can be trusted for review or training data.

**Independent Test**: Open the same annotation in two authenticated sessions. Save a geometry update in the first session, then save the stale second-session draft; the second save is rejected, its local draft remains available, and the first session's durable geometry is unchanged.

**Acceptance Scenarios**:

1. **Given** a user stops drawing, moving, resizing, reassigning a label, deleting, or editing a description, **When** 1.5 seconds pass without another relevant edit, **Then** the changed item is autosaved and the workspace shows its save state.
2. **Given** an annotation edit is saved successfully, **When** the response is received, **Then** the annotation's current version advances and becomes the version used by later edits.
3. **Given** a description edit is saved successfully, **When** the response is received, **Then** the image's current revision advances and becomes the revision used by later description edits.
4. **Given** an autosave request carries an old annotation version or image revision, **When** it reaches the server, **Then** it is rejected as a conflict and no stale field overwrites the newer durable value.
5. **Given** a conflict is returned, **When** the user remains in the workspace, **Then** the UI clearly identifies the conflict, preserves the unsaved local draft, offers reload or discard, and never retries by overwriting newer data automatically.

---

### User Story 4 - Manage labels, shapes, and image navigation (Priority: P2)

An authorized team member manages the image's description and Dataset taxonomy, and navigates a large image collection without losing the active image or selection context.

**Why this priority**: Efficient navigation and taxonomy management make the P1 annotation loop usable for real labeling batches.

**Independent Test**: In a Dataset with more than 100 image Assets, filter by a filename substring, navigate to a matching image outside the first batch, assign and reassign labels through the sidebar, and confirm that unauthorized taxonomy changes are denied.

**Acceptance Scenarios**:

1. **Given** an image workspace, **When** the user opens the right management sidebar, **Then** Description, Labels, Shapes, and Images views are available without obscuring the canvas selection state.
2. **Given** a Dataset without a taxonomy, **When** an authorized taxonomy manager opens the Labels view, **Then** the default labels object, person, vehicle, animal, and text are available exactly once by normalized name.
3. **Given** a user with taxonomy-management permission, **When** they add a unique label or remove an unreferenced label, **Then** the Dataset taxonomy updates and the active-label selector refreshes; removing a referenced label is refused to preserve annotation meaning.
4. **Given** an existing annotation, **When** an authorized annotator changes its assigned label in the Shapes view, **Then** only label assignment changes; its geometry is not altered.
5. **Given** a Dataset contains many image Assets, **When** the user searches by filename, **Then** case-insensitive substring search considers the full Dataset and results are presented in pages of at most 100 images.
6. **Given** an image list item, **When** it is displayed, **Then** it shows a safe status badge, batch location, and enough identity for the user to select it.

### Edge Cases

- An image is unavailable, deleted, archived, has no readable dimensions, or its authorized preview link expires while the workspace is open.
- A drawing begins outside the image, is released outside the image, or produces zero width or height; no invalid annotation is saved.
- A normalized bounding box would exceed the image boundary after resize; its persisted coordinates are bounded to the image.
- A user loses permission, the Dataset is archived, or the Asset changes while an autosave is pending; the save is denied without a partial mutation.
- The active label is removed or becomes unavailable before a new box is saved; the user must choose an available label.
- Two sessions edit the same annotation, delete versus edit the same annotation, or edit the same image description concurrently.
- The selected Asset does not have IMAGE modality, or a known Asset id belongs to another Dataset.
- Search yields no images, a requested batch is beyond the result set, or the currently selected image is no longer present in a filtered view.
- A visitor supplies a malicious or external return destination, submits duplicate registration, refreshes after logout, or opens a protected URL with an expired/revoked session.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST use the existing shared Dataset workspace and select the image labeling engine only when the selected Asset's modality is IMAGE. It MUST NOT create separate workspace routes by modality.
- **FR-002**: The system MUST permit only authorized Dataset members to view an image Asset, its labels, its annotations, and its description. Known identifiers outside the actor's Dataset scope MUST disclose no resource data.
- **FR-003**: The workspace MUST present the image centered and fitted in the center canvas, with existing annotations rendered as overlays and a visibly distinct selected shape.
- **FR-004**: The MVP MUST support only manual axis-aligned bounding boxes. A box MUST have one normalized geometry object containing `x`, `y`, `width`, and `height`, each expressed relative to the original image dimensions and bounded to the inclusive range 0 through 1.
- **FR-005**: The system MUST display a temporary ghost box while the user draws and MUST create an annotation only after a valid non-zero box is completed.
- **FR-006**: The workspace MUST support select, pan, zoom, bounding-box creation, move, resize, label assignment/reassignment, and deletion. Pan and zoom MUST be viewport-only and MUST NOT alter persisted geometry.
- **FR-007**: Moving or resizing a box MUST update geometry only. It MUST NOT change the annotation's label, type, source, status, properties, or unrelated metadata.
- **FR-008**: Reassigning a label MUST change label assignment only. It MUST NOT alter the annotation geometry.
- **FR-009**: New annotations MUST be created with server-derived Dataset, Asset, creator, IMAGE modality, and bounding-box type. Browser input MUST NOT choose ownership or cross-Dataset references.
- **FR-010**: Every annotation mutation after creation MUST include the current annotation version. A successful mutation MUST increment that version exactly once; a missing, stale, deleted, or unauthorized target MUST make no mutation.
- **FR-011**: Every image-description mutation MUST include the current Asset revision. A successful description save MUST increment that revision exactly once; a stale revision MUST be rejected without overwriting the newer description.
- **FR-012**: The workspace MUST start autosave after 1.5 seconds of inactivity following an eligible annotation or description edit. It MUST expose pending, saved, failed, and conflict states.
- **FR-013**: On an optimistic-lock conflict, the system MUST preserve the local unsaved draft, fetch or make available the durable current state, and require explicit user intent to discard or reconcile the draft. It MUST NOT silently overwrite or automatically force-save a stale draft.
- **FR-014**: The Shapes view MUST list all current image annotations with shape type, assigned label, selection state, and deletion action. Canvas and Shapes selection MUST remain synchronized after create, edit, relabel, delete, and conflict resolution.
- **FR-015**: The Labels view MUST show the Dataset taxonomy. Users with label-management permission MAY create unique labels and remove only unreferenced labels; other roles MAY read and choose available labels but MUST NOT change the taxonomy.
- **FR-016**: When a Dataset has no labels, authorized taxonomy managers MUST be able to establish the default object, person, vehicle, animal, and text labels without duplicates by normalized name. Existing user-created labels MUST never be overwritten.
- **FR-017**: The Images view MUST list IMAGE Assets only, page results in batches of at most 100, support case-insensitive filename substring search across the full Dataset, retain batch ordering, and show safe Asset status badges.
- **FR-018**: The previous and next image controls MUST navigate within the current search/result ordering and MUST not discard a pending edit without first allowing it to save, resolve, or be explicitly discarded.
- **FR-019**: Image binary access MUST use only an authorized short-lived view capability. Browser-visible responses, UI state, URLs, and errors MUST NOT contain storage credentials, provider credentials, private storage keys, decrypted tokens, or binary data.
- **FR-020**: Annotation review remains separate from ordinary annotation edits. Ordinary image-labeling edits MUST use editable states only; accept/reject behavior and reviewer identity MUST remain on the existing review boundary.
- **FR-021**: All denial, validation, conflict, and failed-save paths MUST have no unintended change to annotations, Assets, labels, Job state, queue state, or storage objects.
- **FR-022**: The system MUST provide public login and registration pages that use the existing server-managed authentication flow. These pages MUST NOT introduce, issue, store, or depend on a browser-readable JWT.
- **FR-023**: Successful registration and login MUST establish the existing opaque HTTP-only session cookie and return only the existing safe current-user profile. Passwords, session credentials, hashes, refresh credentials, provider credentials, and tokens MUST NOT be rendered, persisted in browser storage, or exposed in page data.
- **FR-024**: Public authentication forms MUST validate required credentials before submission, present safe field/form errors, prevent duplicate submissions while pending, and preserve only non-sensitive user-entered form state after a safe validation failure.
- **FR-025**: Protected application pages MUST redirect unauthenticated, expired, revoked, or logged-out visitors to login. After successful authentication, the system MAY restore only an internal safe return destination; external or malformed destinations MUST be ignored.
- **FR-026**: An authenticated visitor opening login or registration MUST be redirected to an authorized application destination. Sign-out MUST continue to revoke the active server-managed session and prevent later access to protected workspace data.

### Key Entities

- **Image Asset**: An authorized Dataset Asset with IMAGE modality, its original dimensions, safe status, description, revision, and a temporary view capability.
- **Bounding-box Annotation**: A manual IMAGE annotation associated with one Asset, one optional Dataset Label, canonical normalized geometry, lifecycle status, and current version.
- **Annotation Version**: The current optimistic-lock value returned after creation or successful mutation and required for subsequent changes to that annotation.
- **Image Description Revision**: The Asset's current optimistic-lock value used to protect the independent image description field.
- **Dataset Label**: A normalized taxonomy item, optionally active for new boxes, that supplies a visible name and color without becoming part of geometry.
- **Workspace View State**: Non-durable user state including selected image, selected annotation, active label, active tool, zoom, pan, filter, current batch, save status, and local conflict draft.
- **Authenticated Session**: The existing server-managed session associated with a user and delivered only through an opaque HTTP-only cookie; it is not a JWT and is never exposed to application JavaScript.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An authorized user can open an existing image, create a labeled bounding box, and see it after reload in under two minutes using the primary workspace flow.
- **SC-002**: In the bounding-box integration matrix, 100% of created, moved, and resized boxes persist coordinates bounded to the original image-relative range and retain their label/type metadata during geometry-only edits.
- **SC-003**: In concurrent-save tests, 100% of stale annotation and description saves are rejected with no overwrite of the newer durable value; the stale client retains a recoverable local draft.
- **SC-004**: In authorization tests, 100% of non-member or insufficient-role image, annotation, label, description, and view-capability actions are denied without durable, queue, or storage side effects.
- **SC-005**: In an image collection of at least 250 images, filename search considers all matching images and each displayed result page contains no more than 100 items.
- **SC-006**: After a valid interaction stops, save-state feedback is visible within two seconds and a successful autosave is reflected after reload.
- **SC-007**: Browser response and state audits disclose no provider/storage credentials, private object keys, decrypted connection values, or binary content.
- **SC-008**: In authentication page tests, 100% of successful registration/login flows reach an authorized protected destination without exposing a credential to browser-visible state; 100% of invalid, duplicate, expired, revoked, and logged-out cases remain safely denied or show only safe errors.

## Assumptions

- Phase 010 is approved as the completed dependency; it supplies authorized IMAGE Assets, safe view capabilities, Dataset membership, labels, and durable metadata.
- Existing Annotation `revision` is the persisted implementation of the product-facing annotation version contract. This phase must not add a competing version field or migration merely for naming.
- Existing Asset `revision` protects description saves independently from Annotation versioning.
- The current Dataset permission matrix remains authoritative: users with annotation-create/update rights may work on shapes according to their own/any-update entitlement; only label managers change taxonomy; review remains a separate permission.
- Existing authentication is opaque cookie sessions backed by durable `AuthSession` records. The user-requested “existing JWT” is interpreted as the existing authentication experience; this phase must not replace it with JWTs.
- The MVP operates on desktop-class pointer input. Responsive layout is required, but touch-specific drawing gestures and offline synchronization are deferred.
- Default labels are created only on explicit authorized action when the Dataset taxonomy is empty, and normalized-name uniqueness prevents duplicates.

## Scope Boundaries

- **In scope**: public login/registration pages using the existing opaque-cookie authentication flow; shared workspace image engine, bounding boxes, safe image preview, pan/zoom/select, geometry and label edits, deletion, autosave/conflict UX, image description, Dataset labels, Shapes and Images management views, pagination/search/status, authorization, and test coverage.
- **Out of scope**: polygon, circle, point, polyline, rotated boxes, segmentation, keypoints, video/audio/text engines, keyboard shortcut customization, durable undo/redo history, AI-assisted suggestions, annotation review workflow expansion, repository/source-connection work, and any new background import flow.
- **Data and architecture boundaries**: no binary data in PostgreSQL; no storage/provider credentials, JWT, or opaque session credential in browser state; no Redis Job state; no modality-specific workspace routes; no schema or migration change is implied by this specification.
