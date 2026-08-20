# Phase 011 Validation Quickstart

## Prerequisites

- Phase 010 is approved and Compose PostgreSQL, MinIO, Redis, web, and worker are healthy.
- At least one authenticated Dataset contains IMAGE Assets with dimensions and a readable authorized view capability.
- Test users cover owner/manager/reviewer/labeler/non-member roles under the current Dataset permission matrix.
- Do not print credentials, cookies, provider tokens, storage keys, full view URLs, or database URLs in commands or evidence.

## UI testing account creation

The approved browser authentication flow is **`/register` → `/api/auth/signup`
→ opaque HTTP-only cookie → PostgreSQL `AuthSession`**. There is deliberately
no `/api/auth/register` alias: `/api/auth/signup` is the public registration
contract used by the existing application. Login uses `/login` and
`/api/auth/login`.

1. Open `/register` in a browser and create a new account with an email and a
   password. An optional display name may be supplied.
2. Registration writes a PostgreSQL `User` with a password hash, defaults its
   system role to `LABELER`, creates a PostgreSQL `AuthSession`, and sets only
   the opaque HTTP-only session cookie. The response never exposes a password,
   password hash, or session value.
3. Use the visible **Sign out** control, then open `/login` and authenticate
   with the same email/password. This is the only approved local UI auth path;
   do not use `DEV_AUTH_EMAIL` as a bypass.

### Promote a local account for Image MVP testing

A new `LABELER` cannot create or manage a Dataset alone. For local-only Image
MVP setup, promote the account you just registered to `MANAGER` in the local
Compose PostgreSQL database. Replace only the placeholder locally; do not add
real credentials to repository files or documentation.

```bash
docker compose exec postgres psql -U fieldframe -d fieldframe -c \
'UPDATE "User" SET role = '\''MANAGER'\'' WHERE email = '\''YOUR_EMAIL_HERE'\'';'
```

Then create or use an IMAGE Dataset through the approved Dataset/upload/import
flow, upload IMAGE Assets, and open its shared `/workspace/[datasetId]` route.
Membership controls access to an existing Dataset; promotion does not grant
access to every Dataset.

`SEED_ADMIN_EMAIL` alone is not a browser login credential: `prisma/seed.ts`
does not assign a `passwordHash`. It must not be treated as a login account.

### Manual browser smoke checklist

- Open `/register` and create a user.
- Confirm its `User.passwordHash` is non-null and its `AuthSession` exists.
- Sign out, open `/login`, then sign in with the same credentials.
- Confirm `/api/auth/me` returns only the safe user profile.
- Promote the account locally to `MANAGER` if Dataset creation is required.
- Prepare an IMAGE Dataset and open the workspace.
- Confirm `DEV_AUTH_EMAIL` was not used.

The following local inspection queries show metadata only; they never reveal a
password, session cookie, or token:

```bash
docker compose exec postgres psql -U fieldframe -d fieldframe -c \
'SELECT id, email, role, "passwordHash" IS NOT NULL AS has_password, "createdAt" FROM "User" ORDER BY "createdAt" DESC LIMIT 10;'

docker compose exec postgres psql -U fieldframe -d fieldframe -c \
'SELECT id, "userId", "expiresAt", "revokedAt", "createdAt" FROM "AuthSession" ORDER BY "createdAt" DESC LIMIT 10;'
```

## Validation sequence

Focused Feature 011 test command (it does not print credentials):

```bash
pnpm --filter @annotationplatform/web test:workspace
```

For real PostgreSQL evidence, run the same suite with the explicit opt-in:

```bash
WORKSPACE_INTEGRATION_TESTS=1 pnpm --filter @annotationplatform/web test:workspace
```

2026-07-17 PostgreSQL evidence: `WORKSPACE_INTEGRATION_TESTS=1 pnpm --filter
@annotationplatform/web test:workspace` passed 5/5 against the controlled Compose
database. The explicitly approved migration
`20260717134447_align_annotation_revision` aligned `Annotation.version` to
`Annotation.revision`; it resets old lock values to `1` rather than preserving
historical values.

## 2026-07-21 completion validation record

The following non-secret commands were run against the controlled local Compose
PostgreSQL and MinIO services. Authentication used the normal opaque HTTP-only
cookie flow; no auth bypass or browser-readable JWT was enabled.

```bash
pnpm --filter @annotationplatform/web typecheck
pnpm --filter @annotationplatform/web lint
pnpm --filter @annotationplatform/web build
WORKSPACE_INTEGRATION_TESTS=1 AUTH_PAGE_HTTP_INTEGRATION_TESTS=1 MINIO_VIEW_INTEGRATION_TESTS=1 pnpm --filter @annotationplatform/web test:workspace
pnpm --filter @annotationplatform/web test:auth-ownership
```

Results: typecheck, lint, and production build passed. The workspace run passed
26/26 tests, including normal login/logout/revoked-session HTTP flow, the
authorized MinIO view-capability test, optimistic-lock tests, image navigation,
label guard, and no-side-effect authorization cases. The existing
auth-ownership run passed 13/13 tests. Test output and this record intentionally
exclude passwords, cookie values, database URLs, storage keys, credentials, and
presigned URLs.

The local UI-account follow-up was also validated with the normal `/register`
page contract (`/api/auth/signup`) and `/login`: the targeted real PostgreSQL
auth run passed 4/4 tests for password-hash/default-role/session creation,
passwordless seeded-user refusal, safe `/api/auth/me`, logout revocation, and
response redaction.

Scope audit: this feature introduced no dependency, queue/Redis workspace state,
public worker route, binary database field, modality-specific workspace route,
or SourceConnection/Gitea behavior. The earlier approved revision-alignment
migration is the only Phase 011 schema change and is not modified further.

1. Open a protected application URL without a session. Verify redirect to login and rejection of an external/malformed return target.
2. Register a new user through the public page, verify it reaches the intended internal destination, sign out, and verify the protected URL redirects to login again.
3. Sign in as an existing user through the login page. Verify no password/session credential appears in page state or response and an already-authenticated visitor is redirected away from public auth pages.
4. Open a Dataset workspace as an authorized actor and select an IMAGE Asset.
5. Verify the image preview uses an authorized short-lived view capability and that private storage fields are absent from browser-facing data.
6. Draw a non-zero bounding box, assign an existing label, wait for the 1.5-second quiet interval, and reload. Confirm normalized geometry and a current annotation version.
7. Pan and zoom, then move and resize the box. Confirm only geometry changes; label/type/status/properties remain unchanged.
8. Relabel the box and verify geometry remains byte-for-byte equivalent.
9. Select from canvas and Shapes list, delete an annotation with its current version, and verify it no longer appears after reload.
10. Open the same annotation in two authenticated sessions. Save session A, submit stale session B, and verify a conflict/no overwrite/local draft preservation.
11. Repeat the same two-session test for Asset description using Asset revision.
12. Verify default label creation is idempotent, custom-label creation/removal follows permission rules, and a referenced label cannot be removed.
13. Create or fixture at least 250 IMAGE Assets. Search for a filename outside the first 100, verify result paging and previous/next navigation, and inspect status/batch display.
14. Execute owner/manager/reviewer/labeler/non-member denial tests for read, create, own/any update, relabel, delete, description, taxonomy, view capability, and cross-Dataset ids. Verify denied requests produce no durable, storage, queue, or event side effect.
15. Run lint/typecheck/build and the focused auth/workspace test suite once tasks define its exact command. Record only non-secret evidence.

## Expected outcomes

- Geometry is normalized to original image dimensions; viewport transforms do not persist.
- Every successful guarded annotation/description save returns its new current version/revision.
- Every stale save is rejected and cannot silently overwrite newer state.
- Image Assets, Labels, Annotations, descriptions, and navigation remain Dataset-scoped.
- Public authentication pages establish only the existing opaque HTTP-only
  session; neither JWT nor session credential enters browser-visible state.
- No schema migration, new package, Redis Job state, binary database field, or provider credential exposure is introduced.

## Known MVP limitations

- Only axis-aligned bounding boxes are editable. Polygon, circle, point,
  polyline, segmentation, keypoints, and review workflow changes remain out of
  scope.
- The browser keeps only ephemeral viewport, selection, draft, and autosave
  state. Refresh is the explicit conflict-reconciliation path; it never
  force-writes a stale annotation or description.
- The right Images tab mirrors the current safe page; full-Dataset search and
  pagination remain in the primary left image sidebar.
