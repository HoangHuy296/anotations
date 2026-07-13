# ADR 0004: Environment-Backed Gitea Credentials for V1

- Status: Accepted
- Date: 2026-06-23

## Context

V1 is a single-operator deployment and already has server environment
credentials. Building encrypted credential management now would require key
rotation, administration, and multi-tenant authorization beyond the first
release.

## Decision

Read `GITEA_BASE_URL` and `GITEA_ACCESS_TOKEN` only in server-only code. Do not
copy the token into PostgreSQL. Keep `GiteaConnection.tokenEncrypted` nullable
to preserve a migration path to managed connections later. Never prefix these
variables with `NEXT_PUBLIC_`.

## Consequences

Operations manage credential rotation through deployment secrets. V1 supports
one active Gitea connection. A future multi-connection feature requires a new
ADR for encryption, key management, ownership, and rotation.
