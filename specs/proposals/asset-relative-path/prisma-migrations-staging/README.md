# Durable migration-history staging (Phase 027)

**Not applied. Not inside `prisma/migrations/`.** This directory mirrors, folder-for-folder, exactly what will be moved into the real `prisma/migrations/` at the moment each phase is executed, so that `prisma migrate deploy` — not a bare `psql -f` — is the actual execution command, and Prisma's own `_prisma_migrations` tracking table records these changes like any other migration. A change applied only via `psql` and never recorded in `_prisma_migrations` would make this environment (and any fresh environment built from `prisma migrate deploy`) permanently drift from what Prisma believes the schema is — this staging plan exists specifically to avoid that.

## Why two folders, and why BACKFILL has no folder here

- **`EXPAND1_add_asset_relative_path/`** — the additive column. Expressible in `schema.prisma` (a plain nullable `String?` field), so this migration is generated the normal way.
- **`ENFORCE_asset_relative_path_guard/`** — the CHECK constraint, the trigger function, and the trigger itself. **Not expressible in `schema.prisma`'s DSL** (Prisma has no first-class concept for either) — this is Prisma's own documented "custom SQL migration" pattern: a hand-authored `migration.sql` in a normally-named folder, applied and tracked by `prisma migrate deploy` exactly like a generated one.
- **BACKFILL has no folder here, deliberately.** It is a one-time *data* operation (`scripts/027-backfill-relative-path.ts`), not a schema change. Prisma's own guidance is to keep data backfills out of `migration.sql` files — they can be slow, need custom branching logic (this one does: three-way source resolution, per-row normalization), and don't belong in the DDL-only history Prisma's migration tooling assumes. This is already how the script is built; nothing changes here.

## Exact execution sequence (each step is what actually runs, not illustrative)

**EXPAND-1:**
1. Apply the `schema.prisma` diff below (a real, saved-to-disk edit, not yet made).
2. `mv specs/proposals/asset-relative-path/prisma-migrations-staging/EXPAND1_add_asset_relative_path prisma/migrations/<real-timestamp>_add_asset_relative_path` (the folder name's leading timestamp must be assigned at the actual moment of execution, per Prisma's own convention — the placeholder name here is not a real migration id).
3. `npx prisma migrate deploy`.
4. Post-DDL verification queries (spec §10).

**ENFORCE** (after BACKFILL, inside the quiescence window):
1. `mv specs/proposals/asset-relative-path/prisma-migrations-staging/ENFORCE_asset_relative_path_guard prisma/migrations/<real-timestamp>_asset_relative_path_guard`.
2. `npx prisma migrate deploy`.
3. Trigger-verification queries + `scripts/027-verify-trigger.ts` (spec §10).

## `schema.prisma` diff (prepared, not yet applied)

One field added to the existing `Asset` model, alphabetically placed near the other `source*`/`storage*` fields for consistency with the model's existing layout — exact insertion point to be confirmed against the model's current state at execution time, since other unrelated fields may have been added to `Asset` between now and then:

```prisma
model Asset {
  // ...existing fields unchanged...
  relativePath String?
  // ...existing fields unchanged...
}
```

No other `schema.prisma` change. The CHECK constraint and trigger are never represented in `schema.prisma` — this is an accepted, standard Prisma limitation for this kind of constraint, not an oversight. A future `prisma db pull`/introspection may show them as unmapped in a comment; that is expected and does not indicate drift.
