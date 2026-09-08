# Implementation Plan: Collaboration Platform

**Branch**: `024-collaboration-platform` | **Date**: 2026-09-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/024-collaboration-platform/spec.md`

## Summary

Add governed dataset collaboration around the existing workspace: pending invitations and member roles, typed annotation/review assignments, flat threaded asset discussion, durable in-app notifications, delivery-only realtime updates, and ephemeral presence. Phase 023 remains the only annotation workflow: `Asset.status`, `AssetWorkflowEvent`, annotation geometry, and revision semantics are not repurposed.

### Stable Phase 024 baseline

The listed collaboration features are now the baseline, including the dedicated `apps/realtime` gateway, ticket issuance, worker-owned outbox relay, Redis fan-out, revocation, reconnect convergence, and presence. The shareable-link extension is an additive admission feature only; it does not revisit runtime topology, dependencies, Compose/proxy, worker ownership, or realtime protocol.

The audit selects a dedicated, delivery-only realtime gateway because the current Next App Router process is launched with `next dev`/`next start`, has no existing upgrade handler, and the review proxy has no WebSocket forwarding. The gateway is not a command API or durable data authority: Next.js remains the sole authenticated REST command/read boundary and PostgreSQL remains the durable source of truth. The gateway accepts short-lived server-issued connection tickets, subscribes to Redis delivery channels, maintains ephemeral presence, and forces reauthorization/subscription revocation after membership loss.

## Technical Context

**Language/Version**: TypeScript; Node.js 22; Next.js 16.2.9 App Router; React 19.

**Primary Dependencies**: Prisma 6/PostgreSQL, Zod, Next.js Route Handlers/Server Actions, Zustand, `ioredis`, established delivery-only realtime gateway, and browser-native WebSocket. The share-link extension introduces no dependency or runtime change.

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

---

## Additive shareable invitation-link extension

### Scope and architecture

Add a second membership-entry path: `share-link -> authenticated explicit claim -> existing DatasetMember`. It coexists with the implemented recipient-specific `DatasetInvitation` lifecycle and never changes it. Link possession, preview, authentication, or a realtime ticket does not authorize a dataset; only the normal `DatasetMember` created by a successful claim does.

The extension remains entirely inside existing boundaries: Next.js routes/pages validate and authorize; Prisma/PostgreSQL holds link lifecycle and membership truth; `runCollaborationTransaction` creates all accepted durable state; the existing private worker dispatches already-durable outbox jobs after commit; Redis/WebSocket only accelerate existing membership-change delivery. MinIO is not involved.

### Intended change surface after approval

| Area | Planned additive work | Explicitly unchanged |
| --- | --- | --- |
| Prisma | `DatasetInvitationLink`, enum/relations/indexes, safe membership-event actions, additive migration | Existing `DatasetInvitation`, `DatasetMember`, assignment/workflow/annotation models |
| Domain | `invitation-link-service` using existing membership authority, transaction, notification, and outbox helpers | `Asset.status`, revisions, geometry, feedback, `AssetWorkflowEvent` |
| HTTP | Manager create/list/revoke, public safe preview, authenticated claim | Existing invite acceptance and all WebSocket command boundaries |
| UI | Dataset membership-management link controls and fragment-based Join landing | Workspace layout, Properties Panel, assignment/discussion/presence semantics |
| API/docs | OpenAPI schema/paths and dedicated link contract | Existing collaboration contracts except additive references |
| Delivery | Existing membership-change outbox/revocation behavior only | `apps/realtime`, proxy, Compose, dependency/runtime configuration |

### Claim sequence

```text
manager creates link -> raw secret returned once -> /join#secret
public landing POSTs secret for safe preview -> sign-in if needed
authenticated explicit claim -> serializable Prisma transaction
  -> re-read link, expiry, dataset, creator authority, role, claimant membership
  -> DatasetMember + safe events + optional creator notification + outbox intent
  -> mark link claimed
commit -> enqueue existing outbox Job -> optional Redis/gateway invalidation
claim success -> Open workspace CTA -> /workspace/{datasetId}
normal DatasetMember authorization -> workspace/ticket/access
```

### Security and compatibility plan

- Use the existing `canManageDatasetMemberRole` policy at creation and claim time. Owner is never an encoded link role; Manager never gains a role-grant bypass.
- Use the `DatasetMember(datasetId,userId)` unique constraint plus guarded link lifecycle update in the serializable transaction. Store `claimedById` for loss-of-response retry idempotency.
- Keep the raw secret in the browser fragment and JSON request body only. Persist/search by digest; redact the request body; return generic terminal state to avoid a status/enumeration oracle.
- Remove/downgrade creator before claim makes the old link nonclaimable. Member removal after claim uses ordinary membership revocation; no old link or ticket restores access.
- Existing-member claim returns `ALREADY_MEMBER` without consuming link or changing role. Role changes remain managed member operations.
- Claim/revoke uses first committed guarded transition wins: revoke-first means unavailable/no member; claim-first means irrevocably claimed/no later revoke. Serializable retries re-read the row before any member insert.
- Public preview and authorized manager history are different DTOs. Only the initial create response contains the one-time share URL; no later projection can retrieve a raw token, digest, or reusable URL.
- Successful first claim notifies only the creator when they differ from claimant, via additive `DATASET_MEMBER_JOINED` semantics and a stable link/creator dedupe key. No claimant or bystander notification is created.
- The Open workspace CTA is navigation only. It removes the invitation fragment and opens `/workspace/{datasetId}`, where existing current `DatasetMember` authorization is independently enforced; no invitation secret becomes a workspace credential.
- Do not add a raw-token notification or Activity record. Safe lifecycle/member events may be projected later using existing Activity architecture.

### Validation plan

Run real PostgreSQL service/concurrency tests before UI delivery. Verify claims/revokes/expiry/creator-authority races and retries; then route contracts, public-redaction/rate-limit behavior, member-management UI/landing; then Phase 022/023 and Phase 024 regressions, OpenAPI, typecheck/lint/build, and manual logged-out-to-workspace/removal acceptance. No migration or implementation begins until the documented approval gates in research are accepted.
