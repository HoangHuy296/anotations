# Ownership Guard Contract

## Server-only authorization sequence

1. Resolve the authenticated actor from the HTTP-only session cookie. Do not consume actor, owner, role, or creator identity from a browser body, query string, client state, or arbitrary request header.
2. Resolve the requested Dataset in the actor's ownership/membership scope.
3. Resolve the required DatasetPermission using [authorization-matrix.md](./authorization-matrix.md).
4. Resolve every resource inside that authorized Dataset; do not fetch a resource globally and authorize after exposing or mutating it.
5. Verify all submitted relational identifiers share the Dataset. This includes Asset, AssetVersion, Label, Annotation, Job, and selected SourceConnection relationships.
6. Only then perform a database mutation, storage operation, Job creation, or enqueue. On Job creation, use the server-resolved actor for `createdById` and enqueue only `{ jobId }`.

## Required outcomes

| Outcome | Contract |
| --- | --- |
| Anonymous, expired, revoked, or malformed session | `401`; no protected data or side effect. |
| Authenticated outsider or cross-dataset identifier | `404`; no protected metadata, durable write, queue message, or storage operation. |
| Authorized dataset member without permission | `403`; no protected data beyond safe policy failure and no side effect. |
| Invalid body or impossible same-dataset relation | `400`; no side effect. |
| Authorized request | Continue only with role-appropriate operation and server-derived ownership/creator fields. |

## Resource rules

- Dataset: owner is derived only from `Dataset.ownerId`; archive is owner-only and is never an accidental hard delete.
- Membership: manager may manage only non-owner memberships; a manager cannot change ownership or an OWNER membership.
- Asset and AssetVersion: operations require matching authorized `datasetId`; an AssetVersion must additionally match its Asset's Dataset.
- Label: taxonomy creation, update, and deletion require `label.manage`; reviewers and labelers cannot modify taxonomy.
- Annotation: create requires `annotation.create`; own update compares `createdById` with the resolved actor; any-user update requires `annotation.updateAny`; review requires `annotation.review`; version checks remain mandatory.
- SourceConnection: access requires `SourceConnection.userId === actor.id` before the connection may be selected or attached. Its tokens, encrypted fields, and private provider data remain server-only.
- Job: read/cancel checks use `Job.datasetId`; a known Job id from another dataset is invisible. Creating an export requires `job.createExport`; cancelling requires `job.cancel`.
