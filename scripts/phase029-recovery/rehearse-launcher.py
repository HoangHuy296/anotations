"""Launcher-only rehearsal on a NEW disposable cluster; never connects to the application DB."""
import os, json, shutil, subprocess, hashlib, tempfile, gzip, secrets, re
from datetime import datetime, timezone
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'specs/029-modality-specific-datasets/verification/launcher-rehearsal-20260930'
C = 'phase029-launcher-rehearsal'
SQL_SHA = '3bb6389f380ffaa5c3be88d26d56782065a00b3844f0326ccba1c05ee4b5a1db'
ENV = os.environ.copy()
ENV.pop('DATABASE_URL', None)
ENV['POSTGRES_PASSWORD'] = secrets.token_hex(24)
WORK = None
container_id = None
volume_names = []
results = []
def digest(b): return hashlib.sha256(b).hexdigest()
def save(name, value):
    (OUT / name).write_text(value if isinstance(value, str) else json.dumps(value, indent=2)+'\n')
def run(args, stdin=None, check=True, env=None):
    p = subprocess.run(args, input=stdin, text=True, capture_output=True, env=env or ENV, cwd=ROOT)
    if check and p.returncode:
        # No raw config/URL or environment in diagnostic exceptions.
        raise RuntimeError('COMMAND_FAILED: '+args[0]+' '+str(p.returncode))
    return p
def inspect():
    data = json.loads(run(['docker', 'inspect', C]).stdout)[0]
    assert data['Id'] == container_id
    assert data['Config']['Labels']['phase029.disposable'] == 'launcher-rehearsal'
    assert data['NetworkSettings']['Ports']['5432/tcp'] == [{'HostIp':'127.0.0.1','HostPort':'55451'}]
    return data
def sql(query):
    # Every direct fixture/evidence query is pinned to the disposable Docker ID.
    inspect()
    prefix = "DO $pin$ BEGIN IF (SELECT system_identifier::text FROM pg_control_system()) <> '"+identity['systemIdentifier']+"' THEN RAISE EXCEPTION 'INSTANCE_MISMATCH'; END IF; END $pin$;\n"
    return run(['docker','exec','-i',C,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','fieldframe'],stdin=prefix+query).stdout.strip()
def server_logs(since):
    p = run(['docker','logs','--since',since,C])
    text = p.stdout+p.stderr
    assert ENV['POSTGRES_PASSWORD'] not in text
    return text
def write_receipt(path, config_path, overrides=None):
    receipt = dict(identity, profile='disposable', sqlSha256=SQL_SHA,
        configSha256=digest(config_path.read_bytes()), schemaSha256=digest((WORK/'schema.prisma').read_bytes()),
        migrationHashes={p.name:digest((p/'migration.sql').read_bytes()) for p in sorted(M.iterdir()) if p.is_dir()})
    if overrides: receipt.update(overrides)
    path.write_text(json.dumps(receipt,indent=2)+'\n')
    return receipt
def config_text(url=None, expression=None):
    config = {'schema':str(WORK/'schema.prisma'),'migrations':{'path':str(M)},'engine':'classic'}
    if url is not None: config['datasource']={'url':url}
    text = 'import {defineConfig} from '+json.dumps(str(ROOT/'node_modules/prisma/config.js'))+'; export default defineConfig('+json.dumps(config)+');'
    if expression:
        text = text.replace('"engine": "classic"', '"engine": "classic", "datasource": {"url": '+expression+'}')
    return text

def launcher(name, config_path=None, receipt_path=None, command='deploy', shell_url=None, ok=True):
    child_env = ENV.copy()
    if shell_url is not None: child_env['DATABASE_URL']=shell_url
    else: child_env.pop('DATABASE_URL',None)
    args=['node','scripts/phase029-recovery/launch-reviewed-prisma.mjs',str(config_path or CONFIG),str(receipt_path or RECEIPT),command]
    p=run(args,check=False,env=child_env)
    output=p.stdout+p.stderr
    assert ENV['POSTGRES_PASSWORD'] not in output
    assert not re.search(r'postgres(?:ql)?://',output)
    save(name+'.log',output)
    save(name+'-command.json',{'argv':args,'shellDatabaseUrlPresent':shell_url is not None,'exitCode':p.returncode})
    if ok: assert p.returncode==0, name+' failed; inspect redacted log'
    return p

try:
    assert OUT.exists() and not (OUT/'results.json').exists()
    assert run(['docker','inspect',C],check=False).returncode != 0, 'DISPOSABLE_NAME_ALREADY_EXISTS'
    recovery=(ROOT/'specs/proposals/phase029-modality/recovery.v2.review.sql').read_bytes()
    assert digest(recovery)==SQL_SHA
    container_id=run(['docker','run','-d','--name',C,'--label','phase029.disposable=launcher-rehearsal','--publish','127.0.0.1:55451:5432','--env','POSTGRES_PASSWORD','--env','POSTGRES_DB=fieldframe','postgres:16-alpine','-c','log_statement=all','-c','log_connections=on','-c','log_disconnections=on']).stdout.strip()
    run(['docker','exec',C,'sh','-c','for n in $(seq 1 30); do pg_isready -U postgres -d fieldframe >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'])
    ins=inspect()
    volume_names=[m['Name'] for m in ins['Mounts'] if m['Type']=='volume']
    control=run(['docker','exec',C,'sh','-c','LC_ALL=C pg_controldata "$PGDATA"']).stdout
    system_id=re.search(r'Database system identifier:\s+(\d+)',control).group(1)
    assert system_id!='7662655305624969250', 'APPLICATION_INSTANCE_FORBIDDEN'
    identity={'target':{'host':'127.0.0.1','port':'55451','database':'fieldframe','schema':'public'},'containerId':container_id,'systemIdentifier':system_id}
    save('instance.json',dict(identity,verifiedBeforeFirstFixtureOrMigrationWrite=True,source='Docker identity/binding plus pg_controldata before SQL',image=ins['Image']))
    WORK=Path(tempfile.mkdtemp(prefix='phase029-launcher-rehearsal-'))
    M=WORK/'migrations'; M.mkdir()
    shutil.copy(ROOT/'prisma/migrations/migration_lock.toml',M)
    for p in sorted((ROOT/'prisma/migrations').iterdir()):
        if p.is_dir() and p.name<'20260930010000_dataset_modality':shutil.copytree(p,M/p.name)
    shutil.copy(ROOT/'prisma/schema.prisma',WORK/'schema.prisma')
    url='postgresql://postgres:'+ENV['POSTGRES_PASSWORD']+'@127.0.0.1:55451/fieldframe'
    CONFIG=WORK/'prisma.config.ts'; CONFIG.write_text(config_text(url));CONFIG.chmod(0o400)
    RECEIPT=WORK/'receipt.json';write_receipt(RECEIPT,CONFIG)
    launcher('00-identity-probe',command='probe')
    launcher('01-real-history-pre029')
    sql('''BEGIN;
INSERT INTO "User" (id,email,role,"updatedAt") VALUES ('recovery-owner','recovery@example.invalid','ADMIN',now());
INSERT INTO "Dataset" (id,"ownerId",name,"updatedAt") VALUES
 ('recovery-empty','recovery-owner','Empty',now()), ('recovery-single','recovery-owner','Single',now()), ('recovery-mixed','recovery-owner','Mixed',now());
INSERT INTO "Asset" (id,"datasetId",modality,filename,"relativePath","mimeType","sourceFingerprint","updatedAt") VALUES
 ('recovery-image','recovery-single','IMAGE','image.png','image.png','image/png','fixture-image',now()),
 ('recovery-mixed-image','recovery-mixed','IMAGE','image.png','image.png','image/png','fixture-image',now()),
 ('recovery-audio','recovery-mixed','AUDIO','audio.wav','audio.wav','audio/wav','fixture-audio',now());
INSERT INTO "Label" (id,"datasetId",name,"normalizedName",color,"updatedAt") VALUES ('recovery-label','recovery-single','Object','object','#123456',now());
INSERT INTO "Annotation" (id,"datasetId","assetId","labelId","createdById",modality,type,geometry,"updatedAt") VALUES
 ('recovery-annotation','recovery-single','recovery-image','recovery-label','recovery-owner','IMAGE','BOUNDING_BOX','{"x":0.1,"y":0.2,"width":0.3,"height":0.4}',now());
COMMIT;''')
    shutil.copytree(ROOT/'prisma/migrations/20260930010000_dataset_modality',M/'20260930010000_dataset_modality')
    write_receipt(RECEIPT,CONFIG)
    launcher('02-real-history-through029')
    sql('UPDATE "Asset" SET width=100,height=100 WHERE id=\'recovery-image\';')
    fence=json.loads(sql('SELECT json_agg(x) FROM (SELECT id,"modalityContentRevision" FROM "Dataset" ORDER BY id) x'))
    assert [r['modalityContentRevision'] for r in fence]==[0,0,1]
    correction=M/'20260930020000_revert_dataset_modality';correction.mkdir();(correction/'migration.sql').write_bytes(recovery)
    write_receipt(RECEIPT,CONFIG)
    text=recovery.decode()
    helpers=text[text.index('CREATE FUNCTION pg_temp.phase029_schema_manifest'):text.index('CREATE TEMP TABLE phase029_recovery_evidence')]
    def evidence():
        query='BEGIN ISOLATION LEVEL REPEATABLE READ; CREATE TEMP TABLE evidence_session(x int);\n'+helpers+'''
SELECT jsonb_build_object('schema',pg_temp.phase029_schema_manifest(false),'expectedSchema',pg_temp.phase029_schema_manifest(true),'rows',pg_temp.phase029_rows(),'history',(SELECT jsonb_agg(to_jsonb(m) ORDER BY migration_name) FROM _prisma_migrations m));
ROLLBACK;'''
        return json.loads(sql(query))
    before=evidence()
    assert len(before['schema'])==1841 and len(before['rows'])==35 and len(before['history'])==22
    manifest=json.loads(sql('BEGIN; CREATE TEMP TABLE evidence_session(x int);\n'+helpers+'\n'+(ROOT/'scripts/phase029-recovery/manifest-regressions.sql').read_text()+'\nROLLBACK;'))
    assert all(manifest.values());save('manifest-regressions.json',manifest)
    cases=[
        ('missing-datasource',config_text(),{},'CONFIG_RESOLUTION_FAILED'),
        ('shell-only-datasource',config_text(expression='process.env.DATABASE_URL'),{},'CONFIG_RESOLUTION_FAILED'),
        ('mismatched-target',config_text('postgresql://postgres@127.0.0.1:5433/fieldframe'),{},'EFFECTIVE_TARGET_MISMATCH'),
        ('missing-instance',config_text(url),{'systemIdentifier':None},'MISSING_INSTANCE_IDENTITY'),
        ('wrong-instance',config_text(url),{'systemIdentifier':'1234567890123456789'},'PRECONNECT_SYSTEM_ID_MISMATCH'),
        ('wrong-container',config_text(url),{'containerId':'0'*64},'CONTAINER_IDENTITY_MISMATCH'),
        ('config-checksum',config_text(url),{'configSha256':'0'*64},'CONFIG_CHECKSUM_MISMATCH'),
        ('schema-checksum',config_text(url),{'schemaSha256':'0'*64},'SCHEMA_CHECKSUM_MISMATCH'),
    ]
    for name,contents,overrides,marker in cases:
        bad=WORK/(name+'.config.ts');bad.write_text(contents);bad.chmod(0o400)
        # Keep staged schema/migrations paths anchored to its config directory.
        bad_receipt=WORK/(name+'.receipt.json');write_receipt(bad_receipt,bad,overrides)
        started=datetime.now(timezone.utc).isoformat()
        p=launcher('negative-'+name,config_path=bad,receipt_path=bad_receipt,ok=False,shell_url=url if name=='shell-only-datasource' else None)
        logs=server_logs(started)
        save('negative-'+name+'-postgres.log',logs)
        assert p.returncode!=0 and marker in p.stderr,name
        assert not re.search(r'(statement:|execute\s+[^:]*:|connection received:|connection authorized:)',logs),name+' contacted database'
        after=evidence()
        assert before==after,name+' changed database'
        results.append({'scenario':name,'result':'PASS','expectedError':marker,'noSQLOrConnectionDuringFailedLaunch':True,'all35FingerprintsUnchanged':True,'schemaAndAll22MigrationRecordsUnchanged':True})
        print(name,'PASS',flush=True)
    p=launcher('conflicting-shell-url-ignored',command='probe',shell_url='postgresql://untrusted@127.0.0.1:5433/fieldframe')
    assert '"inheritedDatabaseUrlPresent":true' in p.stdout and '"port":"55451"' in p.stdout
    assert before==evidence()
    results.append({'scenario':'conflicting-shell-url-ignored','result':'PASS','verifiedDisposableTargetUsed':True,'databaseUnchanged':True})
    started=datetime.now(timezone.utc).isoformat()
    p=launcher('success-absent-shell-database-url')
    assert '"inheritedDatabaseUrlPresent":false' in p.stdout
    assert 'SCHEMA_VALIDATION_PASSED_VERIFIED_ENVIRONMENT' in p.stdout
    logs=server_logs(started);save('success-postgres.log',logs)
    assert not re.search(r'(ERROR:|FATAL:|PANIC:)',logs),'unexpected PostgreSQL error'
    after=evidence()
    assert before['rows']==after['rows'] and before['expectedSchema']==after['schema']
    assert after['history'][:22]==before['history']
    assert len(after['history'])==23 and after['history'][-1]['migration_name']=='20260930020000_revert_dataset_modality'
    assert after['history'][-1]['checksum']==SQL_SHA and after['history'][-1]['finished_at'] and not after['history'][-1]['rolled_back_at']
    old={(r[0],r[1]) for r in before['schema']}; new={(r[0],r[1]) for r in after['schema']}
    assert len(old-new)==12 and not new-old and len(new)==1829
    launcher('success-prisma-status',command='status')
    leftovers=sql("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (c.relname LIKE '\\_spike%' ESCAPE '\\' OR c.relname LIKE 'phase029_%' OR c.relname='evidence_session') AND n.nspname NOT IN ('pg_catalog','information_schema')")
    assert not leftovers
    payload=(json.dumps({'before':before,'after':after},indent=2)+'\n').encode()
    (OUT/'success-evidence.json.gz').write_bytes(gzip.compress(payload,mtime=0))
    save('all35-table-fingerprints.json',{'before':before['rows'],'after':after['rows']})
    save('all23-migration-records.json',after['history'])
    results.append({'scenario':'absent-shell-database-url-success','result':'PASS','schemaValidationPassed':True,'exactSQL':True,'removedObjects':sorted(old-new),'all35FingerprintsUnchanged':True,'all22OriginalHistoryRecordsUnchanged':True,'newCorrectiveMigrationFinished':True,'prismaStatusClean':True,'noTemporaryInfrastructureInDatabase':True})
    save('results.json',{'result':'PASS','sqlSha256':SQL_SHA,'launcherSha256':digest((ROOT/'scripts/phase029-recovery/launch-reviewed-prisma.mjs').read_bytes()),'instance':identity,'scenarios':results,'fenceBefore':fence,'schemaEntryCounts':{'before':1841,'after':1829},'applicationDatabaseConnected':False,'applicationServicesRestarted':False,'evidenceUncompressedSha256':digest(payload)})
    print('Launcher correction rehearsal PASS; no application connection.',flush=True)
except Exception as error:
    save('harness-failure.json',{'error':str(error),'completedScenarios':results})
    raise
finally:
    cleanup={'container':C,'containerId':container_id,'volumeNames':volume_names,'stagingDirectory':str(WORK) if WORK else None,'applicationDatabaseConnected':False}
    if container_id:
        inspect()
        p=run(['docker','logs',C],check=False)
        log=p.stdout+p.stderr
        assert ENV['POSTGRES_PASSWORD'] not in log
        (OUT/'complete-disposable-postgres.log.gz').write_bytes(gzip.compress(log.encode(),mtime=0))
        run(['docker','rm','-f','-v',C])
        cleanup['containerAbsent']=run(['docker','inspect',C],check=False).returncode!=0
        cleanup['volumesAbsent']=all(run(['docker','volume','inspect',v],check=False).returncode!=0 for v in volume_names)
    if WORK:
        shutil.rmtree(WORK)
        cleanup['privateStagingRemoved']=not WORK.exists()
    cleanup['temporaryFrozenConfigsRemaining']=[str(p) for p in Path('/tmp').glob('phase029-launcher-frozen-*')]
    assert not cleanup['temporaryFrozenConfigsRemaining']
    save('cleanup.json',cleanup)
