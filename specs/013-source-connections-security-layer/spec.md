# Feature Specification: Source Connections Security Layer

**Feature Branch**: `013-source-connections-security-layer`

**Created**: 2026-07-22

**Status**: Draft

**Input**: User description: "Phase 013 — Source Connections + Security Layer"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect a private source safely (Priority: P1)

An authenticated user can save a connection to a private source repository so
that a later authorized import can use it without asking the user to re-enter a
token. The user supplies a supported repository address and a valid token; a
later source-backed operation supplies its separately validated root path. The
application validates the connection without ever returning or displaying the
token.

**Why this priority**: Private repositories cannot participate in the product
without a secure, durable connection owned by the user.

**Independent Test**: An authenticated owner saves a valid private-source
connection, sees a safe connection summary, and can use its identifier in an
authorized source operation while neither browser responses nor durable Job
input contains the submitted token.

**Acceptance Scenarios**:

1. **Given** an authenticated user with a supported, safe private repository
   address and valid token, **When** the user creates a source connection,
   **Then** the connection is saved for that user, validation succeeds, and
   every browser response contains only a safe connection summary.
2. **Given** a source connection owned by the current user, **When** the user
   lists connections, **Then** the user sees only safe metadata for their own
   connections and never sees any token or encrypted-token value.
3. **Given** a token that is expired or rejected by its provider, **When** the
   user validates or later uses the connection, **Then** the operation fails
   with the stable `SOURCE_TOKEN_EXPIRED` outcome and no secret is disclosed.

---

### User Story 2 - Enforce ownership and safe repository boundaries (Priority: P1)

An authenticated user can use only a source connection they own (except where
the established system-administrator policy explicitly permits oversight). The
application and private processing boundary reject unsafe repository locations
and unsafe root paths before attempting access.

**Why this priority**: A connection token is a high-value credential; source
selection must not become an IDOR or SSRF path.

**Independent Test**: A non-owner attempts to read, delete, validate, or use a
known connection identifier and receives the established concealed-resource
denial, while database state and external access attempts remain unchanged.

**Acceptance Scenarios**:

1. **Given** a connection owned by another user, **When** a non-owner provides
   its identifier to a source-related operation, **Then** access is denied
   without confirming that the connection exists or exposing its metadata.
2. **Given** a repository address that targets a loopback, link-local, private,
   multicast, unspecified, or otherwise non-public network destination,
   **When** a user submits it, **Then** it is rejected before any outbound
   request is made.
3. **Given** a root path containing an absolute path, traversal segment, empty
   normalized segment, or platform-specific escape sequence, **When** a user
   submits it, **Then** it is rejected before a repository is accessed.
4. **Given** a repository address that passed initial validation, **When** a
   private worker is about to access it, **Then** the worker independently
   applies the same repository and root-path safety policy.

---

### User Story 3 - Manage the connection lifecycle without secret leakage (Priority: P2)

An owner can view safe connection status and remove a connection that is no
longer needed. Removal prevents all future use of that connection while
preserving the auditability and consistency of already terminal work.

**Why this priority**: Users need to revoke access promptly and understand
whether a connection is usable without exposing confidential details.

**Independent Test**: An owner deletes a connection and later source requests
with that identifier are rejected; a non-owner cannot cause deletion or observe
any state change.

**Acceptance Scenarios**:

1. **Given** an owner has a saved connection, **When** the owner deletes it,
   **Then** it is unavailable for all future source access and its credential
   is no longer decryptable or usable.
2. **Given** a connection is referenced by active non-terminal work, **When**
   its owner requests deletion, **Then** the request is rejected with a stable
   conflict outcome rather than leaving active work with an unusable secret.
3. **Given** a deletion is denied, **When** the request completes, **Then** no
   connection, Job, queue, repository, or storage state changes.

---

### User Story 4 - Bound imports from external sources (Priority: P2)

An authorized user can start source-backed work only within configured limits
for the source, selected root, number of entries, and total declared size. The
system stores only safe references needed to resolve the connection later.

**Why this priority**: Limits prevent one connection from exhausting capacity
and keep long-running work safe and predictable.

**Independent Test**: A source request at or below configured limits is
accepted; requests exceeding each configured limit are rejected before durable
work, queue delivery, or binary transfer begins.

**Acceptance Scenarios**:

1. **Given** a valid, owned connection and a source request within configured
   limits, **When** the request is accepted, **Then** any durable work contains
   only the connection identifier and allowlisted source metadata.
2. **Given** a request exceeding a configured entry, size, path-depth, or
   source-time limit, **When** it is submitted, **Then** it is rejected with a
   safe validation outcome and has no durable or external side effect.

### Edge Cases

- A connection token expires after it was saved but before it is used; the
  worker reports `SOURCE_TOKEN_EXPIRED` through the safe job status/error
  projection and never records the token in the Job.
- A hostname initially resolves publicly but resolves to a prohibited address
  later; validation is repeated immediately before external access.
- A repository URL embeds user information, a password, a token-like query
  value, a fragment, or an unsupported scheme; it is rejected and not echoed
  in an error response.
- A request attempts to reuse a deleted, disabled, malformed, or foreign
  connection identifier; it is denied without an outbound provider call.
- Concurrent connection creation with the same normalized identity produces at
  most one active connection for that owner, or a stable duplicate outcome.
- Provider validation is unavailable or times out; the connection is not
  treated as active and the user receives a safe retryable outcome.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST let an authenticated user list only safe
  summaries of source connections they are authorized to see.
- **FR-002**: The system MUST let an authenticated user create a source
  connection only after validating the submitted repository address and token
  format. An authorized source-backed operation MUST separately validate its
  root path and configured import limits before provider access or durable work.
- **FR-003**: The system MUST record each source connection with a single
  owning user and MUST resolve the active session before every connection read,
  mutation, validation, or use.
- **FR-004**: The system MUST store a submitted source token only in encrypted
  server-side form and MUST never return, render, log, queue, or otherwise
  expose the submitted token, encrypted token, or token-derived secret.
- **FR-005**: The system MUST provide deletion only to an authorized owner or
  an administrator acting under the established system-wide policy; a deleted
  connection MUST not be usable for future source access.
- **FR-006**: The system MUST reject deletion of a connection referenced by
  active non-terminal work with a stable conflict outcome and MUST not silently
  invalidate that work.
- **FR-007**: The system MUST ensure that a durable Job and every queue payload
  contain no source token, decrypted secret, credential-bearing URL, or
  provider response. A Job may contain only the owned connection identifier and
  explicitly allowlisted source metadata.
- **FR-008**: The system MUST validate repository addresses against the source
  safety policy before any external access. The policy MUST reject unsupported
  schemes, embedded credentials, fragments, loopback, link-local, private,
  multicast, unspecified, and other prohibited destinations.
- **FR-009**: The system MUST repeat repository-address and root-path safety
  validation at the private processing boundary immediately before external
  access, including a fresh hostname-resolution safety check.
- **FR-010**: The system MUST accept only normalized, repository-relative root
  paths and MUST reject absolute paths, traversal, empty segments after
  normalization, platform escape forms, and paths exceeding configured depth or
  length limits.
- **FR-011**: The system MUST enforce configurable limits for source-backed
  work, including selected-root depth, entry count, total declared size, and
  processing duration; rejection MUST occur before enqueue or binary transfer.
- **FR-011a**: Policy limits MUST be finite, server-controlled deployment
  configuration. A browser request MUST NOT override a limit, an allowlist, or
  any other source-access policy value. Final numeric thresholds require a
  separate capacity and security review.
- **FR-011b**: Numeric IP host literals MUST be denied by default. An exception
  is permitted only when the server independently matches the exact IP address
  or CIDR range against a deployment-controlled allowlist; a browser request
  cannot supply or widen that exception.
- **FR-012**: The system MUST validate a token using a server-side provider
  interaction before declaring a new or changed connection active. If the
  provider reports expiration or invalid authorization, the system MUST return
  the stable code `SOURCE_TOKEN_EXPIRED` for expiration and a safe distinct
  validation outcome for other invalid tokens.
- **FR-013**: The private worker MUST decrypt a token only in server-only
  memory immediately before an authorized provider access, revalidate the
  connection owner/state and token, and discard decrypted material after the
  attempt.
- **FR-014**: The system MUST never disclose private repository addresses,
  provider tokens, encrypted-token values, encryption-key material, provider
  diagnostics, internal network details, stack traces, or server configuration
  through browser responses, logs, Job status/event projections, or queue
  payloads.
- **FR-015**: All denied, malformed, unsafe, expired-token, and limit-exceeded
  requests MUST produce no connection mutation, Job creation, queue delivery,
  MinIO write, or outbound provider access unless validation itself is the
  explicitly authorized connection-check operation.
- **FR-015a**: Where an import uses the existing staged upload lifecycle, the
  server MUST apply the following canonical checks without trusting browser
  declarations: Start/preflight checks item count, logical paths, and declared
  aggregate size; upload capability locks object key, accepted MIME type, and
  maximum size; item completion verifies actual MinIO object metadata; and
  commit reconciles completed item count and canonical aggregate data. This
  feature preserves those boundaries and does not add a new upload/import flow.
- **FR-016**: Source connection APIs MUST expose the following authorized
  operations: list connections, create a connection, delete a connection, and
  create a narrow source-backed Job. The Job endpoint MUST accept only
  allowlisted repository identity/manifest fields, must resolve the active
  actor and connection server-side, and returns only a safe Job DTO. Responses
  MUST use safe DTOs and stable, non-secret errors.
- **FR-017**: A private repository operation MUST require an active owned
  source connection; it MUST fail safely when no eligible connection is
  supplied.
- **FR-018**: The system MUST preserve existing dataset, Job, authorization,
  queue, and MinIO architecture rules; this feature MUST NOT introduce a
  repository-specific Job table, browser-to-provider credential flow, or binary
  storage in PostgreSQL.

### Key Entities *(include if feature involves data)*

- **Source Connection**: An owned, server-managed authorization relationship
  between a user and a safe external source identity, with safe status and
  encrypted credential material that is never browser-visible.
- **Connection Owner**: The authenticated user who created and controls a
  source connection; ownership is the default authorization boundary for every
  connection operation.
- **Safe Source Descriptor**: The allowlisted, non-secret repository identity,
  normalized root selection, and connection status that may be used for
  validation and durable work.
- **Source Access Policy**: The shared rules that classify repository addresses,
  resolved destinations, root paths, token state, and import limits as allowed
  or prohibited.
- **Source-backed Job Reference**: The allowlisted reference from a durable Job
  to a source connection; it identifies the connection without carrying any
  credential or raw provider data.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In controlled integration tests, 100% of valid owner connection
  creations result in an active safe connection summary while no browser
  response, durable Job, queue payload, or captured application log contains a
  submitted token or encryption material.
- **SC-002**: In the authorization matrix, 100% of foreign-connection read,
  delete, validate, and source-use attempts are denied with the established
  concealed-resource policy and produce zero durable, queue, storage, or
  provider-access side effects.
- **SC-003**: In the SSRF and path-safety matrix, 100% of prohibited address
  and root-path cases are rejected before an outbound provider request; the
  same cases are rejected again at the worker boundary.
- **SC-004**: In token-validation tests, 100% of expired-token cases return
  `SOURCE_TOKEN_EXPIRED` without exposing provider diagnostics or secret
  material.
- **SC-005**: At least 95% of valid source-connection validation attempts in a
  controlled local environment complete with a user-visible result within 10
  seconds; timeout failures remain safe and do not activate the connection.
- **SC-006**: In limit tests, 100% of requests exceeding any configured import
  limit are rejected before a Job is created, a queue message is delivered, or
  binary transfer begins.

## Assumptions

- The existing opaque-cookie session and current ownership/administrator policy
  remain the only authentication and authorization mechanism for this feature;
  no JWT, authentication bypass, or browser token storage is introduced.
- Existing `SourceConnection` persistence and the approved server-side
  encryption key-management configuration are available; this specification
  does not require a new credential-store model unless planning identifies an
  explicit approved schema gap.
- Supported private-source providers and their exact host allowlist are
  configuration-owned. Until an explicit provider allowlist is approved, only
  public-DNS HTTPS or SSH repository addresses without embedded credentials are
  eligible after the safety checks; arbitrary network destinations are not.
- Numeric IP literals are denied by default. Any exact IP/CIDR exception and
  every finite import-limit value are deployment-owned policy configuration;
  values are intentionally not database fields and cannot be supplied by a
  browser request. Numeric thresholds remain pending capacity/security review.
- Connection validation may contact a provider only after local safety and
  ownership checks pass. Its result is safe status information, not provider
  diagnostic data.
- The feature establishes secure connections and security controls; end-to-end
  repository cloning/import processing remains limited to already approved job
  flows and is not expanded by this phase.
- No binary content is persisted in PostgreSQL, and no new browser-visible
  provider capability is created by this feature.
