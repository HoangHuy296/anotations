# Proposed corrective-manifest revision — review required

2026-09-30. **Proposal only.** Frozen `recovery.review.sql` remains byte-for-byte unchanged at SHA-256 `b5be6dcf4cec4b87b4e6b150bdd41f71794dbdcbb57a44d3d606e9abc8cb73ac`. No revised migration was created or executed. Application recovery remains blocked.

## Finding

The manifest's first UNION branch selects `c.relname AS name`, a PostgreSQL `name` value. The UNION result also has type `name` (confirmed with `pg_typeof`), so longer identifiers composed by later branches are truncated to the server's 63-byte identifier limit. This affects the in-transaction manifest function itself; changing the JavaScript comparison cannot restore discarded identity information.

Three collision groups identify ten **distinct index attributes**. They are real, valid database objects; their catalog identities `(pg_class OID, attribute number)` differ. The collision is caused by manifest serialization, not duplicate database objects. Some colliding attributes have identical shapes, so adding `shape` as a sort tie-breaker would not restore unambiguous object identification.

Do not solve this by suppressing equality checks, deduplicating entries, dropping index attributes from the manifest, accepting counts only, or changing only an external hash/sort. The frozen SQL must be revised and rehearsed again.

## Exact proposed design changes

1. Preserve the entire existing object inventory, property payloads, Phase029 subtraction filters, lock protocol, RLS checks, receipt checks, row fingerprints, history checks and RESTRICT-only drops.
2. Replace the `name` field with an unbounded **text** serialization of a structured identity. The first branch must explicitly select text. Keep the outer record `[kind, identityText, shape]`; `identityText` is a JSON array serialized to text.
3. Use explicit schema and separate components, so names containing `.` or quotes cannot collide by concatenation. Do not use cluster-specific OIDs as durable manifest identities; they are used only for this investigation's evidence.
4. Order by `kind COLLATE "C", name COLLATE "C"`, after verifying uniqueness of `(kind,name)`.
5. Convert the **temporary** manifest helper from LANGUAGE sql to LANGUAGE plpgsql, compute the same manifest JSONB into a local variable, and raise `RECOVERY_MANIFEST_IDENTITY_COLLISION` if any `(kind,name)` appears twice. Every call (current schema, expected post-schema, actual post-schema) must enforce uniqueness before returning.
6. Keep the existing strict `actual_schema IS DISTINCT FROM expected_after_schema` transaction-abort gate. No fallback comparison or exception bypass.

Proposed identity components (each encoded with `jsonb_build_array(...)::text`):

| Kind | Components |
| --- | --- |
| relation/index/type/sequence | `[schema, objectName]` |
| column | `[schema, relationName, columnName]` |
| constraint | `[schema, "relation" or "domain", qualifiedOwnerIdentity, constraintName]` |
| trigger/policy/rule | `[schema, relationName, objectName]` |
| routine | `[schema, regprocedureSignature]` including all identity argument types |
| enum value | `[schema, enumTypeName, enumLabel]` |

Examples of exact SELECT expressions:

```sql
SELECT 'relation'::text AS kind,
       jsonb_build_array(n.nspname::text, c.relname::text)::text AS name,
       -- existing shape expression, unchanged

SELECT 'column',
       jsonb_build_array(n.nspname::text, c.relname::text, a.attname::text)::text,
       -- existing shape expression, unchanged
```

Constraint ownership must use `CASE WHEN c.conrelid <> 0 THEN ... ELSE ... END`, distinguishing relation and domain ownership explicitly. Do not rely on COALESCE of a zero-OID regclass rendering.

Proposed helper control flow (review design, not installed SQL):

```sql
DECLARE manifest jsonb;
BEGIN
  -- Existing object branches with only the reviewed identity expressions changed.
  WITH objects AS (...)
  SELECT coalesce(jsonb_agg(jsonb_build_array(kind,name,shape)
           ORDER BY kind COLLATE "C",name COLLATE "C"),'[]'::jsonb)
    INTO manifest FROM objects;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(manifest) AS e(value)
    GROUP BY value->0, value->1 HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'RECOVERY_MANIFEST_IDENTITY_COLLISION';
  END IF;
  RETURN manifest;
END;
```

Only the temporary verification helper changes; the permanent removal set remains four columns, two constraints, three triggers and three functions. Its approved column-owned default disappears with its column as before.

## Evidence and required next review

Read-only SELECTs implementing the proposed identity projection produced **1,841 entries and 1,841 unique identities**, with text type, deterministic C-collation ordering after reversing input, and distinct keys for dotted identifier components. No CREATE FUNCTION, DDL or application write was used. See [investigation](../../029-modality-specific-datasets/verification/manifest-investigation.md).

This is **not** a migration rehearsal or approval for execution. Required next steps, only after approval of this proposal:

- Prepare revised SQL; publish a new SHA-256 and exact diff. Keep the old accepted checksum/evidence as historical receipts.
- Update verification expectations to the new identity contract; never auto-adopt a changed checksum.
- Repeat all seven accepted disposable scenarios through Prisma plus uniqueness/long-name/dotted-name/permuted-input checks. Prove the new collision gate aborts on deliberately duplicated identities and all existing safety gates remain effective.
- Re-run application read-only preflight; then request separate execution approval.

No application recovery is ready for approval until those steps pass.
