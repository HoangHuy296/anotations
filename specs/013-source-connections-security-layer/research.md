# Research: Source Connections Security Layer

## Decision: Reuse the existing `SourceConnection` model; do not plan a schema change

**Rationale**: The model already provides an owning `userId`, provider and authentication type, encrypted token fields, expiry, status, revocation time, safe metadata, and relations to `Dataset` and `Job`. The feature can meet its requirements by enforcing lifecycle and safe-projection rules over these fields.

**Alternatives considered**:

- Add a credential or provider-specific connection table: rejected because it duplicates the existing source-connection authority.
- Store a token in `ExternalRepository` or Job input: rejected because those are not a credential store and would violate security governance.

## Decision: First supported lifecycle is Gitea-only

**Rationale**: Existing authorized routes, client behavior, fixtures, and ownership guard are explicitly Gitea-scoped. Restricting this phase to that proven path prevents untested provider-specific authentication semantics from being treated as safe.

**Alternatives considered**:

- Enable all `RepoProvider` values immediately: rejected because each provider requires independently verified URL, token-validation, and error behavior.
- Add a generic credential proxy: rejected because it expands the public and secret-handling boundary.

## Decision: Expose a safe connection DTO, never the raw database model

**Rationale**: `baseUrl`, encrypted fields, account identifiers, metadata, and provider diagnostics can reveal private topology or credentials. The browser needs only an ID, display name, provider, status, safe expiry, and lifecycle timestamps.

**Alternatives considered**:

- Serialize Prisma data except `tokenEncrypted`: rejected because future secret-bearing fields could leak by accident.
- Return provider diagnostics: rejected because they can disclose account, repository, or topology details.

## Decision: Use a shared source-access policy with a fresh DNS check at each boundary

**Rationale**: Parsing a URL once is insufficient against DNS rebinding or later worker access. One policy must reject unsupported schemes, embedded credentials, query/fragment credential forms, numeric IP literals by default, and prohibited resolved destinations. A numeric host may proceed only after a server-owned exact IP/CIDR allowlist match; the web boundary uses it before provider validation and the worker repeats it immediately before external access.

**Alternatives considered**:

- Client-side validation: rejected because it is bypassable and cannot protect server-side network access.
- URL parsing without DNS classification: rejected because it misses hostname-resolution attacks.
- A general localhost/private-address exemption: rejected because it defeats SSRF protection. Controlled local integration may use narrowly configured trusted test source only.
- Browser-supplied IP/CIDR exception or limit override: rejected because policy belongs to deployment configuration, not request data.

## Decision: Apply finite, server-controlled limits at each canonical import boundary

**Rationale**: Declared browser values are useful only for preflight; they are not canonical proof. Start/preflight validates item count, logical paths, and declared aggregate size. Capability locks the object key, MIME type, and maximum size. Completion verifies actual object size against MinIO metadata. Commit reconciles completed item count and canonical aggregate data. Limit values remain deployment configuration and await capacity/security review.

**Alternatives considered**:

- One validation only at commit: rejected because it permits excessive uploads and unnecessary storage transfer.
- Browser-selected thresholds: rejected because an untrusted request could raise limits.
- Database fields for deployment thresholds: rejected because limits are operational policy, not domain data.

## Decision: Root paths are validated at source-operation scope, not stored on a connection

**Rationale**: A connection represents provider authorization. A repository root is selected per Dataset/source operation and belongs with existing Dataset source fields and allowlisted Job input. It must be normalized relative to the repository and rejected if absolute, traversing, platform-escaping, empty after normalization, or beyond limits.

**Alternatives considered**:

- Add a root path to every connection: rejected because one connection can serve several repositories/datasets with different roots.
- Trust root input after initial validation: rejected because the worker must revalidate before access.

## Decision: Validate tokens before activation and classify expiration safely

**Rationale**: A token is not usable merely because it encrypts. Server-side provider validation occurs after local safety/ownership checks. Expiration maps to `SOURCE_TOKEN_EXPIRED`; other failures map to safe stable codes.

**Alternatives considered**:

- Mark active before provider validation: rejected because later imports would fail unpredictably.
- Return raw provider errors: rejected because they can contain private data.

## Decision: Deletion is blocked while a connection has non-terminal Job references

**Rationale**: Force deletion could strand active work, and silent revocation creates unclear partial outcomes. A stable conflict lets the user cancel or finish work first; terminal history remains auditable without a usable credential.

**Alternatives considered**:

- Cascade delete Jobs/Datasets: rejected because it destroys durable history.
- Revoke silently during active work: rejected because it leaves unsafe, unclear execution state.

## Decision: Source-backed Jobs carry only IDs and allowlisted context

**Rationale**: The worker resolves `sourceConnectionId` from PostgreSQL at runtime. BullMQ carries exactly `{ jobId }`, so it cannot become a credential channel. Duplicate delivery stays idempotent on the same Job; authorized retry uses successor-Job lineage.

**Alternatives considered**:

- Include token/base URL/provider response in Job input: rejected by architecture and secret-handling rules.
- Put source state in Redis: rejected because Redis is transport only.
