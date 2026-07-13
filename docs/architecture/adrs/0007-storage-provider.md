# ADR 0007: Storage Provider Abstraction

- Status: Accepted
- Date: 2026-06-23

## Context

Development needs simple local storage for cached images and exports.
Production may require S3 or MinIO. Domain code must not depend on filesystem
paths or public static files.

## Decision

Define a `StorageProvider` contract for write, read, delete, existence checks,
and download metadata. Implement local filesystem storage first. Generate
opaque server-side object keys, store objects outside `public/`, and serve them
through authorized Route Handlers. Future S3/MinIO providers implement the
same contract.

## Consequences

Storage backends can change without rewriting import or export workflows.
Streaming, retention, cleanup, and safe filename behavior must be implemented
consistently by each provider. Local storage is unsuitable for horizontally
scaled production without shared persistence.
