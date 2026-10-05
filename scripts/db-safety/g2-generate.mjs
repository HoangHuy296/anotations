// G2 filesystem generation only, still entered via a verified disposable test receipt.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verify, root, must, sha, redact, cleanEnv } from './guard.mjs';
const receipt=process.env.DB_SAFETY_RECEIPT;
const {r,target}=await verify(receipt,'test');
must(r.command==='g2:generate','COMMAND_SCOPE_MISMATCH');
const work=dirname(r.config), schema=join(root,'prisma/schema.prisma');
must(sha(readFileSync(schema))===r.files[r.schema],'SOURCE_SCHEMA_MISMATCH');
const folder=join(work,'generation');mkdirSync(folder,{mode:0o700});
try {
 const source=readFileSync(schema,'utf8');
 const baseline=source.replace(/model Dataset \{[\s\S]*?^\}/m, block=>block.split('\n').filter(line=>!/^\s*(modality\s+Modality\?|modalityContentRevision\s+BigInt|modalityResolvedAt\s+DateTime\?|modalityResolverSubject\s+String\?)/.test(line)).join('\n')).replace('output   = "../lib/generated/prisma"',`output   = ${JSON.stringify(join(work,'baseline-client'))}`);
 const oldSchema=join(folder,'baseline.prisma');writeFileSync(oldSchema,baseline,{mode:0o600});
 for(const [name,path] of [['baseline',oldSchema],['canonical',schema]]) {
   const config=join(folder,name+'.config.ts');
   writeFileSync(config,`import {defineConfig} from ${JSON.stringify(join(root,'node_modules/prisma/config.js'))};export default defineConfig(${JSON.stringify({schema:path,engine:'classic',datasource:{url:target.url.toString()}})});`,{mode:0o400});
   // No inherited dotenv or preload flags. URL has already been independently verified.
   const p=spawnSync(process.execPath,[join(root,'node_modules/prisma/build/index.js'),'generate','--config',config],{cwd:root,env:{...cleanEnv(),DATABASE_URL:target.url.toString()},encoding:'utf8'});
   console.log(redact(p.stdout+p.stderr));must(p.status===0,'G2_GENERATION_FAILED');
 }
} finally {rmSync(folder,{recursive:true,force:true});}
