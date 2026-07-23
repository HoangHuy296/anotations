# Source Access Security Contract

## Validation order

For any source connection creation or source-backed operation:

1. Resolve the opaque-session actor.
2. Validate the request with Zod and reject unknown/unsafe fields.
3. Resolve a connection constrained by actor ownership (or explicit existing administrator oversight policy), active state, and non-revocation.
4. Parse and classify the provider address; reject unsafe input before a provider request.
5. Normalize and validate the repository-relative root path and configured limits before a Job or queue effect.
6. Validate token/provider state server-side only when the operation is authorized to do so.
7. Persist or enqueue only safe, allowlisted metadata.

The worker repeats steps 3–6 immediately before external provider access using fresh authoritative records and DNS destination classification.

## Repository address policy

Allowed first-provider address forms are explicitly configured Gitea HTTP(S) origins. A submitted address is rejected if it has an unsupported protocol, embedded userinfo, fragment, query string, malformed host/port, or resolves to loopback, link-local, private, multicast, unspecified, reserved, or otherwise prohibited destination. Numeric IP host literals are denied by default. They may proceed only after an independent exact IP/CIDR match against a server-controlled deployment allowlist; no browser request can provide or widen that exception.

A controlled local integration source may be permitted only by an explicit test-only trusted-source configuration. It must be unavailable in production and must not create a general private-network exception.

## Root path policy

The root is a repository-relative selector. Normalize separators and reject an absolute path, traversal segment, empty normalized segment, drive/UNC form, NUL/control content, overlong value, or value exceeding configured depth. The normalized value—not raw user input—is the only value eligible for allowlisted durable metadata.

## Token handling policy

- Browser submits a token only to the authorized create request over the application boundary.
- Server encrypts only after local validation and uses plaintext only for the immediate authorized provider check.
- Worker decrypts only after reloading and revalidating the owned connection.
- Plaintext and encrypted tokens are never serialized, queued, stored in Job data, included in MinIO metadata, logged, or put in error messages.
- Token expiration maps to `SOURCE_TOKEN_EXPIRED`; the safe status becomes unusable for future source access.

## Limit policy

Limit values are finite, configuration-owned, and must be applied before durable work: maximum root depth, entry count, total declared size, and source-processing duration. Browser input cannot override them. An exceedance causes no Job, queue, binary-storage, or metadata side effect.

## Canonical import verification sequence

Existing staged-import routes retain these boundaries:

1. **Start/preflight** validates item count, logical path, and total declared size.
2. **Upload capability** locks the exact object key, accepted MIME type, and maximum size.
3. **Item completion** verifies the true object size against canonical MinIO metadata.
4. **Commit** reconciles `COMPLETED` item count and canonical aggregate data.

No browser declaration is authoritative after its corresponding server/MinIO check. This Phase 013 policy integration does not introduce a new upload or import workflow.
