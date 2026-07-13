# Phase 2 Research

## Decision: prepared schema is authoritative

**Decision**: Plan against the current `prisma/schema.prisma`; do not infer replacement fields from legacy UI or prior documents.

**Rationale**: It already defines the required core entities, supporting provenance/version entities, indexes, and relations.

**Alternatives considered**: Editing or regenerating schema during planning — rejected; it violates the feature and governance boundary.

## Decision: durable Job remains common

`Job` owns input, lifecycle, retry, idempotency, result metadata, and `queueName`, `queueJobId`, `enqueuedAt`, `dequeuedAt`. `JobEvent` is its ordered audit trail. Redis only transports `{ jobId }`.

## Decision: credentials stay isolated

`ExternalRepository` stores provenance only; `SourceConnection.tokenEncrypted` and `refreshTokenEncrypted` are the only token-bearing persistence fields.
