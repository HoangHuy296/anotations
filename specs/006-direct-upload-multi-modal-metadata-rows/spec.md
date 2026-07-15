# Feature Specification: Direct Upload and Multi-modal Metadata Rows

**Feature Branch**: `006-direct-upload-multi-modal-metadata-rows`  
**Created**: 2026-07-14  
**Status**: Draft  
**Input**: Upload an Asset to an existing Dataset, keep binary content private, and create the matching image, video, text, or audio metadata row.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Upload a file into an authorized dataset (Priority: P1)

As an authorized dataset contributor, I need to upload a supported file to an existing dataset so that it becomes available for subsequent annotation work without exposing storage credentials.

**Why this priority**: Upload is the entry point for user-provided assets and must preserve the Dataset security boundary.

**Independent Test**: An authorized contributor requests an upload capability, transfers one supported file, completes the upload, and sees exactly one new asset in that Dataset's metadata list. A non-member using the known Dataset identifier receives no protected metadata and creates no binary or metadata record.

**Acceptance Scenarios**:

1. **Given** an authorized Dataset owner or manager and a supported file, **When** they request an upload capability at `POST /api/assets/presigned-upload`, **Then** the system validates their Dataset permission and returns only a short-lived, file-specific upload capability and safe completion reference.
2. **Given** a valid upload capability, **When** the user transfers the file and calls `POST /api/assets/complete-upload`, **Then** the system confirms that the expected object exists before publishing an Asset record.
3. **Given** a Dataset member with asset-upload permission, **When** upload completion succeeds, **Then** the new Asset appears in that Dataset's existing asset list and no ownership or storage credential is included in the response.
4. **Given** a non-member or a user without upload permission, **When** they request or complete an upload for another Dataset, **Then** the Dataset is not disclosed and no object or metadata row is created by the denied request.

---

### User Story 2 - Classify uploaded media correctly (Priority: P1)

As a dataset contributor, I need each uploaded file to be identified as image, video, text, or audio so that the correct workspace engine and metadata view can be selected later.

**Why this priority**: `Asset.modality` is the locked source of truth for workspace selection; an incorrect modality would route later work to the wrong engine.

**Independent Test**: Complete one supported upload for each of image, video, text, and audio; verify that each is classified from verified file information rather than a browser claim.

**Acceptance Scenarios**:

1. **Given** a file whose declared content type conflicts with its verified type, **When** completion runs, **Then** the system rejects it or uses the verified supported type according to the configured acceptance policy; it never silently trusts the browser declaration.
2. **Given** a supported image, video, text, or audio object, **When** completion succeeds, **Then** the Asset records the corresponding required modality and safe metadata such as filename, verified MIME type, and size.
3. **Given** an unsupported, corrupt, empty, or ambiguous object, **When** completion runs, **Then** no usable Asset is published and the user receives a safe failure result.

---

### User Story 3 - Receive modality-specific metadata (Priority: P2)

As an authorized dataset member, I need the appropriate modality-specific metadata record to exist for a completed Asset so that future image, video, text, and audio workflows have a consistent foundation.

**Why this priority**: The child rows establish a durable, one-to-one multimodal shape without prematurely implementing processing or workspace features.

**Independent Test**: For each completed supported modality, retrieve the Asset through an authorized metadata path and verify exactly one matching child row exists, with no child rows of another modality.

**Acceptance Scenarios**:

1. **Given** a verified image Asset, **When** it is published, **Then** exactly one ImageAsset metadata row is created.
2. **Given** a verified video Asset, **When** it is published, **Then** exactly one VideoAsset metadata row is created.
3. **Given** a verified text Asset, **When** it is published, **Then** exactly one TextDocument metadata row is created without persisting the uploaded binary or full text body as database content in this phase.
4. **Given** a verified audio Asset, **When** it is published, **Then** exactly one AudioAsset metadata row is created.

### Edge Cases

- An upload capability expires, is replayed, is used with a different object, or is completed twice.
- An object is missing, has a mismatched size or verified type, is zero bytes, or becomes unavailable between transfer and completion.
- An upload request or completion races with Dataset archival, membership removal, or a permission change.
- A retry follows an uncertain client timeout after the object transfer or after metadata publication.
- A filename has unusual Unicode, path separators, duplicate names, or an untrusted extension.
- Metadata inspection cannot determine optional dimensions, duration, codec, language, sample rate, or channel count.
- An uploaded text file is very large or is not valid text for the claimed encoding.
- A failure leaves an unreferenced private object; it must not become visible as an Asset or leak its location.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide the requested upload-capability, upload-completion, and authorized Asset view paths: `POST /api/assets/presigned-upload`, `POST /api/assets/complete-upload`, and `GET /api/assets/[assetId]/view-url`.
- **FR-002**: Every upload request, completion, and view request MUST resolve the authenticated actor on the server and enforce the existing effective permission rule: system ADMIN override; otherwise Dataset ownership or membership with the required Dataset permission. A system-wide MANAGER role alone MUST NOT grant access to another Dataset.
- **FR-003**: The system MUST require asset-upload permission for an existing, active Dataset before issuing an upload capability, and MUST repeat authorization before publishing metadata at completion.
- **FR-004**: The upload capability MUST be short-lived, scoped to one authorized request, and limited to one server-chosen private object identity, expected size range, and supported content type. It MUST NOT reveal storage credentials, bucket credentials, server configuration, provider tokens, or reusable broad storage access.
- **FR-005**: The system MUST treat browser-supplied filenames, MIME types, modality, object locations, and checksum claims as untrusted input. It MUST verify the object exists and derive accepted MIME type and modality from server-side inspection before publishing an Asset.
- **FR-006**: The system MUST support the configured subset of image, video, text, and audio file types. Unsupported, ambiguous, corrupt, empty, oversized, expired, or mismatched uploads MUST fail safely and MUST NOT create a usable Asset or child metadata row.
- **FR-007**: On successful completion, the system MUST store binary bytes only in private object storage and persist only safe object references and metadata in PostgreSQL. It MUST NOT persist uploaded binary content in PostgreSQL; in particular, this phase leaves `TextDocument.content` unset.
- **FR-008**: The system MUST create one Asset with `sourceMode` for direct upload, a server-derived `uploadedBy` identity, a required `Asset.modality`, verified MIME type, verified size, server-derived source fingerprint, and private object reference metadata.
- **FR-009**: Successful Asset creation MUST create exactly one matching modality-specific child metadata row: ImageAsset for IMAGE, VideoAsset for VIDEO, TextDocument for TEXT, or AudioAsset for AUDIO. It MUST NOT create child rows for other modalities.
- **FR-010**: The metadata-extraction scaffold MUST populate only data it can safely verify. Optional fields that cannot yet be reliably extracted remain empty; it MUST NOT fabricate values, create thumbnails, transcode media, extract frames/waveforms, or enqueue long-running work in this phase.
- **FR-011**: Completion and retry behavior MUST be idempotent. Replaying the same valid completion request or recovering after a client timeout MUST return or reconcile the same Asset and child row, and MUST NOT create duplicate Asset records, child rows, or private binary objects.
- **FR-012**: If verification or metadata publication fails, the system MUST not expose a partially published Asset. Any private orphan-object cleanup or retention action MUST remain server-side and must not disclose private object identities to the browser.
- **FR-013**: `GET /api/assets/[assetId]/view-url` MUST require authorized access to the Asset's Dataset and return only a short-lived, asset-scoped viewing capability. The signed URL is the sole controlled exception that may encode an object location; the response MUST NOT additionally disclose a reusable storage credential, object key, source URL, or metadata from another Dataset.
- **FR-014**: Browser-facing success and failure responses, logs, object metadata, and queue payloads MUST omit storage credentials, provider tokens, encrypted values, database credentials, private repository URLs, and private object keys.
- **FR-015**: This phase MUST use the finalized Asset and modality-child schema as its source of truth. Any needed schema, migration, dependency, CORS policy, object lifecycle policy, or Architecture Lock exception requires explicit approval before implementation.
- **FR-016**: Direct browser access to a private provider remains forbidden except for a backend-generated, short-lived, object-scoped presigned upload or view URL. This controlled capability exception is not a provider credential, cannot list or broaden object access, and must be documented in the Architecture Lock before implementation.
- **FR-017**: This feature is Phase 5 in the delivery sequence and feature directory `006`, because the project numbering begins at `001`.

### Key Entities

- **Upload capability**: A short-lived, single-purpose authorization to transfer or view one private object; it contains no reusable service credential.
- **Upload completion request**: The authenticated confirmation that asks the system to verify an expected uploaded object and publish its metadata exactly once.
- **Asset**: The central Dataset-scoped metadata record. Its modality selects the future workspace engine and its binary remains private object storage content.
- **ImageAsset / VideoAsset / TextDocument / AudioAsset**: One-to-one modality-specific metadata records created only for the verified Asset modality.
- **Verified object metadata**: Server-observed object existence, safe MIME classification, size, checksum/fingerprint, and optionally extractable media attributes; never a binary database payload.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In acceptance testing, 100% of one valid image, video, text, and audio upload each result in exactly one visible Asset in the intended authorized Dataset and exactly one matching child metadata row.
- **SC-002**: 100% of tested non-member, permission-denied, expired, replayed, mismatched, and unsupported upload attempts disclose no protected Dataset or object metadata and publish no Asset or child row.
- **SC-003**: 100% of tested successful uploads leave binary bytes outside PostgreSQL, while the resulting Asset stores only safe metadata and private storage reference information.
- **SC-004**: 100% of tested repeated completion requests for the same upload resolve to the same Asset and matching child row, with no duplicate published asset or binary object.
- **SC-005**: In acceptance testing, users can see a completed Asset in the Dataset asset list within 10 seconds of a successful completion request under normal local service conditions.
- **SC-006**: 100% of tested asset-view requests by an authorized member return an asset-scoped short-lived viewing capability, while non-members receive no protected content capability.

## Assumptions

- Phase 004 authentication/ownership guards and Phase 005 Dataset/Asset metadata authorization are complete and remain the only public authorization boundary.
- The finalized schema already contains Asset, ImageAsset, VideoAsset, TextDocument, and AudioAsset; this specification does not authorize changing that schema.
- The initially accepted type set will be conservative and explicitly documented during planning; browser filename extensions alone never determine acceptance or modality.
- Metadata extraction is synchronous and bounded to safe inspection. Transcoding, thumbnails, previews, frame extraction, waveforms, OCR, and content indexing are deferred.
- Upload failure may leave a private unreferenced object only if it is isolated from browser discovery and handled by a separately approved server-side retention/cleanup policy.
- No Job, BullMQ payload, Redis state, worker processing, repository sync, annotation workspace route, or modality-specific workspace route is introduced by this phase.

## Presigned POST Security Model

The presigned POST policy is a short-lived upload capability for one backend-generated object key. It binds the exact object key, exact validated content type, and a one-byte-to-configured-maximum content-length range before MinIO accepts any object bytes.

The application does not trust the uploaded object until `complete-upload`.

At `complete-upload`, the backend must verify:
- object exists
- object size is within limit
- object MIME/modality is allowed
- object belongs to the expected dataset prefix
- current user can upload to the dataset

If verification fails, the backend rejects the upload and calls safe cleanup.
