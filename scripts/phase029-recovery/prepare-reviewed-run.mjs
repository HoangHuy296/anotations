// FILE STAGING ONLY. Does not execute recovery or change any database.
// Run only after execution approval, writer drain and a fresh read-only capture.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,cpSync,existsSync,realpathSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),root=resolve(import.meta.dirname,'../..');
process.chdir(root);
const [captureDir,stageArg]=process.argv.slice(2);
if(!captureDir||!stageArg||!stageArg.startsWith('/tmp/phase029-approved-recovery-')) throw Error('EXPLICIT_CAPTURE_AND_NEW_STAGE_REQUIRED');
const stage=resolve(stageArg);if(existsSync(stage)) throw Error('STAGING_PATH_ALREADY_EXISTS');
const capture=JSON.parse(readFileSync(join(captureDir,'evidence.json')));
const verification=JSON.parse(readFileSync(join(captureDir,'verification.json')));
if(verification.result!=='PASS') throw Error('UNAMBIGUOUS_MANIFEST_VERIFICATION_REQUIRED');
const identities=capture.schema.value.map(x=>JSON.stringify(x.slice(0,2)));
if(new Set(identities).size!==identities.length) throw Error('AMBIGUOUS_SQL_MANIFEST_REVIEW_REQUIRED');
if(JSON.parse(readFileSync(join(captureDir,'status-result.json'))).exitCode!==0) throw Error('PRISMA_STATUS_FAILED');
const integrity=JSON.parse(readFileSync(join(captureDir,'target-and-integrity.json')));
const hash=x=>createHash('sha256').update(x).digest('hex');
const sql=readFileSync('specs/proposals/phase029-modality/recovery.v2.review.sql');
if(hash(sql)!=='3bb6389f380ffaa5c3be88d26d56782065a00b3844f0326ccba1c05ee4b5a1db') throw Error('SQL_CHANGED');
if(capture.identity.value.systemIdentifier!=='7662655305624969250'||Date.now()-Date.parse(capture.identity.value.capturedAt)>300000) throw Error('WRONG_OR_STALE_CAPTURE');
if(capture.sessions.value.length) throw Error('UNDRAINED_DATABASE_SESSIONS');
if(capture.receipts.value.modalityNonNull!==0||capture.receipts.value.timeNonNull!==0||capture.receipts.value.subjectNonNull!==0) throw Error('RECEIPT_EXISTS');
if(capture.visibility.value.length!==35||capture.visibility.value.some(x=>x.rls||x.forceRls||!x.select)) throw Error('VISIBILITY_CHANGED');
const {loadConfigFromFile}=createRequire(require.resolve('prisma/config'))('@prisma/config');
const resolved=await loadConfigFromFile({configFile:resolve('prisma.config.ts'),configRoot:root});
if(resolved.error) throw Error('CONFIG_FAILED');
const c=resolved.config,u=new URL(c.datasource.url);
if(u.hostname!=='127.0.0.1'||u.port!=='5433'||u.pathname!=='/fieldframe'||[...u.searchParams.keys()].some(k=>k!=='schema')||(u.searchParams.get('schema')||'public')!=='public') throw Error('TARGET_CHANGED');
if(hash(readFileSync(resolved.resolvedPath))!==integrity.configSha256) throw Error('CONFIG_CHANGED');
if(realpathSync(c.migrations.path)!==realpathSync('prisma/migrations')) throw Error('MIGRATION_PATH_CHANGED');
if(capture.history.value.length!==22) throw Error('UNEXPECTED_HISTORY_LENGTH');
const localNames=readdirSync(c.migrations.path,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name).sort();
if(JSON.stringify(localNames)!==JSON.stringify(capture.history.value.map(x=>x.name).sort())) throw Error('UNAPPROVED_PENDING_MIGRATION');
for(const m of capture.history.value){
 if(!m.finishedAt||m.rolledBackAt||hash(readFileSync(join(c.migrations.path,m.name,'migration.sql')))!==m.checksum) throw Error('MIGRATION_HISTORY_MISMATCH');
}
mkdirSync(stage,{mode:0o700});
cpSync(c.migrations.path,join(stage,'migrations'),{recursive:true});
cpSync(c.schema,join(stage,'schema.prisma'));
const correction=join(stage,'migrations/20260930020000_revert_dataset_modality');mkdirSync(correction);
writeFileSync(join(correction,'migration.sql'),sql,{mode:0o400});
// Credential-bearing frozen config is private, transient, never printed or checked in.
writeFileSync(join(stage,'prisma.config.ts'),`import {defineConfig} from ${JSON.stringify(require.resolve('prisma/config'))}; export default defineConfig(${JSON.stringify({schema:join(stage,'schema.prisma'),migrations:{path:join(stage,'migrations')},engine:'classic',datasource:{url:u.toString()}})});`,{mode:0o400});
writeFileSync(join(stage,'receipt.json'),JSON.stringify({sqlSha256:hash(sql),configSha256:hash(readFileSync(join(stage,'prisma.config.ts'))),systemIdentifier:capture.identity.value.systemIdentifier,captureSnapshot:capture.identity.value.snapshot,profile:'application',target:integrity.effectiveTarget,containerId:integrity.containerId,captureDir:resolve(captureDir),schemaSha256:hash(readFileSync(join(stage,'schema.prisma'))),migrationHashes:{...integrity.migrationHashes,'20260930020000_revert_dataset_modality':hash(sql)}},null,2)+'\n');
console.log('STAGED_ONLY',stage);
console.log('No migration command was executed.');
