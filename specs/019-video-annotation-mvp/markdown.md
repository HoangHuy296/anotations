# Phase 019 — T026 Track/Keyframe HTTP Completion Matrix

## Objective

Complete the full authenticated HTTP actor, operation, malformed, unknown,
foreign, wrong-resource-kind, and cross-resource matrix for VideoObjectTrack
and Video keyframe mutations.

T026 covers Track and keyframe APIs only.

Do not include temporal-label completion in T026.
Do not add new public routes.
Do not change the existing permission model.

## Canonical public routes

| Resource | Operation | Route |
|---|---|---|
| Track | Create | `POST /api/assets/[assetId]/video-object-tracks` |
| Track | Update | `PATCH /api/video-object-tracks/[trackId]` |
| Track | Delete | `DELETE /api/video-object-tracks/[trackId]` |
| Keyframe | Create | `POST /api/video-object-tracks/[trackId]/keyframes` |
| Keyframe | Update | `PATCH /api/video-keyframes/[annotationId]` |
| Keyframe | Delete | `DELETE /api/video-keyframes/[annotationId]` |

Keyframe PATCH and DELETE remain canonical by `annotationId`.

Do not add:

- `PATCH /api/video-object-tracks/[trackId]/keyframes/[annotationId]`
- `DELETE /api/video-object-tracks/[trackId]/keyframes/[annotationId]`

For keyframe PATCH/DELETE, the server resolves the actual Track from
`Annotation.trackId`.

---

# 1. Locked permission matrix

## 1.1 Track and keyframe permissions

| Actor | Track create | Track update | Track delete | Keyframe create | Keyframe update | Keyframe delete |
|---|---:|---:|---:|---:|---:|---:|
| OWNER | Allow | Allow via `annotation.updateAny` | Allow | Allow | Allow via `annotation.updateAny` | Allow |
| MANAGER | Allow | Allow via `annotation.updateAny` | Allow | Allow | Allow via `annotation.updateAny` | Allow |
| REVIEWER | Allow | Allow via `annotation.updateAny` | Allow | Allow | Allow via `annotation.updateAny` | Allow |
| LABELER | Allow via `annotation.create` | Deny under current policy | Deny | Allow via `annotation.create` | Deny under current policy | Deny |
| Authenticated non-member | Concealed denial | Concealed denial | Concealed denial | Concealed denial | Concealed denial | Concealed denial |
| Member of another Dataset | Concealed denial | Concealed denial | Concealed denial | Concealed denial | Concealed denial | Concealed denial |
| Unauthenticated | `401` | `401` | `401` | `401` | `401` | `401` |

Do not broaden LABELER permissions.

Use the existing authorization helpers as the sole authority.

---

# 2. Track create matrix

Route:

`POST /api/assets/[assetId]/video-object-tracks`

| Test ID | Actor/resource/request condition | Expected |
|---|---|---|
| T026-TC01 | OWNER, valid VIDEO Asset, same-Dataset Label | Success; Track revision starts at `1` |
| T026-TC02 | MANAGER, valid resources | Success |
| T026-TC03 | REVIEWER, valid resources | Success |
| T026-TC04 | LABELER, valid resources | Success |
| T026-TC05 | Unauthenticated | Canonical `401` |
| T026-TC06 | Authenticated non-member | Concealed denial |
| T026-TC07 | Member of another Dataset | Concealed denial |
| T026-TC08 | Malformed Asset ID | Canonical safe malformed-ID response |
| T026-TC09 | Unknown Asset ID | Concealed `404` |
| T026-TC10 | Foreign Asset | Concealed `404` |
| T026-TC11 | IMAGE, AUDIO, or TEXT Asset | Concealed modality refusal |
| T026-TC12 | Malformed Label ID | Safe validation/refusal |
| T026-TC13 | Unknown Label | Safe refusal |
| T026-TC14 | Cross-Dataset Label | Safe refusal; no Track created |
| T026-TC15 | Unsupported `annotationType` | Strict validation failure |
| T026-TC16 | Unsupported `interpolationMode` | Strict validation failure |
| T026-TC17 | Browser supplies `revision` | Strict DTO rejection |
| T026-TC18 | Browser supplies `assetId`, `datasetId`, ownership fields | Strict DTO rejection |
| T026-TC19 | Browser supplies audit fields | Strict DTO rejection |
| T026-TC20 | Unknown extra field | Strict DTO rejection |

Success assertions:

- exactly one Track is created;
- revision equals `1`;
- no Annotation is created;
- no Job or JobEvent is created;
- no Redis/BullMQ mutation;
- no MinIO mutation;
- no provider access.

---

# 3. Track update matrix

Route:

`PATCH /api/video-object-tracks/[trackId]`

Run the matrix independently for:

1. rename;
2. relabel;
3. safe properties update;
4. interpolation-mode update.

| Test ID pattern | Actor/resource/request condition | Expected |
|---|---|---|
| T026-TU-*-01 | OWNER, valid Track/current revision | Success |
| T026-TU-*-02 | MANAGER, valid Track/current revision | Success |
| T026-TU-*-03 | REVIEWER, valid Track/current revision | Success |
| T026-TU-*-04 | LABELER | Policy denial |
| T026-TU-*-05 | Unauthenticated | `401` |
| T026-TU-*-06 | Authenticated non-member | Concealed denial |
| T026-TU-*-07 | Member of another Dataset | Concealed denial |
| T026-TU-*-08 | Malformed Track ID | Safe malformed-ID response |
| T026-TU-*-09 | Unknown Track | Concealed `404` |
| T026-TU-*-10 | Foreign Track | Concealed `404` |
| T026-TU-*-11 | Malformed `expectedTrackRevision` | Strict validation failure |
| T026-TU-*-12 | Stale revision on valid owned Track | `409 VIDEO_TRACK_REVISION_CONFLICT` |
| T026-TU-*-13 | Cross-Dataset Label during relabel | Safe refusal |
| T026-TU-*-14 | Unknown Label during relabel | Safe refusal |
| T026-TU-*-15 | Browser supplies revision/ownership/audit fields | Strict DTO rejection |
| T026-TU-*-16 | Unknown extra field | Strict DTO rejection |

Replace `*` with:

- `NAME`
- `LABEL`
- `PROPERTIES`
- `INTERPOLATION`

Success assertions:

- Track revision increments exactly once;
- only the intended field changes;
- keyframes remain unchanged.

Denial assertions:

- Track revision does not change;
- Track fields do not change.

---

# 4. Track delete matrix

Route:

`DELETE /api/video-object-tracks/[trackId]`

| Test ID | Actor/resource/request condition | Expected |
|---|---|---|
| T026-TD01 | OWNER, current revision | Success |
| T026-TD02 | MANAGER, current revision | Success |
| T026-TD03 | REVIEWER, current revision | Success |
| T026-TD04 | LABELER | Policy denial |
| T026-TD05 | Unauthenticated | `401` |
| T026-TD06 | Authenticated non-member | Concealed denial |
| T026-TD07 | Member of another Dataset | Concealed denial |
| T026-TD08 | Malformed Track ID | Safe malformed-ID response |
| T026-TD09 | Unknown Track | Concealed `404` |
| T026-TD10 | Foreign Track | Concealed `404` |
| T026-TD11 | Malformed `expectedTrackRevision` | Strict validation failure |
| T026-TD12 | Stale revision | `409 VIDEO_TRACK_REVISION_CONFLICT` |
| T026-TD13 | DELETE body contains extra field | Strict DTO rejection |
| T026-TD14 | Authorized deletion of Track containing keyframes | Track and keyframes deleted atomically |
| T026-TD15 | Denied deletion of Track containing keyframes | Track and every keyframe remain unchanged |

---

# 5. Keyframe create matrix

Route:

`POST /api/video-object-tracks/[trackId]/keyframes`

| Test ID | Actor/resource/request condition | Expected |
|---|---|---|
| T026-KC01 | OWNER, valid Track/current revision | Success |
| T026-KC02 | MANAGER, valid Track/current revision | Success |
| T026-KC03 | REVIEWER, valid Track/current revision | Success |
| T026-KC04 | LABELER, valid Track/current revision | Success |
| T026-KC05 | Unauthenticated | `401` |
| T026-KC06 | Authenticated non-member | Concealed denial |
| T026-KC07 | Member of another Dataset | Concealed denial |
| T026-KC08 | Malformed Track ID | Safe malformed-ID response |
| T026-KC09 | Unknown Track | Concealed `404` |
| T026-KC10 | Foreign Track | Concealed `404` |
| T026-KC11 | Track references non-VIDEO Asset | Concealed refusal |
| T026-KC12 | Negative `timestampMs` | Strict validation failure |
| T026-KC13 | `timestampMs` beyond authoritative duration | Safe temporal refusal |
| T026-KC14 | `frameIndex` supplied without `timestampMs` | Strict DTO rejection |
| T026-KC15 | Malformed geometry | Strict validation failure |
| T026-KC16 | `x < 0` | Strict validation failure |
| T026-KC17 | `y < 0` | Strict validation failure |
| T026-KC18 | `width <= 0` | Strict validation failure |
| T026-KC19 | `height <= 0` | Strict validation failure |
| T026-KC20 | `x + width > 1` | Strict validation failure |
| T026-KC21 | `y + height > 1` | Strict validation failure |
| T026-KC22 | `NaN` or `Infinity` | Strict validation failure |
| T026-KC23 | Malformed `expectedTrackRevision` | Strict validation failure |
| T026-KC24 | Stale revision | `409 VIDEO_TRACK_REVISION_CONFLICT` |
| T026-KC25 | Occupied timestamp with current revision | `409 VIDEO_KEYFRAME_TIMESTAMP_CONFLICT` |
| T026-KC26 | Browser supplies `trackId` | Strict DTO rejection |
| T026-KC27 | Browser supplies `assetId`, `datasetId`, `labelId`, `modality` | Strict DTO rejection |
| T026-KC28 | Browser supplies `revision` or `expectedRevision` | Strict DTO rejection |
| T026-KC29 | Browser supplies `isKeyframe` or `isInterpolated` | Strict DTO rejection |
| T026-KC30 | Browser supplies ownership or audit fields | Strict DTO rejection |

Successful keyframe creation:

- creates exactly one Annotation;
- persists `isKeyframe=true`;
- persists `isInterpolated=false`;
- uses canonical `timestampMs`;
- increments Track revision exactly once;
- does not use `Annotation.revision` as the concurrency authority.

Duplicate timestamp:

- Track revision remains unchanged after rollback;
- Annotation count remains unchanged;
- existing keyframe remains unchanged;
- response contains no Prisma `P2002`, SQL, or index name.

---

# 6. Keyframe PATCH actor matrix

Route:

`PATCH /api/video-keyframes/[annotationId]`

Run separately for:

1. geometry update;
2. `timestampMs` update;
3. safe properties update, only when already supported.

| Actor | Own keyframe | Another actor’s keyframe in same Dataset | Foreign Dataset keyframe |
|---|---|---|---|
| OWNER | Success | Success via `updateAny` | Concealed denial |
| MANAGER | Success | Success via `updateAny` | Concealed denial |
| REVIEWER | Success | Success via `updateAny` | Concealed denial |
| LABELER | Policy denial | Policy denial | Concealed denial |
| Authenticated non-member | Concealed denial | Concealed denial | Concealed denial |
| Other-Dataset member | Concealed denial | Concealed denial | Concealed denial |
| Unauthenticated | `401` | `401` | `401` |

---

# 7. Keyframe PATCH resource-kind matrix

The following must be individual tests.

| Test ID | `annotationId` resource kind/condition | Expected |
|---|---|---|
| T026-KP01 | Valid owned persisted VIDEO keyframe | Success |
| T026-KP02 | Malformed ID | Safe malformed-ID response |
| T026-KP03 | Unknown ID | Concealed `404` |
| T026-KP04 | Foreign keyframe | Concealed `404` |
| T026-KP05 | Temporal-label Annotation | Concealed `404`; temporal row unchanged |
| T026-KP06 | Image Annotation | Concealed `404`; Image row unchanged |
| T026-KP07 | VIDEO Annotation with `trackId=null` | Concealed `404` |
| T026-KP08 | Track-linked Annotation with `isKeyframe=false` | Concealed `404` |
| T026-KP09 | Track-linked Annotation with `isInterpolated=true` | Concealed `404` |
| T026-KP10 | Track-linked Annotation with `timestampMs=null` | Concealed `404` |
| T026-KP11 | Keyframe whose resolved Track belongs to foreign Dataset | Concealed `404` |
| T026-KP12 | Keyframe/Track belong to different Assets | Service-level PostgreSQL integrity test |
| T026-KP13 | Keyframe’s resolved Track references non-VIDEO Asset | Concealed/service-level test |
| T026-KP14 | Malformed `expectedTrackRevision` | Strict validation failure |
| T026-KP15 | Stale revision on valid owned keyframe | `409 VIDEO_TRACK_REVISION_CONFLICT` |
| T026-KP16 | Occupied target timestamp with current revision | `409 VIDEO_KEYFRAME_TIMESTAMP_CONFLICT` |
| T026-KP17 | Malformed geometry | Strict validation failure |
| T026-KP18 | Out-of-bounds geometry | Strict validation failure |
| T026-KP19 | Unsafe authority fields | Strict DTO rejection |
| T026-KP20 | Unknown extra field | Strict DTO rejection |

Wrong-kind/foreign assertions:

- response is not `200`;
- response does not expose Track revision;
- response is not `VIDEO_TRACK_REVISION_CONFLICT`;
- target Annotation remains unchanged;
- Track revision remains unchanged.

---

# 8. Keyframe DELETE matrix

Route:

`DELETE /api/video-keyframes/[annotationId]`

| Test ID | Actor/resource/request condition | Expected |
|---|---|---|
| T026-KD01 | OWNER, valid keyframe/current revision | Success |
| T026-KD02 | MANAGER, valid keyframe/current revision | Success |
| T026-KD03 | REVIEWER, valid keyframe/current revision | Success |
| T026-KD04 | LABELER | Policy denial |
| T026-KD05 | Unauthenticated | `401` |
| T026-KD06 | Authenticated non-member | Concealed denial |
| T026-KD07 | Member of another Dataset | Concealed denial |
| T026-KD08 | Malformed `annotationId` | Safe malformed-ID response |
| T026-KD09 | Unknown `annotationId` | Concealed `404` |
| T026-KD10 | Foreign keyframe | Concealed `404` |
| T026-KD11 | Temporal-label Annotation | Concealed `404`; temporal row remains |
| T026-KD12 | Image Annotation | Concealed `404`; Image row remains |
| T026-KD13 | VIDEO non-keyframe Annotation | Concealed `404` |
| T026-KD14 | Persisted interpolated fixture, when safely constructible | Concealed `404` |
| T026-KD15 | Cross-Dataset keyframe | Concealed `404` |
| T026-KD16 | Malformed `expectedTrackRevision` | Strict validation failure |
| T026-KD17 | Stale revision | `409 VIDEO_TRACK_REVISION_CONFLICT` |
| T026-KD18 | DELETE body contains extra fields | Strict DTO rejection |

Denied DELETE must preserve:

- keyframe existence;
- Track existence;
- Track revision;
- Annotation revision;
- sibling keyframes;
- Annotation count.

---

# 9. APPROVE B service-level integrity matrix

The public keyframe PATCH/DELETE routes do not accept `trackId`.

Complete these cases through the server-only service boundary and real
PostgreSQL.

| Test ID | Service-level condition | Expected |
|---|---|---|
| T026-S01 | Keyframe belongs to Track A but mutation attempts to use Track B authority | Rejected before revision claim |
| T026-S02 | Keyframe and Track belong to different Assets | Rejected |
| T026-S03 | Keyframe and Track belong to different Datasets | Rejected |
| T026-S04 | Revision from unrelated Track is used | Rejected |
| T026-S05 | Cross-resource validation failure | No Track revision increment |
| T026-S06 | Track deletion races with keyframe mutation | One atomic outcome |
| T026-S07 | Delete/update race | No orphan or resurrected keyframe |

Document:

- HTTP tests validate the canonical `annotationId` public contract.
- Service/PostgreSQL tests validate internal Track relationship integrity.
- No nested mutation route was added.

---

# 10. Shared denial snapshots

Every denial test or denial group must capture before and after:

| Surface | Required assertion |
|---|---|
| `VideoObjectTrack` | Count and target revision unchanged |
| `Annotation` | Count, target revision, and durable fields unchanged |
| Sibling keyframes | Unchanged |
| `Job` | Count unchanged |
| `JobEvent` | Count unchanged |
| Redis | DB `15`, prefix `fieldframe-phase019-test`, key count unchanged |
| BullMQ | waiting/active/delayed/completed/failed unchanged |
| MinIO | Exact object-key set under `phase019-video/` unchanged |
| GitHub fixture | Runtime counter delta `0` |
| Gitea | `N/A` with approved access-log compensating evidence |
| SourceConnection/provider | `N/A` with approved call-graph evidence |

---

# 11. Redaction assertions

Scan every success, validation, permission denial, concealed denial, revision
conflict, and duplicate-timestamp response.

The serialized response must not contain:

- `storageBucket`;
- `storageKey`;
- MinIO credentials;
- provider token;
- SourceConnection ciphertext;
- cookie;
- Authorization header;
- `DATABASE_URL`;
- Redis password;
- local filesystem path;
- `Prisma`;
- `P2002`;
- PostgreSQL error;
- SQL;
- constraint or index name;
- stack trace;
- raw provider response.

Foreign, unknown, and wrong-kind responses must not expose:

- resource existence;
- Track revision;
- Annotation revision;
- Dataset membership;
- Asset ownership;
- Track/Label relationship;
- authoritative duration;
- timestamp;
- geometry.

---

# 12. T026 completion gate

Mark T026 complete only when all conditions are satisfied:

| Gate | Required |
|---|---|
| Actor matrix | OWNER, MANAGER, REVIEWER, LABELER, non-member, other-Dataset member, unauthenticated covered |
| Track operations | Create, rename, relabel, properties, interpolation mode, delete covered |
| Keyframe operations | Create, geometry update, timestamp update, supported properties update, delete covered |
| Resource matrix | Malformed, unknown, foreign, wrong-kind, cross-Dataset, non-VIDEO covered |
| Keyframe canonical route | PATCH/DELETE by `annotationId` proven |
| Service integrity | APPROVE B service-level cross-Track tests pass |
| Conflict mapping | Stale and duplicate timestamp precedence proven |
| Side effects | Every denial has zero unintended PostgreSQL/Redis/BullMQ/MinIO/provider delta |
| Redaction | All response scans pass |
| Runtime | Current deployed Compose image used |
| Test result | Zero mandatory failures |
| Documentation | `tasks.md` and `quickstart.md` updated with exact evidence |

Do not mark T042 or Phase 019 complete as a result of completing T026.