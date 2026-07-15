# Authentication and Ownership Data Model

This phase uses the existing Prisma schema as the source of truth. It introduces no model, field, enum, migration, or database reset.

## Existing entities and authorization meaning

| Entity | Existing fields used | Authorization and validation rule |
| --- | --- | --- |
| User | `id`, `email`, `passwordHash`, `name`, `role` | Email is normalized before uniqueness lookup. `passwordHash` is server-only. `User.role` does not grant dataset access. |
| AuthSession | `id`, `userId`, `refreshTokenHash`, `expiresAt`, `revokedAt`, `userAgent`, `ipAddress` | One opaque cookie credential maps to one active, unexpired, unrevoked session by hash. Rotation replaces the hash; logout sets revocation. |
| Dataset | `id`, `ownerId`, `archivedAt`, `deletedAt`, `sourceConnectionId` | Authorization root. `ownerId` grants OWNER policy. Archive is the only routine delete behavior in this phase. |
| DatasetMember | `datasetId`, `userId`, `role` | Grants MANAGER, REVIEWER, or LABELER policy only. The owner relationship remains controlled by `Dataset.ownerId`; members cannot create/change OWNER membership. |
| Asset | `id`, `datasetId`, `uploadedById` | Must be found inside the authorized Dataset. Upload/delete permission is evaluated before storage work. |
| AssetVersion | `id`, `assetId`, `datasetId` | Its `datasetId` and related Asset's `datasetId` must both equal the authorized Dataset. |
| Label | `id`, `datasetId` | Must belong to the authorized Dataset. Taxonomy mutations require `label.manage`. |
| Annotation | `id`, `datasetId`, `assetId`, `assetVersionId`, `labelId`, `createdById`, `version` | Dataset, Asset, optional AssetVersion, and optional Label must share one Dataset. `updateOwn` compares server-resolved actor to `createdById`; stale version is rejected. |
| SourceConnection | `id`, `userId`, encrypted fields | Must belong to the authenticated actor before it may be viewed, selected, or attached to an authorized Dataset/Job. Encrypted fields are never returned. |
| Job | `id`, `datasetId`, `createdById`, `canceledById`, queue fields | Must be found inside the authorized Dataset. Creation sets `createdById` from the actor; queue transport remains `{ jobId }` only. |

## Authenticated session lifecycle

```text
Signup / Login
  -> validate credentials
  -> create or verify User
  -> create active AuthSession with hashed opaque credential and expiry
  -> set HTTP-only cookie

Protected request
  -> read cookie server-side
  -> hash credential
  -> find active, unexpired AuthSession and User
  -> resolve DatasetPermission as required

Refresh
  -> validate current active session
  -> replace credential hash and cookie
  -> old credential is denied

Logout
  -> revoke active AuthSession
  -> clear cookie
  -> later protected/refresh request is unauthenticated
```

## Dataset permission resolution

1. Resolve authenticated actor from the session. Missing or invalid session produces `401`.
2. Read the target Dataset within normal availability state. If it is not owned by or shared with the actor, produce `404`.
3. Derive `OWNER` when `Dataset.ownerId === actor.id`; otherwise use that actor's DatasetMember role.
4. Test the derived role against the final matrix in [authorization-matrix.md](./contracts/authorization-matrix.md). A member without the permission receives `403`.
5. Resolve every referenced resource within the authorized dataset scope and validate all related `datasetId` values before mutation. A different-dataset reference produces `404`; invalid same-dataset combinations produce `400`.

## State transitions

| Entity | Allowed state change in this phase | Required authorization |
| --- | --- | --- |
| AuthSession | active → rotated active | current valid session |
| AuthSession | active → revoked | current valid session/logout |
| Dataset | active → archived | `dataset.delete` (OWNER only) |
| Annotation | draft/in-progress/submitted → reviewed/accepted/rejected | `annotation.review` |
| Annotation | any editable state → updated | `annotation.updateOwn` or `annotation.updateAny`, plus current version |
| Job | active → cancellation requested | `job.cancel` in the Job's Dataset |
