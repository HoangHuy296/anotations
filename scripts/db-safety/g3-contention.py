"""G3 orchestrator: all generation, fixture and migration operations use G1 receipts."""
import sys, os, json, shutil, subprocess, hashlib, tempfile, secrets, re, time, gzip
from pathlib import Path
from datetime import datetime, timezone
ROOT=Path(__file__).resolve().parents[2]
STAMP=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
OUT=ROOT/'specs/029-modality-specific-datasets/verification/g3-contention/runs'/STAMP
OUT.mkdir(parents=True)
WORK=Path(tempfile.mkdtemp(prefix='phase029-g1-'))
TOKEN=secrets.token_hex(4)
ENV={k:os.environ[k] for k in ['PATH','HOME','LANG'] if k in os.environ}
PASSWORD=secrets.token_hex(24)
ENV.update(POSTGRES_PASSWORD=PASSWORD,MINIO_ROOT_USER='g1'+TOKEN,MINIO_ROOT_PASSWORD=PASSWORD)
PINS=[];REGISTRATIONS=[];RESULTS=[]
BENCHMARK=True
def digest(b):return hashlib.sha256(b).hexdigest()
def save(name,value):
    text=value if isinstance(value,str) else json.dumps(value,indent=2)+'\n'
    assert PASSWORD not in text
    (OUT/name).write_text(text)
def run(args,stdin=None,env=None,check=True):
    p=subprocess.run(args,input=stdin,text=True,capture_output=True,cwd=ROOT,env=env or ENV)
    if check and p.returncode: raise RuntimeError('COMMAND_FAILED:'+args[0]+':'+str(p.returncode))
    return p

def pincheck(pin):
    c=json.loads(run(['docker','inspect',pin['name']]).stdout)[0]
    assert c['Id']==pin['id'] and c['State']['Running'] and c['Config']['Labels']['annotation.safety']=='g1-disposable'
    assert c['NetworkSettings']['Ports'][str(pin['internalPort'])+'/tcp']==[{'HostIp':'127.0.0.1','HostPort':str(pin['port'])}]
    if pin['role']=='postgres':
        ident=re.search(r'Database system identifier:\s+(\d+)',run(['docker','exec',pin['id'],'sh','-c','LC_ALL=C pg_controldata "$PGDATA"']).stdout)[1]
        assert ident==pin['systemIdentifier'] and ident!='7662655305624969250'
    return c

def sql(query):
    pincheck(PG)
    # Read-only evidence, no fixture/DDL backdoor. All mutations go through G1.
    return run(['docker','exec','-i','-e','PGOPTIONS=-c default_transaction_read_only=on',PG['id'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','fieldframe'],stdin=query).stdout.strip()
def logs(since):
    p=run(['docker','logs','--since',since,PG['id']]);return p.stdout+p.stderr

def capture():
    tables=json.loads(sql("SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations'"))
    assert len(tables)==35
    reviewed=(ROOT/'specs/proposals/phase029-modality/recovery.v2.review.sql').read_text()
    # Extract just the reviewed read-only CTE; never install or invoke recovery DDL.
    manifest=reviewed[reviewed.index('WITH objects AS ('):reviewed.index('IF EXISTS (\n  SELECT 1 FROM jsonb_array_elements(manifest)')].replace('expected_after','false').replace(' INTO manifest FROM objects;', ' FROM objects;')
    statements=['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',"SELECT json_build_object('identity',system_identifier::text) FROM pg_control_system();",manifest]
    for table in tables:
        assert re.fullmatch('[A-Za-z]+',table)
        expression="to_jsonb(x) - ARRAY['modality','modalityContentRevision','modalityResolvedAt','modalityResolverSubject']" if table=='Dataset' else 'to_jsonb(x)'
        statements.append("SELECT json_build_object('table','"+table+"','rows',count(*),'md5',md5(coalesce(string_agg(h,'' ORDER BY h),''))) FROM (SELECT md5(("+expression+")::text) AS h FROM public.\""+table+"\" x) t;")
    statements.extend(["SELECT json_build_object('history',jsonb_agg(to_jsonb(m) ORDER BY migration_name)) FROM public._prisma_migrations m;",'ROLLBACK;'])
    data=[json.loads(line) for line in sql('\n'.join(statements)).splitlines()]
    assert len(data)==38
    identities=[(row[0],row[1]) for row in data[1]]
    assert len(identities)==len(set(identities)) and identities==sorted(identities)
    assert data[0]['identity']==PG['systemIdentifier']
    return {'identity':data[0]['identity'],'schema':data[1],'tables':data[2:-1],'history':data[-1]['history']}

def generated_hashes():
    return {str(p.relative_to(ROOT/'lib/generated/prisma')):digest(p.read_bytes()) for p in sorted((ROOT/'lib/generated/prisma').rglob('*')) if p.is_file()}


def config(url, path=None, prefix=''):
    text='import {defineConfig} from '+json.dumps(str(ROOT/'node_modules/prisma/config.js'))+'; '+prefix+'export default defineConfig('+json.dumps({'schema':str(WORK/'schema.prisma'),'migrations':{'path':str(WORK/'migrations')},'engine':'classic','datasource':{'url':url}})+');'
    target=path or WORK/'prisma.config.ts';target.write_text(text);target.chmod(0o600);return target

def request(config_path=None,op='deploy',command=None,**overrides):
    path=config_path or CONFIG
    r={'config':str(path),'configSha256':digest(path.read_bytes()),'operation':op,'postgres':PG,'schemaSha256':digest((WORK/'schema.prisma').read_bytes()),'migrationHashes':{str(p):digest(p.read_bytes()) for p in sorted((WORK/'migrations').glob('*/migration.sql'))}}
    if op!='deploy':r.update(providerFile=str(WORK/'providers.json'),providers=[p for p in PINS if p['role']!='postgres'],command=command)
    r.update(overrides);return r

def issue(name,r,expected=None):
    rp=WORK/(name+'-request.json');rp.write_text(json.dumps(r));receipt=WORK/(name+'-receipt.json')
    since=datetime.now(timezone.utc).isoformat()
    p=run(['node','scripts/db-safety/approve-disposable.mjs',str(rp),str(receipt)],check=False)
    save(name+'-issue.log',p.stdout+p.stderr)
    if expected:
        assert p.returncode and expected in p.stdout+p.stderr
        diagnostic=logs(since);save(name+'-postgres.log',diagnostic)
        assert 'statement:' not in diagnostic and 'connection received:' not in diagnostic
        RESULTS.append({'scenario':name,'pass':True,'rejected':expected,'connections':0,'sqlStatements':0});return None
    assert p.returncode==0
    REGISTRATIONS.append(json.loads(receipt.read_text())['id']);return receipt

def launch(name,receipt,op='deploy',command=None,expected=None,preconnect=False,extraenv=None):
    since=datetime.now(timezone.utc).isoformat()
    env={**ENV,'DB_SAFETY_RECEIPT':str(receipt),**(extraenv or {})}
    args=['node','scripts/db-safety/cli.mjs',op]+([command] if command else [])
    p=run(args,env=env,check=False);save(name+'.log',p.stdout+p.stderr)
    diagnostic=logs(since);save(name+'-postgres.log',diagnostic)
    if expected:
        assert p.returncode and expected in p.stdout+p.stderr,(name,p.stdout+p.stderr)
        if preconnect:assert 'statement:' not in diagnostic and 'connection received:' not in diagnostic
        else:assert not re.search(r'statement: (?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)',diagnostic,re.I)
    else:assert p.returncode==0,(name,p.returncode)
    RESULTS.append({'scenario':name,'pass':True,'exitCode':p.returncode,'rejected':expected,'preconnect':preconnect})
    return p

try:
    # New isolated containers only. No use of compose/application environment.
    for role,image,port,internal,args in [
        ('postgres','postgres:16-alpine',55460,5432,['-e','POSTGRES_PASSWORD','-e','POSTGRES_DB=fieldframe']),
        ('redis','redis:7-alpine',55461,6379,[]),
        ('minio','minio/minio:RELEASE.2025-04-22T22-12-26Z',55462,9000,['-e','MINIO_ROOT_USER','-e','MINIO_ROOT_PASSWORD'])]:
        name='phase029-g1-g3-'+TOKEN+'-'+role
        if role=='redis':
            redisconf=WORK/'redis.conf';redisconf.write_text('bind 0.0.0.0\nrequirepass '+PASSWORD+'\n');redisconf.chmod(0o644)
            args+=['-v',str(redisconf)+':/usr/local/etc/redis/redis.conf:ro']
        tail={'postgres':['postgres','-c','log_statement=all','-c','log_connections=on','-c','log_line_prefix=%m [%p] %e ','-c','log_lock_waits=on','-c','log_min_duration_statement=0','-c','track_functions=pl'],'redis':['redis-server','/usr/local/etc/redis/redis.conf'],'minio':['server','/data']}[role]
        cid=run(['docker','run','-d','--name',name,'--label','annotation.safety=g1-disposable','--label','annotation.role='+role,'-p','127.0.0.1:'+str(port)+':'+str(internal),*args,image,*tail]).stdout.strip()
        pin={'name':name,'id':cid,'role':role,'port':port,'internalPort':internal};PINS.append(pin)
    PG=PINS[0]
    for _ in range(30):
        p=run(['docker','exec',PG['id'],'pg_isready','-U','postgres','-d','fieldframe'],check=False)
        if p.returncode==0:break
        time.sleep(.3)
    else:raise RuntimeError('DISPOSABLE_POSTGRES_NOT_READY')
    PG['systemIdentifier']=re.search(r'Database system identifier:\s+(\d+)',run(['docker','exec',PG['id'],'sh','-c','LC_ALL=C pg_controldata "$PGDATA"']).stdout)[1]
    for p in PINS:pincheck(p)
    save('disposable-identities.json',PINS)
    save('host-environment.json',{'uname':run(['uname','-a']).stdout.strip(),'cpu':run(['lscpu']).stdout,'docker':[{key:c[key] for key in ['Id','Image','Platform']} for c in [pincheck(PG)]],'postgresVersion':run(['docker','exec',PG['id'],'postgres','--version']).stdout.strip()})
    shutil.copytree(ROOT/'prisma/migrations',WORK/'migrations');shutil.copyfile(ROOT/'prisma/schema.prisma',WORK/'schema.prisma')
    URL='postgresql://postgres:'+PASSWORD+'@127.0.0.1:55460/fieldframe'
    CONFIG=config(URL)
    providers={'MINIO_ENDPOINT':'http://127.0.0.1:55462','MINIO_ACCESS_KEY':ENV['MINIO_ROOT_USER'],'MINIO_SECRET_KEY':PASSWORD,'MINIO_BUCKET':'g1-'+TOKEN,'REDIS_HOST':'127.0.0.1','REDIS_PORT':'55461','REDIS_PASSWORD':PASSWORD,'REDIS_DB':'0','BULLMQ_PREFIX':'g1-'+TOKEN}
    (WORK/'providers.json').write_text(json.dumps(providers));(WORK/'providers.json').chmod(0o600)
    (WORK/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
    protected={str(p.relative_to(ROOT)):digest(p.read_bytes()) for p in sorted((ROOT/'prisma/migrations').rglob('*')) if p.is_file()}
    baseline_receipt=issue('baseline-deploy',request())
    launch('complete-23-baseline',baseline_receipt)
    initial=capture();assert len(initial['history'])==23;save('baseline-history.json',initial['history'])
    generator=issue('generation',request(op='test',command='g2:generate'))
    launch('normal-prisma-generation',generator,op='test',command='g2:generate')
    first=generated_hashes()
    launch('repeat-normal-prisma-generation',generator,op='test',command='g2:generate')
    assert first==generated_hashes();save('generated-client-hashes.json',first)
    baseline_fixture=issue('baseline-fixture',request(op='test',command='g2:baseline'))
    launch('seed-synthetic-history',baseline_fixture,op='test',command='g2:baseline')
    if BENCHMARK:
        bench=issue('baseline-benchmark',request(op='test',command='g3:contention:baseline'))
        launch('baseline-benchmark',bench,op='test',command='g3:contention:baseline')
    before=capture();save('before-candidate.json',before)
    candidate=ROOT/'specs/proposals/phase029-modality/migrations/20260930030000_dataset_modality_g2'
    shutil.copytree(candidate,WORK/'migrations'/candidate.name)
    migration=issue('candidate-deploy',request())
    launch('new-additive-candidate',migration)
    after=capture();save('after-candidate.json',after)
    assert before['tables']==after['tables']
    old={(r[0],r[1]):r[2] for r in before['schema']};newshape={(r[0],r[1]):r[2] for r in after['schema']}
    assert len(old)==1829 and len(newshape)==1841 and all(newshape[k]==v for k,v in old.items())
    added=[r for r in after['schema'] if (r[0],r[1]) not in old];assert len(added)==12
    assert sorted(r[0] for r in added)==sorted(['column']*4+['constraint']*2+['trigger']*3+['routine']*3)
    save('exact-12-additions.json',added)
    assert len(after['history'])==24
    assert [h for h in after['history'] if h['migration_name']!=candidate.name]==before['history']
    new=[h for h in after['history'] if h['migration_name']==candidate.name][0]
    assert new['finished_at'] and not new['rolled_back_at'] and new['checksum']==digest((candidate/'migration.sql').read_bytes())
    # New fields must leave every historical Dataset explicitly unresolved.
    unresolved=json.loads(sql('SELECT json_agg(x) FROM (SELECT id,"modality","modalityContentRevision","modalityResolvedAt","modalityResolverSubject" FROM "Dataset" ORDER BY id) x;'))
    assert all(r['modality'] is None and r['modalityContentRevision']==0 and r['modalityResolvedAt'] is None and r['modalityResolverSubject'] is None for r in unresolved)
    save('historical-unresolved-after-candidate.json',unresolved)
    compatibility=issue('schema-compatibility',request(op='test',command='g2:compatibility'))
    launch('prisma-schema-history-compatibility',compatibility,op='test',command='g2:compatibility')
    if BENCHMARK:
        bench=issue('candidate-benchmark',request(op='test',command='g3:contention:candidate'))
        launch('candidate-benchmark',bench,op='test',command='g3:contention:candidate')
    fixture=issue('candidate-fixture',request(op='test',command='g2:candidate'))
    launch('candidate-sequential-contracts',fixture,op='test',command='g2:candidate')
    correctness=issue('g3-correctness',request(op='test',command='g3:correctness'))
    launch('g3-concurrent-correctness',correctness,op='test',command='g3:correctness')
    final=capture();save('after-contract-tests.json',final)
    assert final['schema']==after['schema']
    postcompat=issue('postflight',request(op='test',command='g2:compatibility'))
    launch('postflight-schema-history-status',postcompat,op='test',command='g2:compatibility')
    assert final['history']==after['history']
    assert protected=={str(p.relative_to(ROOT)):digest(p.read_bytes()) for p in sorted((ROOT/'prisma/migrations').rglob('*')) if p.is_file()}
    save('results.json',{'pass':True,'scenarios':RESULTS,'historicalMigrations':23,'candidateMigration':candidate.name,'candidateSha256':new['checksum'],'applicationTablesPreservedByMigration':35,'historicalDatasetRowsUnresolved':len(unresolved),'historicalRecordsUnchanged':True,'clientRegenerationDeterministic':True,'concurrencySmokePassed':True,'benchmarksExecuted':BENCHMARK,'performanceAccepted':False})
except Exception as e:
    save('failure.json',{'errorType':type(e).__name__,'message':str(e).replace(PASSWORD,'[REDACTED]'),'scenarios':RESULTS})
    raise RuntimeError('G3_REHEARSAL_HALTED; inspect evidence '+str(OUT)) from None
finally:
    if PINS:
        p=run(['docker','logs',PINS[0]['id']],check=False);text=p.stdout+p.stderr
        assert PASSWORD not in text
        with gzip.open(OUT/'postgres-complete.log.gz','wt') as f:f.write(text)
    removed=[]
    for pin in reversed(PINS):
        # Never broad teardown; delete only exact newly created immutable Docker IDs.
        p=run(['docker','rm','-fv',pin['id']],check=False);removed.append({'id':pin['id'],'removed':p.returncode==0})
    for rid in REGISTRATIONS:(Path('/tmp/annotation-platform-db-safety-'+str(os.getuid()))/(rid+'.json')).unlink(missing_ok=True)
    shutil.rmtree(WORK)
    save('cleanup.json',{'containers':removed,'privateStageRemoved':not WORK.exists(),'receiptRegistrationsRemoved':len(REGISTRATIONS)})
print(str(OUT))
