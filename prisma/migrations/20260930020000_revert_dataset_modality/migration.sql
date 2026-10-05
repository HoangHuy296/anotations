-- REVIEW ONLY: NO EXECUTION APPROVAL. Use as a NEW Prisma corrective migration.
-- Do not edit the applied original migration or _prisma_migrations manually.
-- Transactional DDL; no CASCADE; no application-row DML; helper objects are temporary.
-- Execution requires stopped/drained application writers, a reviewed target identity,
-- no concurrent migrations, and captured migration output. Lock timeout aborts safely.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off; -- Fail rather than silently fingerprint RLS-filtered rows.

-- Locks freeze all public application tables, not just Dataset/Asset. This protects
-- exact row/content comparisons and prevents side effects racing with validation.
DO $gate$
DECLARE r record;
BEGIN
  IF current_database() <> 'fieldframe' THEN
    RAISE EXCEPTION 'RECOVERY_WRONG_DATABASE';
  END IF;
  -- Host/port alone inside a container do not identify an instance. The runner
  -- must separately confirm Prisma's effective URL and server identity BEFORE SQL.
  IF EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D') THEN
    RAISE EXCEPTION 'RECOVERY_REVIEW_ENABLED_EVENT_TRIGGERS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relkind IN ('p','f')) THEN
    RAISE EXCEPTION 'RECOVERY_REVIEW_PARTITIONED_OR_FOREIGN_TABLES';
  END IF;
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relkind='r' AND c.relname <> '_prisma_migrations'
           ORDER BY c.relname LOOP
    EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', r.relname);
  END LOOP;
  -- Conservative full-row visibility gate: reject RLS even for bypass/owner roles.
  -- Locks above prevent table policy flags changing during the fingerprint checks.
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname <> '_prisma_migrations'
        AND (c.relrowsecurity OR c.relforcerowsecurity
             OR NOT has_table_privilege(current_user,c.oid,'SELECT'))) THEN
    RAISE EXCEPTION 'RECOVERY_FULL_ROW_VISIBILITY_UNPROVEN';
  END IF;
  IF (SELECT count(*) FROM public._prisma_migrations
      WHERE migration_name='20260930010000_dataset_modality'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'RECOVERY_ORIGINAL_MIGRATION_STATE_UNEXPECTED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public._prisma_migrations
      WHERE migration_name='20260930010000_dataset_modality'
        AND checksum='9141d2df6d2ece287a36633548bbd9a32678f1b0a561d1b7014631f86bf8e4ce') THEN
    RAISE EXCEPTION 'RECOVERY_ORIGINAL_MIGRATION_CHECKSUM_MISMATCH';
  END IF;
END;
$gate$;

-- PostgreSQL itself canonicalizes the expected column defaults and CHECK bodies.
CREATE TEMP TABLE phase029_expected_shape (
  "modality" public."Modality",
  "modalityContentRevision" bigint NOT NULL DEFAULT 0,
  "modalityResolvedAt" timestamp(3),
  "modalityResolverSubject" text,
  CONSTRAINT dataset_modality_resolution_shape CHECK (
    ("modality" IS NULL AND "modalityResolvedAt" IS NULL AND "modalityResolverSubject" IS NULL)
    OR ("modality" IS NOT NULL AND "modalityResolvedAt" IS NOT NULL
        AND "modalityResolverSubject" IS NOT NULL AND length("modalityResolverSubject") BETWEEN 1 AND 128)
  ),
  CONSTRAINT dataset_modality_revision_nonnegative CHECK ("modalityContentRevision" >= 0)
) ON COMMIT DROP;

DO $shape$
DECLARE expected jsonb; actual jsonb; r record;
BEGIN
  SELECT jsonb_agg(jsonb_build_array(a.attname, a.atttypid, a.atttypmod,
           a.attnotnull, a.attcollation, a.attidentity, a.attgenerated,
           pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attname)
    INTO expected FROM pg_attribute a LEFT JOIN pg_attrdef d
    ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='pg_temp.phase029_expected_shape'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  SELECT jsonb_agg(jsonb_build_array(a.attname, a.atttypid, a.atttypmod,
           a.attnotnull, a.attcollation, a.attidentity, a.attgenerated,
           pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attname)
    INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d
    ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public."Dataset"'::regclass AND a.attnum>0 AND NOT a.attisdropped
      AND a.attname IN ('modality','modalityContentRevision','modalityResolvedAt','modalityResolverSubject');
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'RECOVERY_COLUMN_SHAPE_MISMATCH'; END IF;
  SELECT jsonb_agg(jsonb_build_array(conname,contype,convalidated,condeferrable,
          condeferred,pg_get_constraintdef(oid)) ORDER BY conname) INTO expected
    FROM pg_constraint WHERE conrelid='pg_temp.phase029_expected_shape'::regclass;
  SELECT jsonb_agg(jsonb_build_array(conname,contype,convalidated,condeferrable,
          condeferred,pg_get_constraintdef(oid)) ORDER BY conname) INTO actual
    FROM pg_constraint WHERE conrelid='public."Dataset"'::regclass
      AND conname IN ('dataset_modality_resolution_shape','dataset_modality_revision_nonnegative');
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'RECOVERY_CONSTRAINT_SHAPE_MISMATCH'; END IF;
  FOR r IN SELECT * FROM (VALUES
    ('phase029_guard_dataset_insert', 'f8732461a9f1acc59cfd278233f79289'),
    ('phase029_guard_dataset_assignment', '6a4849509088e4e01eb823261564917a'),
    ('phase029_guard_asset_write', '40439898fa4308ad2dd046557a5d9cc6')
  ) AS x(name,body_md5) LOOP
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND p.proname=r.name
        AND p.pronargs=0 AND p.prorettype='trigger'::regtype AND p.prokind='f'
        AND l.lanname='plpgsql' AND NOT p.prosecdef AND NOT p.proisstrict
        AND p.provolatile='v' AND p.proparallel='u' AND p.proconfig IS NULL
        AND md5(p.prosrc)=r.body_md5) <> 1
      OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname=r.name) <> 1 THEN
      RAISE EXCEPTION 'RECOVERY_FUNCTION_SHAPE_MISMATCH: %', r.name;
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM (VALUES
    ('Dataset','dataset_modality_insert_guard','phase029_guard_dataset_insert',7),
    ('Dataset','dataset_modality_assignment_guard','phase029_guard_dataset_assignment',19),
    ('Asset','asset_modality_write_guard','phase029_guard_asset_write',31)
  ) AS x(tab,name,fn,bits) LOOP
    IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid=format('public.%I',r.tab)::regclass
        AND t.tgname=r.name AND t.tgfoid=to_regprocedure(format('public.%I()',r.fn))
        AND t.tgtype=r.bits AND NOT t.tgisinternal AND t.tgenabled='O'
        AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint=0
        AND t.tgnargs=0 AND octet_length(t.tgargs)=0 AND t.tgattr=''::int2vector
        AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL) <> 1 THEN
      RAISE EXCEPTION 'RECOVERY_TRIGGER_SHAPE_MISMATCH: %', r.name;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public."Dataset" WHERE "modality" IS NOT NULL
       OR "modalityResolvedAt" IS NOT NULL OR "modalityResolverSubject" IS NOT NULL) THEN
    RAISE EXCEPTION 'RECOVERY_BLOCKED_RESOLUTION_OR_RECEIPT_EXISTS';
  END IF;
  -- Non-zero fence values are allowed: ordinary successful Asset writes can bump them.
END;
$shape$;

-- Logical public-schema manifest. Ignore physical OIDs/statistics/dropped-column
-- tombstones; include definitions, ownership, ACLs, comments, policies and sequences.
-- expected_after=true subtracts ONLY the exact objects verified above.
CREATE FUNCTION pg_temp.phase029_schema_manifest(expected_after boolean) RETURNS jsonb
LANGUAGE plpgsql AS $manifest$
DECLARE manifest jsonb;
BEGIN
WITH objects AS (
  SELECT 'relation'::text AS kind, jsonb_build_array(n.nspname::text,c.relname::text)::text AS name,
    jsonb_build_array(c.relkind,c.relpersistence,c.relowner,c.relacl,c.reloptions,
      c.relrowsecurity,c.relforcerowsecurity,obj_description(c.oid,'pg_class'),
      CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid) END) AS shape
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'column',jsonb_build_array(n.nspname::text,c.relname::text,a.attname::text)::text,
    jsonb_build_array(format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,
      a.attgenerated,a.attcollation,a.attacl,pg_get_expr(d.adbin,d.adrelid),col_description(c.oid,a.attnum))
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
      AND NOT (expected_after AND c.relname='Dataset' AND a.attname IN
        ('modality','modalityContentRevision','modalityResolvedAt','modalityResolverSubject'))
  UNION ALL
  SELECT 'constraint',jsonb_build_array(n.nspname::text,CASE WHEN c.conrelid<>0 THEN 'relation' ELSE 'domain' END,CASE WHEN c.conrelid<>0 THEN c.conrelid::regclass::text ELSE c.contypid::regtype::text END,c.conname::text)::text,
    jsonb_build_array(pg_get_constraintdef(c.oid),c.convalidated,c.condeferrable,c.condeferred)
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'
    AND NOT (expected_after AND c.conrelid='public."Dataset"'::regclass AND c.conname IN
      ('dataset_modality_resolution_shape','dataset_modality_revision_nonnegative'))
  UNION ALL
  SELECT 'index',jsonb_build_array(n.nspname::text,c.relname::text)::text,to_jsonb(pg_get_indexdef(c.oid)) FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('i','I')
  UNION ALL
  SELECT 'trigger',jsonb_build_array(n.nspname::text,c.relname::text,t.tgname::text)::text,jsonb_build_array(pg_get_triggerdef(t.oid),t.tgenabled)
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal AND NOT (expected_after AND
      ((c.relname='Dataset' AND t.tgname IN ('dataset_modality_insert_guard','dataset_modality_assignment_guard'))
        OR (c.relname='Asset' AND t.tgname='asset_modality_write_guard')))
  UNION ALL
  SELECT 'routine',jsonb_build_array(n.nspname::text,p.oid::regprocedure::text)::text,jsonb_build_array(pg_get_functiondef(p.oid),p.proowner,p.proacl,obj_description(p.oid,'pg_proc'))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p')
      AND NOT (expected_after AND p.pronargs=0 AND p.proname IN
        ('phase029_guard_dataset_insert','phase029_guard_dataset_assignment','phase029_guard_asset_write'))
  UNION ALL
  SELECT 'type',jsonb_build_array(n.nspname::text,t.typname::text)::text,jsonb_build_array(t.typtype,t.typowner,t.typacl,t.typbasetype,
    t.typtypmod,t.typnotnull,t.typdefault,obj_description(t.oid,'pg_type'))
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'enum',jsonb_build_array(n.nspname::text,t.typname::text,e.enumlabel)::text,to_jsonb(e.enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
    JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'policy',jsonb_build_array(n.nspname::text,c.relname::text,p.polname::text)::text,jsonb_build_array(p.polcmd,p.polpermissive,p.polroles,
    pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) FROM pg_policy p
    JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'sequence',jsonb_build_array(n.nspname::text,c.relname::text)::text,to_jsonb(s)-'seqrelid' FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'rule',jsonb_build_array(n.nspname::text,c.relname::text,r.rulename::text)::text,to_jsonb(pg_get_ruledef(r.oid)) FROM pg_rewrite r
    JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
)
SELECT coalesce(jsonb_agg(jsonb_build_array(kind,name,shape)
  ORDER BY kind COLLATE "C",name COLLATE "C"),'[]'::jsonb) INTO manifest FROM objects;
IF EXISTS (
  SELECT 1 FROM jsonb_array_elements(manifest) AS e(value)
  GROUP BY value->0,value->1 HAVING count(*) > 1
) THEN
  RAISE EXCEPTION 'RECOVERY_MANIFEST_IDENTITY_COLLISION';
END IF;
RETURN manifest;
END;
$manifest$;

-- Hash row content without printing it. Dataset's four disposable Phase029 fields
-- are excluded from the invariant hash; every other application field is included.
CREATE FUNCTION pg_temp.phase029_rows() RETURNS jsonb LANGUAGE plpgsql AS $rows$
DECLARE r record; result jsonb := '{}'::jsonb; tally bigint; fingerprint text; expression text;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relkind='r' AND c.relname <> '_prisma_migrations' ORDER BY c.relname LOOP
    expression := CASE WHEN r.relname='Dataset' THEN
      'to_jsonb(x) - ARRAY[''modality'',''modalityContentRevision'',''modalityResolvedAt'',''modalityResolverSubject'']'
      ELSE 'to_jsonb(x)' END;
    EXECUTE format($query$SELECT count(*), md5(coalesce(string_agg(h, '' ORDER BY h), '')) FROM
      (SELECT md5((%s)::text) AS h FROM public.%I x) hashes$query$,expression,r.relname) INTO tally,fingerprint;
    result := result || jsonb_build_object(r.relname,jsonb_build_object('rows',tally,'content_md5',fingerprint));
  END LOOP;
  RETURN result;
END;
$rows$;
CREATE TEMP TABLE phase029_recovery_evidence ON COMMIT DROP AS SELECT
  pg_temp.phase029_schema_manifest(false) AS before_schema,
  pg_temp.phase029_schema_manifest(true) AS expected_after_schema,
  pg_temp.phase029_rows() AS before_rows,
  (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM public._prisma_migrations m
    WHERE migration_name='20260930010000_dataset_modality') AS original_migration;

DO $before$
DECLARE e record; fence jsonb;
BEGIN
  SELECT * INTO e FROM pg_temp.phase029_recovery_evidence;
  SELECT jsonb_build_object('nonzero_datasets',count(*) FILTER (WHERE "modalityContentRevision"<>0),
    'min',min("modalityContentRevision"),'max',max("modalityContentRevision"),'sum',sum("modalityContentRevision"))
    INTO fence FROM public."Dataset";
  RAISE NOTICE 'RECOVERY_BEFORE schema_md5=% expected_after_md5=% tables=% fence=%',
    md5(e.before_schema::text),md5(e.expected_after_schema::text),e.before_rows,fence;
END;
$before$;

DROP TRIGGER asset_modality_write_guard ON public."Asset" RESTRICT;
DROP TRIGGER dataset_modality_assignment_guard ON public."Dataset" RESTRICT;
DROP TRIGGER dataset_modality_insert_guard ON public."Dataset" RESTRICT;
DROP FUNCTION public.phase029_guard_asset_write() RESTRICT;
DROP FUNCTION public.phase029_guard_dataset_assignment() RESTRICT;
DROP FUNCTION public.phase029_guard_dataset_insert() RESTRICT;
ALTER TABLE public."Dataset" DROP CONSTRAINT dataset_modality_resolution_shape RESTRICT;
ALTER TABLE public."Dataset" DROP CONSTRAINT dataset_modality_revision_nonnegative RESTRICT;
ALTER TABLE public."Dataset"
  DROP COLUMN "modality" RESTRICT,
  DROP COLUMN "modalityContentRevision" RESTRICT,
  DROP COLUMN "modalityResolvedAt" RESTRICT,
  DROP COLUMN "modalityResolverSubject" RESTRICT;

DO $after$
DECLARE e record; actual_schema jsonb; actual_rows jsonb; original jsonb;
BEGIN
  SELECT * INTO e FROM pg_temp.phase029_recovery_evidence;
  actual_schema := pg_temp.phase029_schema_manifest(false);
  actual_rows := pg_temp.phase029_rows();
  SELECT jsonb_agg(to_jsonb(m) ORDER BY id) INTO original FROM public._prisma_migrations m
    WHERE migration_name='20260930010000_dataset_modality';
  IF actual_schema IS DISTINCT FROM e.expected_after_schema THEN RAISE EXCEPTION 'RECOVERY_POST_SCHEMA_MISMATCH'; END IF;
  IF actual_rows IS DISTINCT FROM e.before_rows THEN RAISE EXCEPTION 'RECOVERY_APPLICATION_ROWS_CHANGED'; END IF;
  IF original IS DISTINCT FROM e.original_migration THEN RAISE EXCEPTION 'RECOVERY_ORIGINAL_HISTORY_CHANGED'; END IF;
  RAISE NOTICE 'RECOVERY_AFTER schema_md5=% tables=% original_migration_unchanged=true',md5(actual_schema::text),actual_rows;
END;
$after$;
COMMIT;
-- Prisma, not this SQL, must record the NEW corrective migration as completed.
-- After migrate deploy returns, perform a separate read-only check of both history
-- entries and save checksums/timestamps and the captured BEFORE/AFTER evidence.
