import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, walk, configTarget, cleanEnv, assertEntryScope } from '../guard.mjs';
const node = (args, cwd=root) => spawnSync(process.execPath,args,{cwd,env:cleanEnv(),encoding:'utf8'});
test('all application test files gate before any fixture import',()=>{
 const paths=['web','worker','realtime'].flatMap(a=>walk(join(root,'apps',a,'tests'))).filter(p=>/\.(test|spec)\.[jt]sx?$/.test(p));
 assert.ok(paths.length>300);
 for(const path of paths)assert.match(readFileSync(path,'utf8').split('\n')[0],/import .*db-safety\/test-entry.cjs/);
});
test('test command catalog cannot reload application env files',()=>{
 const commands=JSON.parse(readFileSync(join(root,'scripts/db-safety/commands.json')));
 for(const command of Object.values(commands))assert.ok(!command.args.some(a=>a.includes('--env-file')));
});
for(const args of [['deploy'],['reset'],['test','web:test:workspace'],['seed','prisma/seed.ts']])test(`unguarded ${args.join(' ')} fails closed`,()=>{
 const p=node(['scripts/db-safety/cli.mjs',...args]);assert.notEqual(p.status,0);assert.match(p.stderr,/SAFETY_ABORT/);
});
for(const command of [['migrate','deploy'],['migrate','dev'],['migrate','reset'],['migrate','deploy','--name','status'],['db','push'],['db','seed'],['studio']])test(`root Prisma ${command.join(' ')} rejects before dotenv`,()=>{
 const p=node(['node_modules/prisma/build/index.js',...command]);assert.notEqual(p.status,0);assert.match(p.stderr+p.stdout,/DB_SAFETY_ROOT_MUTATION_DENIED/);
});
for(const file of ['prisma/seed.ts','prisma/review.seed.ts','apps/web/tests/dataset-modality/seed-history.ts','apps/realtime/tests/security.integration.test.ts','apps/worker/tests/queue/import-dataset-worker.test.ts'])test(`direct unsafe entry rejects: ${file}`,()=>{
 // The test path must exist: a missing file must never count as target protection.
 readFileSync(join(root,file));
 const p=node(['--import','tsx',file]);assert.notEqual(p.status,0);assert.match(p.stderr+p.stdout,/DB_SAFETY_(ENTRY_DENIED|WRITER_DISABLED)/);
});
test('effective config overrides shell: application endpoint is rejected before SQL',async()=>{
 const dir=mkdtempSync('/tmp/phase029-g1-config-test-');
 try {
  const config=join(dir,'prisma.config.ts');
  writeFileSync(config,`import {defineConfig} from '${root}/node_modules/prisma/config.js'; export default defineConfig({engine:'classic',datasource:{url:'postgresql://postgres:fixture@127.0.0.1:5433/fieldframe'}});`,{mode:0o600});
  process.env.DATABASE_URL='postgresql://postgres:fixture@127.0.0.1:55460/fieldframe';
  await assert.rejects(configTarget(config),/DISPOSABLE_TARGET_REQUIRED/);
 }finally{delete process.env.DATABASE_URL;rmSync(dir,{recursive:true,force:true});}
});

test('Vitest receipt binds the selected files and flags, not only the CLI path',()=>{
 const spec=JSON.parse(readFileSync(join(root,'scripts/db-safety/commands.json')))['web:test:source-connections:vitest'];
 const entry=join(root,'apps/web',spec.args[0]);
 assert.doesNotThrow(()=>assertEntryScope(spec,entry,spec.args.slice(1)));
 assert.throws(()=>assertEntryScope(spec,entry,['run','unapproved.spec.ts']),/ENTRY_ARGUMENT_SCOPE_MISMATCH/);
});
