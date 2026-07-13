# Historical Architecture Baseline

> **Superseded for new work by [the Phase 0 architecture lock](../architecture.md).**
> This document and its ADRs describe the earlier single-process/local-storage
> baseline. Keep them as implementation history; do not use them to authorize
> new storage, Job, worker, or workspace decisions.

# Image Annotation Platform Architecture

## Status

Phase 0 architecture baseline. This document describes the target system and
the constraints that later implementation phases must preserve. Phase 0 adds
documentation only.

## 1. Architecture Overview

The platform is one Next.js 16.2.9 App Router application. It serves the user
interface, same-origin API, server-side Gitea integration, annotation
persistence, and export downloads. PostgreSQL is the system of record for
platform metadata and annotations. Gitea remains the source of truth for source
images and repository metadata.

The first release is a single-operator deployment:

- Gitea credentials come from server-only `GITEA_BASE_URL` and
  `GITEA_ACCESS_TOKEN` environment variables.
- An authenticated reverse proxy supplies the operator identity.
- Gitea tokens and private upstream URLs never enter client bundles or browser
  state.
- Local filesystem storage is used in development through a provider interface
  that can later be implemented for S3 or MinIO.
- Bounding boxes are the only editable annotation geometry in the initial
  release.

### Component boundaries

| Boundary | Responsibility |
| --- | --- |
| Server Components | Load initial database-backed page data and render non-interactive application structure. |
| Client Components | Own forms, keyboard interaction, Zustand state, and the Konva workspace. Keep client boundaries narrow. |
| Server Actions | Handle same-origin, form-oriented mutations such as label CRUD. |
| Route Handlers | Provide browser-facing APIs for Gitea, imports, datasets, images, annotations, and exports. |
| `GiteaClient` | Perform every outbound Gitea REST request from server-only code. |
| Prisma services | Enforce transactional database operations and return domain-safe results. |
| `StorageProvider` | Cache and serve protected files without coupling domain logic to local disk. |
| Export strategies | Convert canonical annotation data to a requested output format. |

Route Handlers that read Gitea or PostgreSQL are dynamic and uncached by
default. A later endpoint may opt into caching only after its authorization,
freshness, and invalidation behavior is explicitly documented.

### Planned interfaces

These are architectural contracts, not Phase 0 code:

```ts
interface GiteaClient {
  listRepositories(input: RepositoryQuery): Promise<RepositorySummary[]>;
  listTree(input: TreeQuery): Promise<TreeEntry[]>;
  getFileMetadata(input: FileQuery): Promise<GiteaFileMetadata>;
  getFileContent(input: FileQuery): Promise<ReadableStream<Uint8Array>>;
}

interface StorageProvider {
  put(input: StorageWrite): Promise<StoredObject>;
  get(key: string): Promise<StoredObjectStream>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  describeDownload(key: string): Promise<DownloadMetadata>;
}

interface ExportStrategy {
  readonly format: ExportFormat;
  validate(input: ExportDataset): ExportValidationResult;
  generate(input: ExportDataset): Promise<ExportArtifact>;
  getContentType(): string;
  getFilename(dataset: DatasetSummary): string;
}
```

Shared DTOs and Zod schemas define request bodies, path/query input,
pagination, successful responses, and normalized errors. Domain services do
not accept raw `Request` objects.

`GiteaConnection.tokenEncrypted` is nullable in the initial schema because v1
uses environment credentials. The token must not be copied into PostgreSQL.
The model remains available for a future encrypted multi-connection feature.

### UI implementation baseline

The local `design-taste-frontend-v1` skill governs future UI work, subject to
the product's performance and dependency constraints:

- Use Geist and Geist Mono for the software interface.
- Use one restrained accent over a consistent neutral palette; avoid neon,
  purple-glow, and pure-black treatments.
- Prefer grid-first responsive layouts and collapse multi-panel views safely
  on narrow screens without horizontal page overflow.
- Use elevation only when it communicates hierarchy; prefer borders and
  spacing in dense workspace surfaces.
- Provide layout-matched loading skeletons plus useful empty and inline error
  states.
- Isolate interactive client leaves and animate only transforms or opacity.
- Do not add icon, animation, or other UI packages without explicit approval.
- Canvas performance rules in this document override decorative motion.

## 2. Final Target Structure

```text
docs/
  architecture/
    README.md
    adrs/

prisma/
  schema.prisma
  seed.ts
  migrations/

src/
  app/
    (app)/
      dashboard/
      datasets/
      workspace/
        [datasetId]/
      labels/
      imports/
      exports/
    api/
      gitea/
      datasets/
      images/
      annotations/
      labels/
      exports/
    layout.tsx
    page.tsx

  components/
    layout/
    workspace/
    labels/
    imports/
    exports/
    ui/

  hooks/
  lib/
    annotation/
    export/
    storage/
    validation/
    auth.ts
    db.ts
    gitea.ts
  stores/
  types/
```

The current root `app/` directory is migrated to `src/app/` in Phase 1.
The two App Router roots must never coexist after that migration.

Server-only modules use `server-only` guards where appropriate. Client
components must not import `src/lib/gitea.ts`, database helpers, storage
implementations, environment readers, or other credential-bearing modules.

## 3. Data Flow

### Repository and dataset import

```text
Browser
  -> authenticated /api/gitea route
  -> trusted proxy identity validation
  -> request validation and authorization
  -> server-only GiteaClient
  -> Gitea REST API
  -> normalized repository and image metadata
  -> Prisma transaction
  -> Repository, Dataset, and ImageAsset records
  -> sanitized API response
  -> dataset interface
```

The import transaction is idempotent for the same connection, repository,
branch, root path, and Gitea SHA. Large trees are paginated or bounded rather
than loaded without limits.

### Protected image delivery

```text
Workspace
  -> same-origin image-content Route Handler
  -> identity, role, and dataset membership checks
  -> local StorageProvider cache lookup
  -> cache hit: protected stream
  -> cache miss: server-only GiteaClient
  -> validate type and size, optionally populate cache
  -> streamed image response
  -> browser image element
  -> Konva canvas
```

The browser receives image bytes from the application's origin. It does not
receive a private Gitea URL or authorization header.

### Annotation mutation

```text
Konva pointer interaction
  -> temporary Konva node/ref state
  -> draw, drag, transform, delete, or property-change boundary
  -> normalized Zustand mutation
  -> validated annotation API request
  -> identity and dataset authorization
  -> Prisma transaction
  -> annotation and image-status update
  -> canonical annotation response
  -> optimistic state reconciliation
```

### Export generation and download

```text
Browser export request
  -> authorization and Zod validation
  -> ExportJob record
  -> canonical dataset query
  -> selected ExportStrategy
  -> private StorageProvider object
  -> completed ExportJob metadata
  -> authorized download Route Handler
  -> streamed JSON or CSV response
```

## 4. Security Model

### Trust boundaries

1. The public edge terminates TLS and strips all incoming identity headers.
2. Only the trusted reverse proxy injects the documented identity headers.
3. Next.js validates identity before serving protected pages or APIs.
4. Server-only modules communicate with Gitea, PostgreSQL, and storage.
5. Browser code receives only authorized, sanitized data.

Production deployment behind an authenticated gateway, or on an equivalently
restricted private network with that gateway, is mandatory. Direct public
access to the Next.js origin is unsupported.

### Authentication and authorization

- Reject missing, malformed, or untrusted proxy identity.
- Map the normalized proxy subject and email to a `User` record.
- Apply role checks to administrative operations.
- Authorize datasets, images, annotations, labels, and exports by scope.
- Resolve ownership and access server-side; never trust client-supplied user
  or owner identifiers.
- Apply the same authorization rules to Server Actions and Route Handlers.

### Secret handling

- Keep Gitea credentials in non-public server environment variables.
- Never place credentials in Zustand, local storage, serialized props, URLs,
  response payloads, or client-readable error details.
- Never log authorization headers, tokens, environment values, or private
  Gitea base URLs.
- Redact sensitive fields and upstream addresses from structured logs.
- Do not persist the v1 environment token in `GiteaConnection`.

### Input and upstream controls

- Validate path parameters, queries, and bodies with Zod before domain logic.
- Normalize repository paths, reject absolute paths and traversal segments,
  and verify the result remains under the selected repository root.
- Allow only configured image MIME types and extensions.
- Enforce upstream timeouts, response-size ceilings, pagination bounds,
  import-count limits, and controlled concurrency.
- Do not forward arbitrary browser headers to Gitea.
- Map upstream failures to normalized errors without exposing upstream bodies.
- Protect mutations against cross-site requests using same-origin checks and
  the deployment's secure cookie/header policy.

### Files and exports

- Keep cached images and generated exports outside `public/`.
- Derive storage keys server-side; never use untrusted paths as filesystem
  paths.
- Serve files only through authorized Route Handlers.
- Set explicit content types and safe download filenames.
- Prevent content sniffing and unsafe inline rendering where a download is
  intended.
- Apply retention and cleanup policies to cached files and completed exports.

### Normalized API errors

Errors have a stable, non-sensitive shape:

```json
{
  "error": {
    "code": "ANNOTATION_INVALID",
    "message": "The annotation could not be saved.",
    "fieldErrors": {},
    "requestId": "generated-correlation-id"
  }
}
```

The public message is actionable but does not reveal tokens, SQL details,
filesystem paths, private URLs, or raw upstream responses.

## 5. Canvas Performance Model

### Coordinate ownership

- Persist annotation geometry in original image coordinates.
- Keep viewport scale and translation separate from annotation coordinates.
- Convert pointer positions through one tested coordinate-transform utility.
- Normalize negative width and height at commit time.
- Clamp committed boxes to image bounds and reject boxes below the configured
  minimum size.

### Interaction lifecycle

```text
pointer down
  -> initialize lightweight draft/ref
pointer move
  -> update Konva node or ref only
pointer up / drag end / transform end
  -> normalize and validate geometry
  -> commit one Zustand action
  -> persist one mutation
```

React state and API calls are prohibited inside unthrottled pointer-move or
drag loops. Persistence occurs only at semantic action boundaries:

- drawing completion
- `onDragEnd`
- `onTransformEnd`
- deletion
- label or metadata change
- explicit status change

### Rendering and state

- Store annotations in a normalized map keyed by annotation ID.
- Subscribe components through narrow Zustand selectors.
- Keep active tool, selected annotation, and viewport state separate from
  persisted domain data.
- Cache decoded image objects and avoid recreating Konva shapes, transformer
  instances, and handlers unnecessarily.
- Keep transformer attachment imperative and scoped to the selected node.
- Use `requestAnimationFrame` only for viewport work that must update once per
  frame, not as a substitute for state discipline.
- Record undo/redo as bounded semantic operations, not pointer snapshots.
- Cancel or reconcile stale save requests when the active image changes.

### Scaling thresholds

The initial implementation optimizes normal datasets and bounding-box counts.
Measure frame time and node count before adding complexity. If real workloads
exceed the target, evaluate viewport culling, layer partitioning, simplified
non-selected shapes, and batched persistence in that order.

Decorative UI motion must not compete with the annotation canvas. Continuous
animations are disabled or isolated while the workspace is actively editing.

## 6. Phase-by-Phase Execution Checklist

Each phase starts with files to create/modify, risks, and required dependency
approval. Each phase ends with verification results and waits for approval.

- [x] **Phase 0 — Architecture:** Overview, ADRs, folder structure, data flows,
  security model, canvas performance model, and execution checklist.
- [ ] **Phase 1 — Project foundation:** Obtain dependency approval; migrate to
  `src/app`, configure aliases and customized shadcn primitives, and build the
  app shell, dashboard, and responsive workspace skeleton using the local UI
  skill.
- [ ] **Phase 2 — Database foundation:** Add Prisma/PostgreSQL models, enums,
  migrations, seed labels, and a development-safe database singleton.
- [ ] **Phase 3 — Label CRUD:** Add validated Server Actions, role checks,
  forms, list states, and referential-delete safeguards.
- [ ] **Phase 4 — Secure Gitea integration:** Enforce proxy identity; add the
  server-only Gitea client and repository, tree, and import handlers with
  sanitization and upstream limits.
- [ ] **Phase 5 — Dataset import and sidebar:** Add transactional imports,
  image metadata, search, status filters, progress badges, and empty/error
  states.
- [ ] **Phase 6 — Canvas foundation:** Add the storage abstraction, protected
  image delivery, image loading, fit, zoom, pan, and toolbar.
- [ ] **Phase 7 — Bounding boxes:** Add drawing, selection, movement, resize,
  deletion, label assignment, keyboard shortcuts, and semantic history.
- [ ] **Phase 8 — Annotation persistence:** Add annotation APIs, optimistic
  reconciliation, conflict handling, save states, and image-status updates.
- [ ] **Phase 9 — Exports:** Add JSON/CSV strategies, export jobs, private
  artifacts, and authorized downloads.
- [ ] **Phase 10 — Review workflow:** Add annotation/image status transitions,
  verification, rejection, validation rules, and audit metadata.
- [ ] **Phase 11 — Production hardening:** Add comprehensive states and tests,
  observability, deployment documentation, Docker assets, retention policies,
  and production security checks.

## 7. Phase 0 Acceptance Record

- All requested architecture topics are documented here.
- The ADR index and ten decisions live in `docs/architecture/adrs/`.
- The target structure prohibits simultaneous root and `src` App Router roots.
- Gitea and credential-bearing modules are defined as server-only.
- Proxy trust, authorization, path traversal, logging, file, and export risks
  are addressed.
- React state and network requests are explicitly prohibited in drag loops.
- Phase approval gates are retained.
- `AGENTS.md` and `CLAUDE.md` are unchanged.
- No application code, dependencies, schema, or configuration changed.

## 8. Assumptions

- V1 has one operator and one environment-configured Gitea connection.
- Authentication is provided by a trusted reverse-proxy SSO layer.
- App-owned login and encrypted multi-user Gitea connections are future work.
- Local storage is the development provider; S3/MinIO compatibility is a
  provider implementation concern.
- Bounding boxes are the only editable v1 annotation geometry.
- Package installation requires explicit approval in the relevant phase.

See [Architecture Decision Records](./adrs/README.md) for the decisions behind
this design.
