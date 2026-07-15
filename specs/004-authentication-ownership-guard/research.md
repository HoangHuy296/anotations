# Phase 004 Research

## Decision: use an opaque rotating session credential

**Decision**: Generate a high-entropy opaque credential at signup and login, set it only in an HTTP-only cookie, and persist only its deterministic cryptographic hash in the existing `AuthSession.refreshTokenHash` field. Each refresh replaces the stored hash and browser cookie atomically enough that the prior credential is unusable after rotation.

**Rationale**: The existing model already supports revocation, expiration, client context, and a unique credential hash. An opaque credential avoids browser-readable token claims and needs no new table, migration, package, or session store.

**Alternatives considered**:

- Signed browser-readable JWT: rejected because the phase requires browser-inaccessible credentials and the existing session record is the revocation authority.
- Redis-backed sessions: rejected because PostgreSQL is the established durable authority and Redis is restricted to queue transport.
- A new authentication library: rejected because package installation is not approved and existing primitives satisfy the scope.

## Decision: retire proxy headers as browser authentication

**Decision**: The current reverse-proxy identity headers are not used to establish a Fieldframe browser actor in this phase. The five public auth routes and health route bypass that legacy proxy requirement; protected browser routes resolve only from the database-backed HTTP-only cookie session.

**Rationale**: Signup/login/refresh require first-party authentication, and two competing actor sources create a privilege-confusion risk. Phase 0 assigns browser authentication to the Next.js application boundary.

**Alternatives considered**:

- Keep proxy headers as a fallback after cookie failure: rejected because a caller could obtain a different authority depending on request path or infrastructure behavior.
- Keep the proxy-header development administrator: rejected because it bypasses account, session, and ownership test coverage.

## Decision: use the existing Node test capability

**Decision**: Add the Phase 004 integration matrix using Node's built-in test runner with the existing `tsx` TypeScript loader; do not add a testing package.

**Rationale**: The repository already includes Node/TypeScript tooling but has no test-framework dependency. This satisfies the mandatory matrix without requesting package approval.

**Alternatives considered**:

- Add Vitest, Jest, or Playwright: deferred because each needs explicit dependency approval.
- Omit automated tests: rejected because the user made the permission test matrix mandatory.

## Decision: password storage and verification remain server-only

**Decision**: Validate signup/login bodies with Zod and use Node built-in cryptography to derive and verify a salted password hash stored in `User.passwordHash`. Password values are used only for the request and are never returned, logged, queued, or stored elsewhere.

**Rationale**: `User.passwordHash` is already present, and Node built-ins avoid new dependency approval while meeting the no-plaintext rule.

**Alternatives considered**:

- Plaintext or reversible password storage: rejected by the security requirements.
- Client-side hashing as a substitute: rejected because it would turn a reusable client value into a password equivalent and does not remove the server-side password verification requirement.
- New password-hashing dependency: deferred; it is not required for the approved planning scope and would require explicit package approval.

## Decision: authorization is dataset-scoped and server-derived

**Decision**: Resolve the authenticated actor from the session first, then resolve Dataset ownership/membership and permission before every protected read or mutation. Asset, AssetVersion, Label, Annotation, Job, and SourceConnection requests are looked up with their dataset relationship in the same server-side authorization boundary.

**Rationale**: Dataset is the central product entity. Scoping lookups to the already-authorized Dataset prevents identifier guessing and cross-dataset reference substitution.

**Alternatives considered**:

- Checking only a resource id: rejected because it permits cross-dataset access when an id is known.
- Trusting browser `ownerId`, `userId`, or role values: rejected because clients are not an authorization authority.
- Using the global `User.role` for dataset permission: rejected because the supplied policy is explicitly per-dataset.

## Decision: return 404 for invisible datasets/resources and 403 for insufficient member role

**Decision**: Return `401` for unauthenticated requests, `404` for an authenticated actor who is not a member/owner or references a different dataset, and `403` only when a known dataset member lacks the requested permission.

**Rationale**: This gives clients a consistent contract while preventing membership and resource-existence disclosure to outsiders.

**Alternatives considered**:

- Return `403` to every authenticated denial: rejected because it confirms that a protected dataset or resource exists to a non-member.
- Return `404` to every denial: rejected because legitimate members need a clear role-policy failure to support correct UI behavior and tests.

## Decision: verify cross-record dataset integrity before mutation

**Decision**: Creation and update paths must verify that Asset, AssetVersion, Label, Annotation, Job, and selected SourceConnection references are all inside the authorized Dataset. Annotation updates also apply `updateOwn` against server-resolved `createdById` and require the submitted version to match before saving.

**Rationale**: The schema has dataset identifiers on these records, but cross-reference consistency requires application-level validation in this phase. The existing `Annotation.version` rule prevents stale autosave overwrite.

**Alternatives considered**:

- Trust caller-supplied dataset ids: rejected due to cross-dataset substitution risk.
- Repair mismatched references automatically: rejected because it can silently write data into the wrong workspace.
- Add a migration now: rejected because `schema.prisma` is authoritative and this phase explicitly excludes schema change.
