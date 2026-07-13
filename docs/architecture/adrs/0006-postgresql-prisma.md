# ADR 0006: PostgreSQL and Prisma Persistence

- Status: Accepted
- Date: 2026-06-23

## Context

Users, repositories, datasets, images, labels, annotations, metadata, and
exports have relational ownership and lifecycle rules. Annotation geometry and
external metadata also need flexible structured fields.

## Decision

Use PostgreSQL as the platform system of record and Prisma for schema,
migrations, transactions, and typed access. Use relations for ownership and
workflow entities, enums for controlled states, and JSON only for geometry or
open-ended metadata. Apply schema changes through Prisma migrations rather
than handwritten SQL unless a documented database need requires it.

## Consequences

The domain gains transactional integrity and generated types. JSON fields need
Zod validation at application boundaries. Imports and annotation/status
updates must use transactions where partial writes would violate invariants.
