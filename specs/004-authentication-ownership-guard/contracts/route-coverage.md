# Phase 004 Route Coverage

| Surface | Required boundary |
| --- | --- |
| `/api/auth/*` | Public auth routes; no proxy actor header; cookie session only. |
| `/api/images/[imageId]/*` | Active cookie actor; resolve Asset then Dataset `dataset.read`/`dataset.update`; source access uses only the selected dataset connection server-side. |
| `/api/gitea/repos*` | Active cookie actor plus caller-owned active `SourceConnection`; no global `User.role` gate or environment provider token. |
| `/api/gitea/import` | Active cookie actor plus caller-owned active `SourceConnection`; persistence derives dataset owner and source connection server-side. |
| `/workspace/[datasetId]` | Cookie actor plus Dataset `dataset.read`; annotation actions apply create/update/review permission, canonical JSON validation, and version checks. |
| `/dashboard`, `/datasets`, `/imports`, `/labels`, `/exports` | Active session resolved server-side. Dataset queries are owner/member scoped; imports expose only the actor's safe connection names/ids. |
| Dataset member/archive actions | Active cookie actor; archive is owner-only and membership actions refuse owner changes. |
| Future Job routes | `requireJobPermission`; durable Job helpers stamp the actor and queue payload is only `{ jobId }`. No browser Job endpoint or worker processing is added in this phase. |
