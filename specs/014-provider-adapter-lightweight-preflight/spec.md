# Feature Specification: Provider Adapter + Lightweight Preflight

**Feature Branch**: `014-provider-adapter-lightweight-preflight`  
**Created**: 2026-07-23  
**Status**: Draft  
**Input**: User description: "Phase 014 — Provider Adapter + Lightweight Preflight"

## Purpose and Scope

This phase lets an authorized user confirm that a selected repository can be
used before creating any Dataset or durable Job. It is a lightweight
accessibility check, not an import, clone, synchronization, or artifact
production flow.

The phase introduces a common provider-adapter contract and two adapter
implementations: GitHub and Gitea. It exposes one authenticated preflight
operation for a repository, optional ref, and optional root path.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Preflight an accessible repository (Priority: P1)

An authorized user selects a supported repository and optionally identifies a
ref and root path. Before starting later import work, the user receives a safe
answer telling them whether the repository is reachable and the requested
location exists.

**Why this priority**: It prevents users from creating a Dataset or background
Job for a repository they cannot access or a path that does not exist.

**Independent Test**: With a valid authorized repository source, submit a
preflight request and verify the returned safe result confirms repository,
ref, and optional root-path accessibility without creating any durable work.

**Acceptance Scenarios**:

1. **Given** an authenticated user and an accessible supported repository,
   **When** they submit a repository preflight, **Then** the result confirms
   the repository is accessible and returns only safe repository/ref details.
2. **Given** an accessible repository and a valid ref, **When** the user
   includes that ref, **Then** the result confirms the ref exists.
3. **Given** an accessible repository/ref and an existing root path, **When**
   the user includes that root path, **Then** the result confirms the path
   exists without returning a full repository manifest.
4. **Given** the request succeeds, **When** the operation completes, **Then**
   no Dataset, Job, JobEvent, storage object, or persisted full manifest has
   been created.

---

### User Story 2 - Receive safe failures before durable work (Priority: P1)

An authenticated user receives a stable, non-secret failure when the
repository, credentials, ref, root path, provider, or repository address is
invalid.

**Why this priority**: Clear early failures prevent unsafe provider access and
avoid creating durable work that is known to fail.

**Independent Test**: Submit each invalid preflight condition through the
authenticated HTTP boundary and confirm its stable failure code and zero
Dataset/Job/queue/storage side effects.

**Acceptance Scenarios**:

1. **Given** a malformed, unsafe, or unsupported repository request, **When**
   it is submitted, **Then** it is rejected before provider access and no
   durable state changes.
2. **Given** an inaccessible private repository or invalid/expired credential,
   **When** preflight is submitted, **Then** the user receives the applicable
   safe access/token failure without token or provider diagnostics.
3. **Given** a valid repository but missing ref or root path, **When**
   preflight is submitted, **Then** the user receives `REF_NOT_FOUND` or
   `ROOT_PATH_NOT_FOUND` and no durable state changes.
4. **Given** a user supplies another user's connection identifier, **When**
   preflight is submitted, **Then** the request follows concealed-resource
   policy and makes no provider call.

---

### User Story 3 - Use one provider-neutral preflight contract (Priority: P2)

Product capabilities can request lightweight repository checks through one
consistent provider-neutral contract while preserving each provider's safe
error mapping and authorization rules.

**Why this priority**: Later repository import work can add providers without
duplicating authorization, SSRF, token, ref, and root-path semantics.

**Independent Test**: Exercise GitHub public-repository preflight and Gitea
repository preflight through the same request/result contract; each produces
the same category of safe result or stable failure code.

**Acceptance Scenarios**:

1. **Given** a supported provider and a valid public repository request,
   **When** preflight is submitted without credentials where the provider
   permits public access, **Then** the provider is checked anonymously and a
   safe result is returned.
2. **Given** a provider requires credentialed access, **When** a current user
   has an eligible existing source connection, **Then** the server resolves it
   itself and validates access without returning the credential.
3. **Given** a private GitHub request without an eligible pre-existing
   credentialed connection, **When** it is submitted in this phase, **Then**
   it returns `REPOSITORY_ACCESS_DENIED`; the request does not accept a
   browser-supplied token or modify a SourceConnection.

### Edge Cases

- A repository URL has an unsupported scheme, embedded credentials, query,
  fragment, private/numeric prohibited destination, or a DNS answer containing
  a prohibited address: return `UNSAFE_REPOSITORY_URL` before provider contact.
- A provider redirects a request to an unsafe/out-of-policy destination: fail
  closed with `UNSAFE_REPOSITORY_URL` and do not follow the redirect.
- An omitted ref uses the provider's safe default-ref resolution. A supplied
  ref is never silently substituted with another ref.
- An omitted root path means repository-root accessibility only; an explicit
  root path must be normalized and validated under the existing source-path
  policy.
- A provider response changes while preflight is in progress: return a safe
  retryable failure rather than persisting partial state.
- A preflight response may include a bounded safe sample/count sufficient to
  establish root existence, but never a full file manifest, provider response,
  private URL, credential, or token-derived data.
- Repeated identical preflight requests may repeat read-only provider checks;
  they must not create duplicate durable state because this phase creates no
  durable state at all.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide one authenticated repository preflight
  operation that accepts a supported provider, repository identity, optional
  ref, optional root path, and an optional existing source-connection
  reference.
- **FR-002**: The system MUST resolve the current opaque-session actor before
  inspecting a source connection or contacting a provider; it MUST derive
  connection ownership and eligibility server-side.
- **FR-003**: The system MUST validate every preflight request strictly and
  reject unknown fields, browser policy overrides, browser-supplied provider
  tokens, provider URLs with embedded credentials, and storage/queue fields.
- **FR-004**: The system MUST use a provider-neutral adapter contract with the
  following required capabilities:

  ```ts
  interface RepositoryProviderAdapter {
    preflight(input: PreflightInput): Promise<PreflightResult>;
    resolveRef(input: ResolveRefInput): Promise<ResolvedRef>;
    listFiles(input: ListFilesInput): Promise<SourceFileManifest[]>;
    downloadFile(input: DownloadFileInput): Promise<ReadableStream>;
    validateToken?(input: ValidateTokenInput): Promise<TokenValidationResult>;
  }
  ```

  In this phase, only `preflight`, `resolveRef`, a bounded root-existence use
  of `listFiles`, and optional `validateToken` are invoked. `downloadFile` is
  defined for future provider processing and MUST NOT be invoked.
- **FR-005**: The system MUST support GitHub and Gitea adapter selection. A
  public repository may be checked anonymously only where the selected
  provider allows it. Credentialed access must use an existing eligible
  server-resolved SourceConnection; this phase MUST NOT accept or persist a
  new browser-supplied token.
- **FR-006**: The system MUST validate the repository URL and every redirect
  hop with the existing SSRF/DNS policy before provider access. Unsafe input
  MUST return `UNSAFE_REPOSITORY_URL`.
- **FR-007**: The system MUST confirm repository existence/access, supplied
  ref existence, and supplied root-path existence before returning success.
- **FR-008**: The system MUST expose only these stable preflight failure codes
  for the corresponding conditions: `REPOSITORY_NOT_FOUND`,
  `REPOSITORY_ACCESS_DENIED`, `SOURCE_TOKEN_EXPIRED`,
  `SOURCE_TOKEN_INVALID`, `REF_NOT_FOUND`, `ROOT_PATH_NOT_FOUND`,
  `UNSAFE_REPOSITORY_URL`, and `UNSUPPORTED_PROVIDER`.
- **FR-009**: The system MUST map provider-specific failures to the stable
  codes without exposing tokens, source URLs, account details, raw provider
  responses, stack traces, or server configuration.
- **FR-010**: A successful or failed preflight MUST NOT create or update a
  Dataset, Job, JobEvent, SourceConnection, Asset, MinIO object, Redis/BullMQ
  delivery, full manifest, or any other durable import state.
- **FR-011**: The system MUST not clone a repository, download source content,
  upload to MinIO, or persist a full manifest during this phase.
- **FR-012**: The system MUST limit root-path existence checks to a bounded,
  provider-supported metadata/listing operation governed by the existing
  configured source limits; it MUST not enumerate an unbounded repository
  tree.
- **FR-013**: The preflight response MUST contain only a safe provider,
  repository identity, resolved ref, normalized root-path outcome, and safe
  accessibility state. It MUST not contain connection internals, queue
  information, full manifest contents, or provider diagnostic payloads.
- **FR-014**: The implementation MUST keep the provider adapters in the
  approved provider boundary, with common types/errors/registry and separate
  GitHub and Gitea client/mapper modules. Request validation and the
  browser-facing preflight route remain separate from provider clients.
- **FR-015**: This phase MUST add only the dedicated preflight operation. It
  MUST NOT invoke a legacy repository-import persistence path, alter existing
  SourceConnection lifecycle behavior, or imply that GitHub credentials can
  be stored before an explicitly approved GitHub SourceConnection lifecycle
  exists.

### Required Delivery Structure

The Phase 014 implementation must use the following logical structure:

```text
apps/web/src/lib/providers/
├── provider.types.ts
├── provider.errors.ts
├── provider-registry.ts
├── preflight-repository.ts
├── token-check.ts
├── github/
│   ├── github.provider.ts
│   ├── github.client.ts
│   └── github.mapper.ts
└── gitea/
    ├── gitea.provider.ts
    ├── gitea.client.ts
    └── gitea.mapper.ts

apps/web/src/lib/validation/
└── repository-preflight.ts

apps/web/src/app/api/source-repositories/preflight/
└── route.ts
```

### Key Entities

- **Preflight Request**: A transient, authenticated request containing only a
  provider selection, safe repository identity, optional ref/root selector,
  and optional existing connection reference.
- **Preflight Result**: A transient safe confirmation of repository, ref, and
  root-path accessibility; it is not an import plan or a persisted manifest.
- **Repository Provider Adapter**: A provider-specific translator that applies
  the common preflight contract without exposing provider credential or error
  details.
- **Resolved Ref**: The safe immutable ref identity returned after a supplied
  or default ref is checked.
- **Source File Manifest Entry**: A transient normalized file descriptor used
  only for bounded root existence checks in this phase; it is not persisted.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In controlled provider tests, 100% of accessible GitHub/Gitea
  repository requests return a safe accessibility result without creating a
  Dataset, Job, queue delivery, storage object, or persisted full manifest.
- **SC-002**: In the preflight failure matrix, 100% of unsupported provider,
  unsafe address, inaccessible repository, invalid/expired token, missing ref,
  and missing root-path cases return their specified stable code with zero
  durable side effects.
- **SC-003**: In ownership tests, 100% of foreign source-connection attempts
  are concealed and make no provider request.
- **SC-004**: In response and log audits, 100% of tested preflight outcomes
  exclude tokens, encrypted fields, private URLs, provider bodies, stack
  traces, and server configuration.
- **SC-005**: In controlled local runs, at least 95% of successful preflight
  checks complete within 10 seconds without downloading repository files or
  creating import artifacts.

## Assumptions

- Phase 013's opaque PostgreSQL-backed session, ownership guard, encryption,
  SSRF/root-path policy, and safe error conventions remain authoritative.
- GitHub and Gitea support public anonymous checks where their APIs permit it.
  Private GitHub access remains denied until a separately approved
  credentialed GitHub SourceConnection lifecycle is available; this phase does
  not extend SourceConnection CRUD or schema.
- Existing active Gitea SourceConnections are eligible for authorized
  credentialed preflight and are only read/decrypted transiently server-side.
- Existing repository-import endpoints remain outside this phase; they are not
  a fallback for preflight and must not be called to obtain a preflight result.
- The default ref is resolved only when omitted by the caller; the returned
  resolved ref is safe metadata, not a clone instruction.
- No schema migration, new dependency, raw SQL, Dataset/Job creation, queue
  transport, storage write, provider clone, or full-manifest persistence is
  authorized by this specification.
