# ADR 0010: API Validation and Typed Error Contracts

- Status: Accepted
- Date: 2026-06-23

## Context

Route Handlers and Server Actions accept untrusted input and interact with
private upstream systems. Inconsistent validation or raw errors could corrupt
data or disclose secrets and infrastructure details.

## Decision

Validate path, query, and body input with shared Zod schemas before domain
logic. Return typed DTOs and a normalized error envelope containing a stable
code, safe message, optional field errors, and request ID. Map Prisma, storage,
and Gitea failures at the server boundary. Do not expose raw exceptions,
upstream bodies, SQL details, private URLs, or filesystem paths.

## Consequences

Clients receive predictable errors and logs can correlate failures safely.
Every public operation requires schemas and error-code definitions. Internal
details remain in redacted server logs rather than API responses.
