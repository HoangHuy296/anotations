# T026 Track/Keyframe HTTP Coverage Ledger

Audited against `markdown.md` on 2026-07-30. “Covered” means a current
Compose HTTP or real-PostgreSQL test has executed; it does not mean that a
similarly named unit test exists.

| Test IDs | Existing evidence | Status | Missing assertion / action |
| --- | --- | --- | --- |
| TC01–TC05 | `video-track-keyframe.test.ts` — lifecycle and role matrix | Covered | Per-success external snapshot is grouped, not repeated per role. |
| TC06–TC14 | role/concealment, denial, validation matrix | Partial | Other-Dataset-member must be separated from foreign Dataset owner; add explicit create path where needed. |
| TC15–TC20 | validation matrix | Partial | Add annotation/interpolation/unknown-field strict cases if absent from route group. |
| TU-NAME-01…16 | role matrix + validation matrix | Partial | Relabel/properties/interpolation require the same complete actor and denial proof. |
| TD01–TD15 | service contract/race only, plus actor/malformed/unknown/stale HTTP DELETE matrix in `video-track-keyframe.test.ts` | Partial | Actor policy, malformed/unknown ID, and stale-revision cases are covered over HTTP; explicit keyframe-cascade-on-Track-delete assertion still open. |
| KC01–KC30 | lifecycle, role, validation matrix | Partial | Add distinct non-member/other-dataset cases and remaining unsafe authority fields. |
| KP01–KP06, KP11 | lifecycle, validation, `video-keyframe-resource-kind.test.ts` | Covered | Canonical annotationId PATCH is runtime-proven. |
| KP07–KP10, KP13 | No dedicated route-kind test | Missing | Add persisted malformed-kind fixture tests, only through HTTP route. |
| KP12 | `video-track-race.test.ts` relationship/atomic cases, plus explicit mismatched-Asset/Track integrity fixture | Covered | — |
| KP14–KP20 | validation and lifecycle matrix | Partial | Current/stale/duplicate covered; add all strict DTO groups only if absent. |
| KD01–KD18 | temporal/image/foreign DELETE resource tests, plus actor/concealment/malformed/unknown/stale DELETE matrix in `video-track-keyframe.test.ts` | Partial | Actor, malformed/unknown, and stale-revision cases are covered; wrong-kind persisted-row matrix (beyond the KP12 mismatched-Asset case) still open. |
| S01–S07 | `video-track-race.test.ts`, including explicit mismatched-Asset/Track integrity test | Covered | Atomic/race outcomes and mismatched-Asset/Track integrity are both proven. |
| Shared snapshots/redaction | external-snapshot helpers in all HTTP suites; resource-kind suite | Covered for executed denial groups | Preserve per-group snapshots for each new denial group. |

## Reused evidence

- `video-track-keyframe.test.ts`: 6 passed, 0 failed (verified against the live dev stack, `VIDEO_ANNOTATION_HTTP_TESTS=1`, 2026-08-06). Added test 6, "Track and keyframe DELETE actor matrix is authorized, concealed for foreign/non-member, and safe against malformed or stale input".
- `video-keyframe-resource-kind.test.ts`: 6 passed, 0 failed (current Compose image).
- `video-track-race.test.ts`: 11 passed, 0 failed (verified against the live dev stack, `VIDEO_ANNOTATION_RACE_TESTS=1`, 2026-08-06). Added test 11, "keyframe update/delete refuses a persisted row whose Asset does not match its Track's video Asset".

This ledger is an implementation control document, not task completion
evidence. T026 remains open until every `Partial` and `Missing` row is green;
the DELETE actor matrix (TD01–TD15, KD01–KD18) and the mismatched-Asset/Track
integrity fixture (KP12, S01–S07) added here close the ledger's
highest-priority gaps but do not close every remaining `Partial` row.
