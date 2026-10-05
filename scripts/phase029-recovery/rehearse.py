"""Disposable-only recovery rehearsal. No application connection or live migration edits."""
import os, json, shutil, subprocess, hashlib, tempfile, gzip
from datetime import datetime, timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'specs/029-modality-specific-datasets/verification/rehearsal-v2'
OUT.mkdir(exist_ok=False)
C='phase029-recovery-rehearsal-v2'
WORK=Path(tempfile.mkdtemp(prefix='phase029-rehearsal-v2-'))
ENV=os.environ.copy()
def run(args, *, stdin=None, check=True):
    p=subprocess.run(args,input=stdin,text=True,capture_output=True,env=ENV,cwd=ROOT)
    if check and p.returncode: raise RuntimeError(p.stdout+'\n'+p.stderr)
    return p
# All SQL goes through the dedicated container, never an environment-derived URL.
inspect=json.loads(run(['docker','inspect',C]).stdout)[0]
assert inspect['Config']['Labels']['phase029.disposable']=='recovery-v2'
assert inspect['NetworkSettings']['Ports']['5432/tcp']==[{'HostIp':'127.0.0.1','HostPort':'55450'}]
def sql(q, db='fieldframe'):
    if 'RECOVERY_DISPOSABLE_SYSTEM_ID' in ENV:
        q="DO $pin$ BEGIN IF (SELECT system_identifier::text FROM pg_control_system()) <> '"+ENV['RECOVERY_DISPOSABLE_SYSTEM_ID']+"' THEN RAISE EXCEPTION 'INSTANCE_MISMATCH'; END IF; END $pin$;\n"+q
    return run(['docker','exec','-i',C,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],stdin=q).stdout.strip()
ENV['RECOVERY_DISPOSABLE_SYSTEM_ID']=sql('SELECT system_identifier FROM pg_control_system()')
identity={'host':'127.0.0.1','port':55450,'database':'fieldframe','systemIdentifier':ENV['RECOVERY_DISPOSABLE_SYSTEM_ID'],'containerId':inspect['Id']}
(OUT/'instance.json').write_text(json.dumps(identity,indent=2)+'\n')
# Root config must override our shell URL and still be rejected BEFORE any connection.
ENV['DATABASE_URL']='postgresql://postgres@127.0.0.1:55450/fieldframe'
p=run(['node','scripts/phase029-recovery/guarded-prisma.mjs','prisma.config.ts','probe'],check=False)
(OUT/'application-target-rejected.log').write_text(p.stdout+p.stderr)
assert p.returncode and 'APPLICATION_OR_UNAPPROVED_TARGET_ABORT' in p.stderr
assert '"port":"5433"' in p.stdout
M=WORK/'migrations'; M.mkdir()
shutil.copy(ROOT/'prisma/migrations/migration_lock.toml',M)
for d in sorted((ROOT/'prisma/migrations').iterdir()):
    if d.is_dir() and d.name<'20260930010000_dataset_modality': shutil.copytree(d,M/d.name)
shutil.copy(ROOT/'prisma/schema.prisma',WORK/'schema.prisma')
config=WORK/'prisma.config.ts'
config.write_text('import {defineConfig} from '+json.dumps(str(ROOT/'node_modules/prisma/config.js'))+'; export default defineConfig('+json.dumps({'schema':str(WORK/'schema.prisma'),'migrations':{'path':str(M)},'engine':'classic','datasource':{'url':ENV['DATABASE_URL']}})+');')
def prisma(name,command='deploy',ok=True):
    p=run(['node','scripts/phase029-recovery/guarded-prisma.mjs',str(config),command],check=False)
    (OUT/(name+'.log')).write_text(p.stdout+p.stderr)
    if ok and p.returncode: raise RuntimeError(name+'\n'+p.stdout+p.stderr)
    return p
prisma('00-effective-target','probe')
prisma('01-history-pre029')
sql('''BEGIN; INSERT INTO "User" (id,email,role,"updatedAt") VALUES ('recovery-owner','recovery@example.invalid','ADMIN',now());
INSERT INTO "Dataset" (id,"ownerId",name,"updatedAt") VALUES
 ('recovery-empty','recovery-owner','Empty',now()), ('recovery-single','recovery-owner','Single',now()),
 ('recovery-mixed','recovery-owner','Mixed',now());
INSERT INTO "Asset" (id,"datasetId",modality,filename,"relativePath","mimeType","sourceFingerprint","updatedAt") VALUES
 ('recovery-image','recovery-single','IMAGE','image.png','image.png','image/png','fixture-image',now()),
 ('recovery-mixed-image','recovery-mixed','IMAGE','image.png','image.png','image/png','fixture-image',now()),
 ('recovery-audio','recovery-mixed','AUDIO','audio.wav','audio.wav','audio/wav','fixture-audio',now());
INSERT INTO "Label" (id,"datasetId",name,"normalizedName",color,"updatedAt") VALUES
 ('recovery-label','recovery-single','Object','object','#123456',now());
INSERT INTO "Annotation" (id,"datasetId","assetId","labelId","createdById",modality,type,geometry,"updatedAt") VALUES
 ('recovery-annotation','recovery-single','recovery-image','recovery-label','recovery-owner','IMAGE','BOUNDING_BOX','{"x":0.1,"y":0.2,"width":0.3,"height":0.4}',now()); COMMIT;''')
shutil.copytree(ROOT/'prisma/migrations/20260930010000_dataset_modality',M/'20260930010000_dataset_modality')
prisma('02-history-through029')
sql('UPDATE "Asset" SET width=100,height=100 WHERE id=\'recovery-image\';')
assert json.loads(sql('SELECT json_agg(x) FROM (SELECT id,"modalityContentRevision" FROM "Dataset" ORDER BY id) x'))==[
 {'id':'recovery-empty','modalityContentRevision':0},{'id':'recovery-mixed','modalityContentRevision':0},{'id':'recovery-single','modalityContentRevision':1}]
sql('CREATE DATABASE recovery_fixture TEMPLATE fieldframe;', 'postgres')
recovery=(ROOT/'specs/proposals/phase029-modality/recovery.v2.review.sql').read_text()
assert hashlib.sha256(recovery.encode()).hexdigest()=='3bb6389f380ffaa5c3be88d26d56782065a00b3844f0326ccba1c05ee4b5a1db'
correction=M/'20260930020000_revert_dataset_modality';correction.mkdir();(correction/'migration.sql').write_text(recovery)
helpers=recovery[recovery.index('CREATE FUNCTION pg_temp.phase029_schema_manifest'):recovery.index('CREATE TEMP TABLE phase029_recovery_evidence')]
def evidence():
    # Ensure temp namespace exists before creating session-only helper routines.
    rows=sql('CREATE TEMP TABLE evidence_session(x int);\n'+helpers+'''
SELECT jsonb_build_object('schema',pg_temp.phase029_schema_manifest(false),'expectedSchema',pg_temp.phase029_schema_manifest(true),'rows',pg_temp.phase029_rows(),'original',(SELECT to_jsonb(m) FROM _prisma_migrations m WHERE migration_name='20260930010000_dataset_modality'),'fence',(SELECT jsonb_agg(jsonb_build_object('id',id,'revision',"modalityContentRevision")) FROM "Dataset"));''')
    return json.loads(rows)
def post_evidence():
    q='CREATE TEMP TABLE evidence_session(x int);\n'+helpers+'''
SELECT jsonb_build_object('schema',pg_temp.phase029_schema_manifest(false),'rows',pg_temp.phase029_rows(),'original',(SELECT to_jsonb(m) FROM _prisma_migrations m WHERE migration_name='20260930010000_dataset_modality'));'''
    return json.loads(sql(q))
results=[]
scenarios=[('success',None,None),
 ('receipt', '''UPDATE "Dataset" SET modality='IMAGE',"modalityResolverSubject"='recovery-owner' WHERE id='recovery-empty';''','RECOVERY_BLOCKED_RESOLUTION_OR_RECEIPT_EXISTS'),
 ('trigger', 'ALTER TABLE "Asset" DISABLE TRIGGER asset_modality_write_guard;','RECOVERY_TRIGGER_SHAPE_MISMATCH'),
 ('function', 'ALTER FUNCTION phase029_guard_asset_write() SECURITY DEFINER;','RECOVERY_FUNCTION_SHAPE_MISMATCH'),
 ('constraint', 'ALTER TABLE "Dataset" DROP CONSTRAINT dataset_modality_revision_nonnegative; ALTER TABLE "Dataset" ADD CONSTRAINT dataset_modality_revision_nonnegative CHECK ("modalityContentRevision">=-1);','RECOVERY_CONSTRAINT_SHAPE_MISMATCH'),
 ('rls','ALTER TABLE "Asset" ENABLE ROW LEVEL SECURITY;','RECOVERY_FULL_ROW_VISIBILITY_UNPROVEN'),
 ('forced-rls','ALTER TABLE "Asset" ENABLE ROW LEVEL SECURITY; ALTER TABLE "Asset" FORCE ROW LEVEL SECURITY;','RECOVERY_FULL_ROW_VISIBILITY_UNPROVEN'),
 ('manifest-tamper',None,'RECOVERY_POST_SCHEMA_MISMATCH'),
 ('identity-collision',None,'RECOVERY_MANIFEST_IDENTITY_COLLISION')]
for name,tamper,error in scenarios:
    if name!='success':
        sql('DROP DATABASE fieldframe WITH (FORCE);','postgres')
        sql('CREATE DATABASE fieldframe TEMPLATE recovery_fixture;','postgres')
    if tamper: sql(tamper)
    before=evidence()
    test_sql=recovery
    if name=='manifest-tamper':
        test_sql=recovery.replace('DO $after$', 'COMMENT ON TABLE public."Asset" IS \'rehearsal-only schema tamper\';\nDO $after$')
    if name=='identity-collision':
        test_sql=recovery.replace(')\nSELECT coalesce(jsonb_agg', "UNION ALL SELECT 'relation'::text,jsonb_build_array('public','Dataset')::text,'[]'::jsonb\n)\nSELECT coalesce(jsonb_agg",1)
    (correction/'migration.sql').write_text(test_sql)
    if name=='success':
        assert len(before['schema'])==1841 and len({(o[0],o[1]) for o in before['schema']})==1841
        assert len(before['rows'])==35
        regression_sql=(ROOT/'scripts/phase029-recovery/manifest-regressions.sql').read_text()
        regression=json.loads(sql('BEGIN; CREATE TEMP TABLE evidence_session(x int);\n'+helpers+'\n'+regression_sql+'\nROLLBACK;'))
        assert all(regression.values()),regression
        (OUT/'manifest-regressions.json').write_text(json.dumps(regression,indent=2)+'\n')
    started=datetime.now(timezone.utc).isoformat()
    p=prisma(name,ok=error is None)
    server=run(['docker','logs','--since',started,C]).stderr
    server_errors='\n'.join(line for line in server.splitlines() if 'ERROR:' in line or 'CONTEXT:' in line)
    (OUT/(name+'-server.log')).write_text(server_errors+'\n')
    after=post_evidence()
    assert before['rows']==after['rows'],name+' row drift'
    assert before['original']==after['original'],name+' history drift'
    if error:
        assert p.returncode and error in server_errors,name+' expected failure missing'
        assert before['schema']==after['schema'],name+' rollback schema drift'
    else:
        assert before['expectedSchema']==after['schema'],'post schema mismatch'
        history=json.loads(sql('SELECT json_agg(x) FROM (SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY migration_name) x'))
        assert len(history)==23 and all(r['finished_at'] and not r['rolled_back_at'] for r in history)
        (OUT/'success-migration-history.json').write_text(json.dumps(history,indent=2)+'\n')
        prisma('success-status','status')
    leftovers=sql("SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (c.relname LIKE '\\_spike%' ESCAPE '\\' OR c.relname LIKE 'phase029_%' OR c.relname='evidence_session') AND n.nspname NOT IN ('pg_catalog','information_schema')")
    assert not leftovers,leftovers
    assert not sql("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname LIKE '\\_spike%' ESCAPE '\\' OR (n.nspname LIKE 'pg_temp_%' AND p.proname LIKE 'phase029_%')")
    payload=(json.dumps({'before':before,'after':after},indent=2)+'\n').encode()
    (OUT/(name+'-evidence.json.gz')).write_bytes(gzip.compress(payload,mtime=0))
    results.append({'scenario':name,'result':'PASS','expectedError':error,'allApplicationRowsUnchanged':True,'originalMigrationUnchanged':True,'schemaCorrect':True,'noTemporaryRelations':True,'executedSqlSha256':hashlib.sha256(test_sql.encode()).hexdigest(),'exactCandidate':test_sql==recovery,'evidenceUncompressedSha256':hashlib.sha256(payload).hexdigest()})
    print(name,'PASS',flush=True)
summary={'sqlSha256':hashlib.sha256(recovery.encode()).hexdigest(),'instance':identity,'scenarios':results}
for case in results:
    saved=json.loads(gzip.decompress((OUT/(case['scenario']+'-evidence.json.gz')).read_bytes()))
    case['schemaMd5']={side:sql('SELECT md5($manifest$'+json.dumps(saved[side]['schema'])+'$manifest$::jsonb::text);') for side in ['before','after']}
    if case['scenario']=='success':
        summary['applicationTables']=saved['before']['rows']
        summary['fenceBefore']=saved['before']['fence']
        before_objects={(x[0],x[1]) for x in saved['before']['schema']}
        after_objects={(x[0],x[1]) for x in saved['after']['schema']}
        summary['removedObjects']=sorted(before_objects-after_objects)
        assert not after_objects-before_objects
        assert len(summary['removedObjects'])==12
        assert len(saved['after']['schema'])==1829
(OUT/'results.json').write_text(json.dumps(summary,indent=2)+'\n')
(OUT/'staging-cleanup.json').write_text(json.dumps({'removed':str(WORK)},indent=2)+'\n')
shutil.rmtree(WORK)
print('All recovery rehearsals passed. Application database not accessed.',flush=True)
