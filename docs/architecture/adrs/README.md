# Architecture Decision Records

## Status vocabulary

- **Accepted:** Approved architecture baseline for future implementation.
- **Superseded:** Replaced by a newer ADR.
- **Deprecated:** Retained for history but no longer recommended.

## Index

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](./0001-single-nextjs-application.md) | Single Next.js application and App Router | Accepted |
| [0002](./0002-server-client-boundaries.md) | Server and Client Component boundaries | Accepted |
| [0003](./0003-server-only-gitea-gateway.md) | Server-only Gitea gateway | Accepted |
| [0004](./0004-environment-gitea-credentials.md) | Environment-backed Gitea credentials for v1 | Accepted |
| [0005](./0005-reverse-proxy-sso.md) | Reverse-proxy SSO trust boundary | Accepted |
| [0006](./0006-postgresql-prisma.md) | PostgreSQL and Prisma persistence | Accepted |
| [0007](./0007-storage-provider.md) | Storage provider abstraction | Accepted |
| [0008](./0008-konva-state-model.md) | Konva interaction and state model | Accepted |
| [0009](./0009-export-strategies.md) | Strategy-based annotation exports | Accepted |
| [0010](./0010-api-validation-errors.md) | API validation and typed error contracts | Accepted |

## ADR template

```markdown
# ADR NNNN: Decision title

- Status: Proposed | Accepted | Superseded | Deprecated
- Date: YYYY-MM-DD

## Context

What forces and constraints require a decision?

## Decision

What is the chosen approach?

## Consequences

What becomes easier, harder, required, or intentionally unsupported?
```

ADRs are immutable after acceptance except for status and links. A material
change receives a new ADR that supersedes the old decision.
