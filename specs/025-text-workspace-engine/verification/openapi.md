# T160 — Swagger UI generation and openapi-contract tests

Date: 2026-09-24. Real, live dev-stack `web` container (already running, healthy) used as the target for the gated contract tests.

## Swagger UI generation

```
$ pnpm run docs:swagger-ui
Generated Swagger UI documentation page: specs/api/dist/index.html
```

PASS.

## `apps/web/tests/openapi-contract/` (gated, against the real running service)

```
$ OPENAPI_CONTRACT_TESTS=1 npm run test:openapi-contract
1..16
# pass 15, fail 1
```

**One failure found, investigated, fixed where in-scope, one left as an honestly-reported pre-existing gap:**

1. **Fixed** (in scope -- direct consequence of this session's own T043 generic-reader fix): `annotations.contract.test.ts`'s `ANNOTATION_KEYS` still listed the pre-fix key set and rejected the now-correct `fromAnnotationId`/`toAnnotationId` fields as unexpected. Updated the test's expected key list to match the corrected `Annotation` schema (see [openapi-validation.md](openapi-validation.md)). Re-ran: passes.

2. **Not fixed, pre-existing, out of scope**: `authentication.contract.test.ts`'s "GET /api/auth/me ... echoes the same AuthenticatedUser shape" still fails -- the live `/api/auth/me` response includes a `preferences` field that neither the documented `AuthenticatedUser` schema nor this test's expected key list account for. This is unrelated to the TEXT feature (never touched `/api/auth/me`, `AuthenticatedUser`, or user-preferences code this session) and is a pre-existing drift in the *existing* documentation, of the same class as T171's `change-status.test.ts` finding -- flagged for the repository owner's attention rather than silently omitted or fixed as unauthorized scope creep on top of an already-large closure pass.

**Result**: PASS for everything TEXT-related and for the generic-annotation regression this session's own fix required; one unrelated pre-existing gap found and reported, not caused by this feature.
