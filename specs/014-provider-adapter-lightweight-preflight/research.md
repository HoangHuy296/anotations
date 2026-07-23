# Phase 014 Research: Provider Adapter + Lightweight Preflight

## Decision: Reuse Phase 013 security primitives without changing their lifecycle

**Rationale**: `getRequestActor`, `resolveOwnedSourceToken`, and the shared
source-access policy already enforce opaque-session authentication, ownership,
ACTIVE/unrevoked/unexpired Gitea eligibility, encrypted token handling, root
normalization, numeric-IP default denial, and DNS safety. Preflight needs a
read-only use of these controls, not another credential store.

**Alternatives considered**:

- Accept a token in the preflight request: rejected because it exposes a
  provider credential to a browser-facing boundary and bypasses ownership.
- Create/update a SourceConnection during preflight: rejected because the
  phase explicitly preserves SourceConnection state.
- Allow private GitHub using an ad-hoc environment token: rejected because it
  creates an unaudited credential path. Private GitHub returns a safe access
  denial until its lifecycle is separately approved.

## Decision: Create a dedicated server-only adapter boundary

**Rationale**: A registry with provider-specific clients/mappers lets GitHub
and Gitea share typed results and stable errors while preventing legacy import
routes from accidentally creating a Dataset or manifest.

**Alternatives considered**:

- Reuse `/api/gitea/import`: rejected because that endpoint includes preview
  and persistence behavior outside Phase 014.
- Call legacy `gitea.ts` tree/file helpers directly: rejected for root checks
  because recursive tree helpers are broader than the bounded metadata check,
  and file helpers can buffer/download content.

## Decision: Validate in a fixed fail-closed order

**Rationale**: The coordinator resolves actor first, strictly validates body
shape, conceals foreign connection identifiers, then validates repository
address/DNS and every redirect hop before provider access. This stops SSRF and
credential probing before any outbound request.

**Alternatives considered**:

- Validate after choosing/contacting the provider: rejected because an unsafe
  request could already reach a prohibited host.
- Rely on fetch's `redirect: error`: rejected because it does not classify the
  redirect destination under the shared source policy. The new client must
  inspect each redirect target before following it.

## Decision: Use bounded metadata checks, not manifest traversal or download

**Rationale**: Repository/ref existence and an optional root-path existence
can be established through provider metadata and a bounded path-aware listing.
The adapter interface retains future `listFiles` and `downloadFile` methods,
but Phase 014 invokes only bounded methods needed for preflight.

**Alternatives considered**:

- Clone the repository: rejected as long-running, binary-producing work.
- Recursively list a full tree: rejected as an unbounded manifest operation.
- Download one sentinel file: rejected because file content is unnecessary to
  prove accessibility/path existence.

## Decision: Preserve the requested semantic error codes; use only the existing safe operational-unavailable envelope

**Rationale**: The endpoint maps repository/provider outcomes to the eight
specified preflight codes. A transport timeout, malformed upstream response,
or rate limit does not assert repository accessibility and remains the
established generic safe provider-unavailable response (`503`) without raw
provider diagnostics. It is not a new semantic preflight outcome.

**Alternatives considered**:

- Mislabel unavailability as not-found/access-denied: rejected because it
  gives users incorrect remediation and obscures outages.
- Add a new schema field or Job for retries: rejected because this phase is
  read-only and synchronous.

## Decision: Test real boundaries and snapshots

**Rationale**: Controlled HTTP tests with normal opaque-cookie login, a
provider fixture, PostgreSQL, isolated passworded Redis, and MinIO prove that
the new route does not produce durable/import side effects. Unit tests cover
mapper/registry/error branches deterministically.

**Alternatives considered**:

- Only service-unit tests: rejected because they cannot prove auth,
  authorization, response redaction, or zero side effects at the Route Handler.
- Mock all providers/storage/queue: rejected for the required integration
  proof; controlled fixture servers and Compose services are required.
