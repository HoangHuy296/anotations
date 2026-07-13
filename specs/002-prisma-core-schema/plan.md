# Implementation Plan: Prisma Core Schema — Phase 2

**Branch**: `002-prisma-core-schema` | **Date**: 2026-07-13 | **Spec**: [spec.md](./spec.md)

## Summary

Plan verification and adoption of the prepared multi-modal Prisma core schema. `prisma/schema.prisma` is the immutable source of truth for this planning step; no schema, migration, generated client, or runtime code is changed.

## Technical Context

**Language/Version**: TypeScript 5, Prisma 6.19.3.  
**Storage**: PostgreSQL metadata/Job authority; MinIO binary storage; Redis/BullMQ transport only.  
**Testing**: Future approved implementation runs `prisma validate`, `prisma migrate deploy`, generation, and constraint-focused integration tests.  
**Target Platform**: Existing pnpm workspace and Compose PostgreSQL.  
**Constraints**: no raw SQL; no binary PostgreSQL storage; no secrets in repository/job payload; queue payload only `{ jobId }`; no specialized Job models; no schema edits in this plan.

## Constitution Check

The Spec Kit constitution is an unfilled template. `AGENTS.md` and Phase 0 architecture documents are binding. **PASS**: prepared schema preserves PostgreSQL Job authority, MinIO binary boundary, encrypted source credentials, canonical annotation geometry/version, and modality-driven assets. **BLOCKER FOR IMPLEMENTATION**: any schema/migration edit requires separate explicit approval; this plan has none.

## Project Structure

```text
prisma/schema.prisma                 # source of truth; read-only
prisma/migrations/                   # existing migration history; read-only
lib/generated/prisma/                # generated output; do not rewrite in planning
specs/002-prisma-core-schema/
├── plan.md
├── research.md
├── data-model.md
├── contracts/schema-governance.md
└── quickstart.md
```

**Structure Decision**: Phase 2 adopts the existing schema rather than designing a parallel model or split job tables.
