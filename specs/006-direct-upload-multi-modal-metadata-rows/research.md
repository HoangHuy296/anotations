# Research: Direct Upload and Multi-modal Metadata Rows

## Decision 1: Controlled direct-transfer exception

**Decision**: Browser access to MinIO remains prohibited except for a server-issued, short-lived, object-scoped presigned URL for one upload or one view. The browser never receives MinIO access keys, secret keys, bucket-management capability, list capability, or a reusable provider token.

**Rationale**: This preserves the Architecture Lock's server-side credential boundary while allowing large binary bytes to bypass the application process. The URL is an intentionally constrained capability, generated only after the public API has authenticated and authorized the active Dataset actor.

**Alternatives considered**:

- Proxy every byte through a Next.js route: preserves the original absolute prohibition but removes the requested direct-upload flow and creates an unnecessary application data path.
- Browser-held MinIO credentials: rejected because the credentials could be reused, leaked, or expanded beyond one object.
- Public bucket/object URLs: rejected because they bypass Dataset authorization and private binary storage.

## Decision 2: Feature and phase numbering

**Decision**: This is delivery Phase 5 and feature directory `006-direct-upload-multi-modal-metadata-rows`.

**Rationale**: The project starts numbering at `001`; feature 006 is therefore the sixth numbered feature while representing the fifth product phase after the Phase 0 architecture lock.

**Alternatives considered**:

- Renumber existing feature directories: rejected because it would rewrite approved history and create unnecessary traceability risk.

## Decision 3: Public versus internal object-storage endpoints

**Decision**: Keep a server-only internal MinIO endpoint for server verification and presigning, and introduce a separately configured browser-reachable endpoint used only when constructing signed URLs. The browser receives only the returned capability URL.

**Rationale**: A Compose DNS name such as `minio` is reachable to application containers but not to a user's browser. Separating the endpoints prevents accidental exposure of internal topology and allows browser CORS policy to be limited to the application origin.

**Alternatives considered**:

- Reuse the internal endpoint in signed URLs: rejected because browser clients cannot resolve container-only hostnames.
- Expose the MinIO console or credentials to make uploads work: rejected by the security boundary.
- Add a public proxy service: rejected because it duplicates the public Next.js API boundary.

## Decision 4: Upload intent and idempotency without a new schema

**Decision**: The presign response carries a server-signed, opaque completion capability containing the authorized actor, Dataset, deterministic private object key, expiry, expected bounded upload attributes, and a random upload nonce. Completion validates this capability and resolves an existing Asset by its unique private object reference before attempting a transaction.

**Rationale**: The finalized schema already enforces unique object references and child rows are one-to-one. Reusing one deterministic key for retries prevents duplicate objects, and checking the existing Asset makes lost responses/replayed completion idempotent without adding an upload-intent table in this phase.

**Alternatives considered**:

- A new UploadIntent table: deferred; it is not required for the initial bounded flow and would require a migration.
- Client-provided storage keys: rejected because a client could overwrite or reference another Dataset's private object.
- Timestamp-only object keys: rejected because retries would create a new object and break idempotency.

## Decision 5: Verification and modality detection

**Decision**: Completion performs bounded server-side object inspection. It compares object existence and size with the authorized capability, derives MIME/modality from a conservative signature and text-validity detector, and rejects unsupported or mismatched input. Browser-declared type and filename extension are hints only.

**Rationale**: Object metadata supplied during upload is not trustworthy. A bounded detector avoids reading an entire large media file while establishing the required `Asset.modality` source of truth.

**Initial supported set**:

| Modality | Accepted verified forms |
| --- | --- |
| IMAGE | PNG, JPEG, WebP |
| VIDEO | MP4, WebM |
| TEXT | UTF-8 plain text, CSV, JSON text |
| AUDIO | WAV, MP3, Ogg |

**Alternatives considered**:

- Trust request `Content-Type`: rejected because it is browser-controlled.
- Add a general file-sniffing package now: deferred because no dependency has been approved; a small, reviewed detector covers the initial set.
- Parse/transcode all media in the request: rejected because long-running processing belongs to later worker/Job work.

## Decision 6: Metadata child rows and publication state

**Decision**: After verification, create Asset and its one matching child row in one Prisma transaction. Store verified common attributes on Asset; initialize only safely known optional child fields. Set successful directly uploaded Assets to `READY`; no derived binary output is created.

**Rationale**: A transaction prevents a visible Asset with a missing child row. `READY` communicates that the binary and essential metadata are available even though later processing such as thumbnails, frames, waveform, OCR, and transcription has not happened.

**Alternatives considered**:

- Create common and child records separately: rejected because a failure could publish an incomplete asset.
- Store text bytes in `TextDocument.content`: rejected because this phase's binary-in-private-storage rule applies to uploaded text as well.
- Queue metadata extraction: deferred because the requested scaffold must not introduce a Job/worker flow early.

## Decision 7: CORS and private object lifecycle

**Decision**: MinIO CORS permits only the configured browser application origin and required `POST`/`GET` methods. Uploads use a signed POST policy binding the exact key, exact validated content type, bounded content-length range, and expiry. The bucket remains private. Server-side failure handling attempts best-effort deletion of an unreferenced object after every verification or publication failure; no cleanup identifier is disclosed to the browser.

**Rationale**: Presigned URLs authorize an individual object but browser CORS is still required for direct transfer. A restrictive policy avoids broad cross-origin use, and server-side cleanup preserves private-object hygiene.

**Alternatives considered**:

- Wildcard CORS in all environments: rejected because it unnecessarily broadens browser origins.
- Expose a cleanup endpoint to users: rejected because it would reveal private object identities and bypass server authorization.
