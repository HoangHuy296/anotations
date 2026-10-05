"""G1: only new, identity-pinned disposable resources; never load application env."""
import os, json, shutil, subprocess, hashlib, tempfile, secrets, re, time, gzip
from pathlib import Path
from datetime import datetime, timezone
ROOT=Path(__file__).resolve().parents[2]
STAMP=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
OUT=ROOT/'specs/029-modality-specific-datasets/verification/g1-safety-20260930'/STAMP
OUT.mkdir(parents=True)
WORK=Path(tempfile.mkdtemp(prefix='phase029-g1-'))
TOKEN=secrets.token_hex(4)
ENV={k:os.environ[k] for k in ['PATH','HOME','LANG'] if k in os.environ}
PASSWORD=secrets.token_hex(24)
ENV.update(POSTGRES_PASSWORD=PASSWORD,MINIO_ROOT_USER='g1'+TOKEN,MINIO_ROOT_PASSWORD=PASSWORD)
PINS=[];REGISTRATIONS=[];RESULTS=[]
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
    # Disposable only: also bind each evidence query to control/TCP instance identity.
    prefix="DO $pin$ BEGIN IF (SELECT system_identifier::text FROM pg_control_system()) <> '"+PG['systemIdentifier']+"' THEN RAISE EXCEPTION 'INSTANCE_MISMATCH'; END IF; END $pin$;\n"
    return run(['docker','exec','-i',PG['id'],'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','fieldframe'],stdin=prefix+query).stdout.strip()
def logs(since):
    p=run(['docker','logs','--since',since,PG['id']]);return p.stdout+p.stderr

def capture():
    recovery=(ROOT/'specs/proposals/phase029-modality/recovery.v2.review.sql').read_text()
    helpers=recovery[recovery.index('CREATE FUNCTION pg_temp.phase029_schema_manifest'):recovery.index('CREATE TEMP TABLE phase029_recovery_evidence')]
    return json.loads(sql('BEGIN;\n'+helpers+'''\nSELECT json_build_object('schema',pg_temp.phase029_schema_manifest(false),'rows',pg_temp.phase029_rows(),'history',(SELECT jsonb_agg(to_jsonb(m) ORDER BY migration_name) FROM _prisma_migrations m));ROLLBACK;'''))

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
    else:assert p.returncode==0,(name,p.stdout+p.stderr)
    RESULTS.append({'scenario':name,'pass':True,'exitCode':p.returncode,'rejected':expected,'preconnect':preconnect})
    return p

try:
    # New isolated containers only. No use of compose/application environment.
    for role,image,port,internal,args in [
        ('postgres','postgres:16-alpine',55460,5432,['-e','POSTGRES_PASSWORD','-e','POSTGRES_DB=fieldframe']),
        ('redis','redis:7-alpine',55461,6379,[]),
        ('minio','minio/minio:RELEASE.2025-04-22T22-12-26Z',55462,9000,['-e','MINIO_ROOT_USER','-e','MINIO_ROOT_PASSWORD'])]:
        name='phase029-g1-'+TOKEN+'-'+role
        if role=='redis':
            redisconf=WORK/'redis.conf';redisconf.write_text('bind 0.0.0.0\nrequirepass '+PASSWORD+'\n');redisconf.chmod(0o644)
            args+=['-v',str(redisconf)+':/usr/local/etc/redis/redis.conf:ro']
        tail={'postgres':['postgres','-c','log_statement=all','-c','log_connections=on'],'redis':['redis-server','/usr/local/etc/redis/redis.conf'],'minio':['server','/data']}[role]
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
    shutil.copytree(ROOT/'prisma/migrations',WORK/'migrations');shutil.copyfile(ROOT/'prisma/schema.prisma',WORK/'schema.prisma')
    URL='postgresql://postgres:'+PASSWORD+'@127.0.0.1:55460/fieldframe'
    CONFIG=config(URL)
    providers={'MINIO_ENDPOINT':'http://127.0.0.1:55462','MINIO_ACCESS_KEY':ENV['MINIO_ROOT_USER'],'MINIO_SECRET_KEY':PASSWORD,'MINIO_BUCKET':'g1-'+TOKEN,'REDIS_HOST':'127.0.0.1','REDIS_PORT':'55461','REDIS_PASSWORD':PASSWORD,'REDIS_DB':'0','BULLMQ_PREFIX':'g1-'+TOKEN}
    (WORK/'providers.json').write_text(json.dumps(providers));(WORK/'providers.json').chmod(0o600)
    # Effective-config regression: dotenv override defeats a plausible shell URL.
    hostile=WORK/'override.env';hostile.write_text('DATABASE_URL=postgresql://postgres:fixture@127.0.0.1:5433/fieldframe\n');hostile.chmod(0o600)
    cf=WORK/'override.config.ts'
    text='import {defineConfig} from '+json.dumps(str(ROOT/'node_modules/prisma/config.js'))+'; import dotenv from '+json.dumps(str(ROOT/'node_modules/dotenv/lib/main.js'))+'; dotenv.config({path:'+json.dumps(str(hostile))+',override:true,quiet:true});export default defineConfig({engine:"classic",datasource:{url:process.env.DATABASE_URL}});'
    cf.write_text(text);cf.chmod(0o600)
    ENV['DATABASE_URL']=URL
    issue('dotenv-application-override',request(cf),expected='DISPOSABLE_TARGET_REQUIRED')
    ENV.pop('DATABASE_URL')
    missing=WORK/'missing.config.ts';missing.write_text('import {defineConfig} from '+json.dumps(str(ROOT/'node_modules/prisma/config.js'))+';export default defineConfig({engine:"classic"});');missing.chmod(0o600)
    issue('missing-datasource',request(missing),expected='CONFIG_RESOLUTION_FAILED')
    issue('unapproved-config-hash',request(configSha256='0'*64),expected='UNAPPROVED_CONFIG')
    badset=request();badset['migrationHashes'][next(iter(badset['migrationHashes']))]='0'*64
    issue('unapproved-migration-set',badset,expected='UNAPPROVED_MIGRATION_SET')
    issue('wrong-system-identity',request(postgres={**PG,'systemIdentifier':'12345'}),expected='SYSTEM_IDENTITY_MISMATCH')
    issue('application-system-identity',request(postgres={**PG,'systemIdentifier':'7662655305624969250'}),expected='SYSTEM_IDENTITY_MISMATCH')
    issue('wrong-container',request(postgres={**PG,'id':'0'*64}),expected='CONTAINER_IDENTITY_MISMATCH')
    issue('wrong-binding',request(postgres={**PG,'port':55469}),expected='CONTAINER_BINDING_MISMATCH')
    receipt=issue('approved-baseline',request())
    original_schema=(WORK/'schema.prisma').read_bytes();(WORK/'schema.prisma').write_bytes(original_schema+b'\n// tamper\n')
    launch('schema-checksum-tamper',receipt,expected='APPROVED_FILE_CHANGED',preconnect=True);(WORK/'schema.prisma').write_bytes(original_schema)
    config_bytes=CONFIG.read_bytes();CONFIG.write_bytes(config_bytes+b'\n// tamper\n')
    launch('config-checksum-tamper',receipt,expected='APPROVED_FILE_CHANGED',preconnect=True);CONFIG.write_bytes(config_bytes)
    first=sorted((WORK/'migrations').glob('*/migration.sql'))[0];original=first.read_bytes();first.write_bytes(original+b'\n-- tamper\n')
    launch('migration-checksum-tamper',receipt,expected='APPROVED_FILE_CHANGED',preconnect=True);first.write_bytes(original)
    extra=WORK/'migrations/29990101000000_unapproved';extra.mkdir();(extra/'migration.sql').write_text('SELECT 1;')
    launch('extra-pending-migration',receipt,expected='MIGRATION_SET_CHANGED',preconnect=True);shutil.rmtree(extra)
    launch('unapproved-operation',receipt,op='reset',expected='OPERATION_NOT_APPROVED',preconnect=True)
    # Fault-injected but registry-pinned expired receipt; proves time gate independently.
    expired=json.loads(receipt.read_text());expired['id']=secrets.token_hex(16);expired['id']=expired['id'][:8]+'-'+expired['id'][8:12]+'-'+expired['id'][12:16]+'-'+expired['id'][16:20]+'-'+expired['id'][20:]
    expired['issuedAt']='2000-01-01T00:00:00.000Z';expired['expiresAt']='2000-01-01T00:20:00.000Z'
    ep=WORK/'expired.json';ep.write_text(json.dumps(expired));ep.chmod(0o400)
    registry=Path('/tmp/annotation-platform-db-safety-'+str(os.getuid()));(registry/(expired['id']+'.json')).write_text(json.dumps({'receiptPath':str(ep),'sha256':digest(ep.read_bytes())}));(registry/(expired['id']+'.json')).chmod(0o400);REGISTRATIONS.append(expired['id'])
    launch('expired-receipt',ep,expected='STALE_RECEIPT',preconnect=True)
    launch('full-23-history-absent-shell-url',receipt)
    before=capture();save('recovered-baseline.json',before)
    assert len(before['rows'])==35 and len(before['history'])==23 and len(before['schema'])==1829
    launch('stale-history',receipt,expected='STALE_HISTORY')
    assert capture()==before
    tr=issue('approved-test',request(op='test',command='g1:fixture'))
    sql('CREATE TABLE public.g1_drift_probe (id integer);')
    launch('database-schema-drift',tr,op='test',command='g1:fixture',expected='STALE_DATABASE_SCHEMA')
    sql('DROP TABLE public.g1_drift_probe RESTRICT;')
    assert capture()==before
    # Direct unsafe tests must reject even with a valid receipt for another entry.
    for label,entry,overrides,code in [
        ('wrong-test-entry','prisma/seed.ts',{},'ENTRY_COMMAND_SCOPE_MISMATCH'),
        ('test-target-override','scripts/db-safety/tests/disposable-fixture.test.ts',{'DATABASE_URL':'postgresql://fixture:fixture@127.0.0.1:5433/fieldframe'},'TEST_DATASOURCE_OVERRIDE'),
        ('test-provider-override','scripts/db-safety/tests/disposable-fixture.test.ts',{'REDIS_PORT':'6379'},'TEST_PROVIDER_OVERRIDE')]:
        since=datetime.now(timezone.utc).isoformat()
        p=run(['node','scripts/db-safety/entry-check.mjs',str(ROOT/entry)],env={**ENV,**providers,'DATABASE_URL':URL,'DB_SAFETY_RECEIPT':str(tr),**overrides},check=False)
        save(label+'.log',p.stdout+p.stderr);assert p.returncode and code in p.stderr
        diagnostic=logs(since);save(label+'-postgres.log',diagnostic);assert not re.search(r'statement: (?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)',diagnostic,re.I)
        assert capture()==before
        RESULTS.append({'scenario':label,'pass':True,'rejected':code,'mutatingSql':0})
    launch('test-with-conflicting-shell-url',tr,op='test',command='g1:fixture',extraenv={'DATABASE_URL':'postgresql://forbidden:fixture@127.0.0.1:5433/fieldframe'})
    after=capture();save('after-fixture.json',after);assert before==after
    RESULTS.append({'scenario':'all35-fingerprints-schema-history-unchanged','pass':True,'tables':35,'migrations':23,'manifestEntries':1829})
    # Migration status uses exact verified stage; read-only startup and same canonical URL.
    status=run(['node','node_modules/prisma/build/index.js','migrate','status','--config',str(CONFIG)],env={**ENV,'DATABASE_URL':URL,'PGOPTIONS':'-c default_transaction_read_only=on'})
    save('prisma-status.log',status.stdout+status.stderr);assert 'up to date' in status.stdout
    save('results.json',{'pass':True,'scenarios':RESULTS,'sqlV2Sha256':digest((ROOT/'specs/proposals/phase029-modality/recovery.v2.review.sql').read_bytes())})
except Exception as e:
    save('failure.json',{'errorType':type(e).__name__,'message':str(e).replace(PASSWORD,'[REDACTED]'),'scenarios':RESULTS})
    raise RuntimeError('G1_REHEARSAL_FAILED; inspect evidence '+str(OUT)) from None
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
