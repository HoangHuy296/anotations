# Dataset Authorization Matrix

This is the final permission and mandatory test contract for Phase 004.

## Permission assignments

| Permission | OWNER | MANAGER | REVIEWER | LABELER |
| --- | :---: | :---: | :---: | :---: |
| `dataset.read` | allow | allow | allow | allow |
| `dataset.update` | allow | allow | deny | deny |
| `dataset.delete` (archive only) | allow | deny | deny | deny |
| `member.manage` (non-owner membership only) | allow | allow | deny | deny |
| `asset.upload` | allow | allow | deny | deny |
| `asset.delete` | allow | allow | deny | deny |
| `label.manage` | allow | allow | deny | deny |
| `annotation.create` | allow | allow | allow | allow |
| `annotation.updateOwn` | allow | allow | allow | allow |
| `annotation.updateAny` | allow | allow | allow | deny |
| `annotation.review` | allow | allow | allow | deny |
| `repository.sync` | allow | allow | deny | deny |
| `job.createExport` | allow | allow | allow | deny |
| `job.cancel` | allow | allow | deny | deny |

## Non-negotiable restrictions

- Managers cannot archive/delete datasets, change ownership, or modify OWNER memberships.
- Reviewers can accept/reject annotations but cannot change the label taxonomy.
- Labelers cannot update annotations created by another user.
- Users cannot use another user's SourceConnection.
- Users cannot view or cancel Jobs in another Dataset.
- Asset, Label, Annotation, and AssetVersion references must belong to the same Dataset.
- Owners archive a Dataset; this phase provides no routine hard delete.

## Mandatory role and isolation test matrix

Every protected operation must have the following tests. The expected status refers to the Route Handler or Server Action's externally observable result.

| Test class | Setup | Expected result | Required assertion |
| --- | --- | --- | --- |
| Allowed role | Owner/member role has the listed permission | `200` for read/update/cancel/archive or `201` for create | Operation succeeds and only the intended Dataset record changes. |
| Unallowed member role | Member is in the Dataset but lacks the permission | `403` | No durable row, queue message, or binary object is created or changed. |
| Non-member | Authenticated user has no membership and is not owner | `404` | No protected metadata or relation existence is disclosed. |
| Cross-dataset resource | Actor has access to Dataset A but supplies a resource/reference from Dataset B | `404` | The target is not read or mutated; no cross-dataset relation is created. |
| Unauthenticated | Missing, invalid, expired, or revoked cookie | `401` | No protected metadata or side effect. |

### Required targeted cases

| Case | Expected result |
| --- | --- |
| Labeler updates own Annotation with the current version | success. |
| Labeler updates another user's Annotation | `403`; annotation version/geometry unchanged. |
| Reviewer accepts/rejects an Annotation | success. |
| Reviewer changes Label taxonomy | `403`; taxonomy unchanged. |
| Manager archives/deletes Dataset | `403`; Dataset remains active. |
| Manager changes Dataset owner or OWNER membership | `403`; ownership/membership unchanged. |
| Owner archives Dataset | success; `archivedAt` changes and no hard delete occurs. |
| User attaches/reads another user's SourceConnection | `404`; encrypted fields never appear. |
| User views/cancels Job in another Dataset | `404`; Job state and queue state unchanged. |
| Annotation references Asset, AssetVersion, or Label from another Dataset | `404`; no Annotation is created/updated. |
| AssetVersion's Dataset differs from its Asset Dataset | `400` or `404` before mutation, according to whether the mismatch is wholly within the caller's visible Dataset; no relation is written. |
| Refresh uses an already rotated, revoked, or expired credential | `401`; no new session is established. |
