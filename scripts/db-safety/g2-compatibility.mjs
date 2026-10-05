import {join,dirname} from 'node:path';
import {writeFileSync,rmSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {verify,root,cleanEnv,must,redact} from './guard.mjs';
const {r,target}=await verify(process.env.DB_SAFETY_RECEIPT,'test');
must(r.command==='g2:compatibility','COMMAND_SCOPE_MISMATCH');
const path=join(dirname(r.config),'compatibility.config.ts');
try {
 writeFileSync(path,`import {defineConfig} from ${JSON.stringify(join(root,'node_modules/prisma/config.js'))};export default defineConfig(${JSON.stringify({schema:target.schema,engine:'classic',datasource:{url:target.url.toString()},migrations:{path:target.migrations}})});`,{mode:0o400});
 for(const args of [['migrate','diff','--from-schema-datasource',target.schema,'--to-schema-datamodel',target.schema,'--exit-code'],['migrate','status']]){
   const p=spawnSync(process.execPath,[join(root,'node_modules/prisma/build/index.js'),...args,'--config',path],{cwd:root,env:{...cleanEnv(),DATABASE_URL:target.url.toString(),PGOPTIONS:'-c default_transaction_read_only=on'},encoding:'utf8'});
   console.log(redact(p.stdout+p.stderr));must(p.status===0,'G2_SCHEMA_COMPATIBILITY_FAILED');
 }
 const client=readFileSync(join(root,'lib/generated/prisma/models/Dataset.ts'),'utf8');
 for(const name of ['modality','modalityContentRevision','modalityResolvedAt','modalityResolverSubject'])must(client.includes(name),'G2_CLIENT_FIELD_MISSING');
 console.log('G2_SCHEMA_HISTORY_CLIENT_COMPATIBLE');
}finally{rmSync(path,{force:true});}
