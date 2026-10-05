-- Disposable-only, same session as the exact v2 temporary manifest helper.
-- No permanent schema writes. Surround with BEGIN/ROLLBACK in the harness.
WITH manifest AS (SELECT pg_temp.phase029_schema_manifest(false) AS m),
items AS (SELECT e.value, e.ordinality, (e.value->>1)::jsonb identity
  FROM manifest CROSS JOIN LATERAL jsonb_array_elements(m) WITH ORDINALITY e(value,ordinality)),
reverse_input AS (SELECT * FROM items ORDER BY ordinality DESC),
reordered AS (SELECT jsonb_agg(value ORDER BY (value->>0) COLLATE "C", (value->>1) COLLATE "C") m FROM reverse_input)
SELECT jsonb_build_object(
  'all1841EntriesPreserved', (SELECT count(*)=1841 FROM items),
  'all1841IdentitiesUnique', (SELECT count(DISTINCT (value->0,value->1))=1841 FROM items),
  'schemaQualifiedStructuredKeys', (SELECT bool_and(jsonb_typeof(identity)='array' AND identity->>0='public') FROM items),
  'assetVersionThreeKeys', (SELECT count(*)=3 AND count(DISTINCT identity->>2)=3 FROM items WHERE value->>0='column' AND identity->>1='AssetVersion_storageProvider_storageBucket_storageKey_key' AND identity->>2 IN ('storageProvider','storageBucket','storageKey')),
  'outboxTwoKeys', (SELECT count(*)=2 AND count(DISTINCT identity->>2)=2 FROM items WHERE value->>0='column' AND identity->>1='CollaborationOutboxEvent_datasetId_dispatchedAt_createdAt_idx' AND identity->>2 IN ('datasetId','dispatchedAt')),
  'visualizationFiveKeys', (SELECT count(*)=5 AND count(DISTINCT identity->>2)=5 FROM items WHERE value->>0='column' AND identity->>1='VisualizationArtifact_datasetId_snapshotId_kind_algorithm_s_key'),
  'longIdentityNotTruncated', (SELECT max(octet_length(value->>1))>63 FROM items),
  'reversedInputExactEquality', (SELECT manifest.m=reordered.m FROM manifest CROSS JOIN reordered),
  'repeatedCallExactEquality', (SELECT m=pg_temp.phase029_schema_manifest(false) FROM manifest),
  'dottedNamesDistinct', jsonb_build_array('public','a.b','c')::text<>jsonb_build_array('public','a','b.c')::text,
  'quotedNamesDistinct', jsonb_build_array('public','a"b','c')::text<>jsonb_build_array('public','a','b"c')::text,
  'expectedPostHas1829UniqueEntries', (SELECT count(*)=1829 AND count(DISTINCT (v->0,v->1))=1829 FROM jsonb_array_elements(pg_temp.phase029_schema_manifest(true)) AS e(v))
);
