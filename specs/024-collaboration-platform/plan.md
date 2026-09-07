# Implementation Plan: Collaboration Platform

**Branch**: `024-collaboration-platform` | **Date**: 2026-09-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/024-collaboration-platform/spec.md`

## Summary

Add governed dataset collaboration around the existing workspace: pending invitations and member roles, typed annotation/review assignments, flat threaded asset discussion, durable in-app notifications, delivery-only realtime updates, and ephemeral presence. Phase 023 remains the only annotation workflow: `Asset.status`, `AssetWorkflowEvent`, annotation geometry, and revision semantics are not repurposed.

The audit selects a dedicated, delivery-only realtime gateway because the current Next App Router process is launched with `next dev`/`next start`, has no existing upgrade handler, and the review proxy has no WebSocket forwarding. The gateway is not a command API or durable data authority: Next.js remains the sole authenticated REST command/read boundary and PostgreSQL remains the durable source of truth. The gateway accepts short-lived server-issued connection tickets, subscribes to Redis delivery channels, maintains ephemeral presence, and forces reauthorization/subscription revocation after membership loss.

## Technical Context

**Language/Version**: TypeScript; Node.js 22; Next.js 16.2.9 App Router; React 19.

**Primary Dependencies**: Prisma 6/PostgreSQL, Zod, Next.js Route Handlers/Server Actions, Zustand, `ioredis`; browser-native WebSocket. The selected gateway requires a direct WebSocket server dependency, which MUST be requested and approved before implementation because no direct dependency currently exists.

**Storage**: PostgreSQL/Prisma is authoritative for memberships, invitations, assignment slots/history, comments/mentions, notifications, and domain audit records. Redis is delivery transport and ephemeral presence only. MinIO remains binary-only.

**Testing**: Existing Node `node:test`/tsx integration suites, PostgreSQL Compose integration tests, endpoint contract tests, and multi-browser/manual realtime validation.

**Target Platform**: Existing Docker Compose Node/Linux deployment, including the review nginx proxy.

**Project Type**: Existing Next.js web application plus private worker; one narrowly scoped delivery gateway process is justified for WebSocket connections only and must not duplicate the Next.js command boundary.

**Performance Goals**: Relevant collaboration changes are indicated to connected authorized users within five seconds in 95% of runs; presence expires within the configured heartbeat window; reconnect always converges from authoritative reads.

**Constraints**: Prisma only (no raw SQL); Zod at every mutation boundary; no credentials or private URLs in browser state, payloads, logs, or realtime events; no realtime annotation geometry; `PRESENCE IS NOT A LOCK`; UI permissions are not authorization; all commands stay in Next.js.

**Scale/Scope**: One active annotation and one active review assignment per asset; root comment with direct replies only; in-app notifications only; no external guests, email/push, owner transfer, bulk assignment, or co-editing.

## Constitution Check

*GATE: Pass before research; re-checked after design.* The unfilled `.specify` constitution is non-authoritative; [AGENTS.md](../../AGENTS.md) and Phase 0 architecture documents govern.

| Gate | Status | Plan response |
| --- | --- | --- |
| Next.js owns commands and durable reads | PASS | All browser mutations and authoritative reads remain Next.js Route Handlers/Server Actions. The gateway has no command or read API. |
| PostgreSQL/Prisma is durable authority | PASS | Collaboration state, notifications, and domain history use Prisma models/transactions only. |
| Redis is not a durable state store | PASS | Redis carries realtime delivery signals and TTL presence only; reconnect reads PostgreSQL. |
| No duplicate public backend | PASS with bounded exception | A separately deployed gateway is delivery-only, cannot mutate or query domain state, and is justified by the current Node/Next/proxy audit. It requires an architecture decision record before implementation. |
| Asset and annotation semantics remain locked | PASS | Assignments/comments/notifications never write `Asset.status`, Asset revision, Annotation geometry, Annotation revision, or `AssetWorkflowEvent`. |
| Credentials remain server-only | PASS | Gateway receives only short-lived, scoped connection tickets; never provider/DB/Redis/MinIO credentials. |

## Project Structure

### Documentation

```text
specs/024-collaboration-platform/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── collaboration-api.md
│   └── realtime-protocol.md
└── tasks.md                     # generated later
```

### Source Code

```text
apps/
├── web/
│   └── src/
│       ├── app/api/datasets/[datasetId]/...   # collaboration commands/reads
│       ├── app/api/notifications/...          # notification reads/acknowledgement
│       ├── components/layout/                  # global Bell
│       ├── components/workspace/               # header, drawer, presence/activity
│       └── lib/{authorization,collaboration,realtime}/
├── realtime/                                  # delivery-only WebSocket gateway (new; ADR-gated)
└── worker/                                    # unchanged command boundary
prisma/
├── schema.prisma
└── migrations/
packages/
└── domain/                                    # shared safe event/validation contracts only
docker-compose.yaml
docker-compose.review.yaml
docker/review-proxy.conf
```

**Structure Decision**: Keep browser pages, REST commands, authorization, validation, durable writes, and all authoritative reads in `apps/web`. Add `apps/realtime` only after ADR approval; it owns connection delivery and Redis presence, never domain commands or authoritative reads. Do not create modality-specific workspace routes.

## Delivery Slices

1. Record the realtime-gateway architecture decision and add only its approved runtime/dependency surface.
2. Add durable invitations, member-management rules, typed assignment slot/history, and safe migration compatibility for `Asset.assignedToId`.
3. Add asset discussion, flat replies, mentions, and moderation/resolve behavior.
4. Add idempotent durable notifications and Phase 023 workflow notification production after successful transitions.
5. Add the delivery gateway, short-lived tickets, Redis fan-out, subscription reauthorization/revocation, and TTL presence.
6. Add Bell, member directory, assignment controls, Discussion/Activity drawer, and avatar presence without altering the Properties Panel.
7. Validate permissions, idempotency, reconnect, lifecycle, regression, Docker/proxy, OpenAPI, and security boundaries.

## Post-Design Constitution Re-Check

PASS, contingent on an ADR approving the narrowly scoped realtime gateway and on explicit dependency approval for its server library. The gateway's transport-only responsibility preserves the locked Next.js/API, PostgreSQL, Redis, and worker boundaries.

## Complexity Tracking

| Violation / extension | Why needed | Simpler alternative rejected because |
| --- | --- | --- |
| Delivery-only realtime gateway | The current `next start`/App Router deployment has no existing WebSocket upgrade surface; the review nginx proxy also needs a distinct upgrade target. A gateway provides connection lifecycle, Redis fan-out, and subscription revocation without turning Next into a custom server. | A custom Next server is an escape hatch that changes the current runtime and loses documented optimizations; polling alone cannot meet the timely-presence requirement. |
