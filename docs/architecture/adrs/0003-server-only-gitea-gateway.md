# ADR 0003: Server-Only Gitea Gateway

- Status: Accepted
- Date: 2026-06-23

## Context

Direct browser access to Gitea would expose credentials, private instance
details, and upstream error behavior. Multiple ad hoc clients would make
timeouts, redaction, and response validation inconsistent.

## Decision

`src/lib/gitea.ts` is the sole Gitea REST client and is guarded as server-only.
Browser requests use authenticated Route Handlers under `src/app/api/gitea`.
The client owns authorization headers, URL construction, timeouts, pagination,
response limits, upstream validation, and normalized failures.

## Consequences

Gitea secrets never enter browser code and upstream behavior is centralized.
Image bytes and metadata incur an application hop. Streaming and bounded
caching are required to control memory and latency.
