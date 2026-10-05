import "./db-safety/deny-entry.cjs"; // G1: live mutating probes require separate authorization.
import { mkdir, writeFile } from 'node:fs/promises';
import { normalizeAiozOutput } from '../apps/worker/src/providers/ai/aioz-annotation-services-normalization';
import { getAiozAnnotationServicesConfig } from '../apps/worker/src/config';
async function main() {
 const config = getAiozAnnotationServicesConfig();
 const origin = config.baseUrl;
 const imageUrl = process.env.AIOZ_VERIFY_IMAGE_URL;
 const modelId = process.env.AIOZ_VERIFY_MODEL_ID;
 const classes: unknown = JSON.parse(process.env.AIOZ_VERIFY_CLASSES ?? 'null');
 if (!imageUrl || !modelId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(modelId)
   || !Array.isArray(classes) || !classes.length || !classes.every((value) => typeof value === 'string' && value.trim())) throw new Error('Verification configuration is incomplete.');
 const image = new URL(imageUrl);
 if (!['http:', 'https:'].includes(image.protocol) || image.username || image.password) throw new Error('Invalid verification image URL.');
 await mkdir('artifacts/ai-detect', { recursive: true });
 const headers={'Content-Type':'application/json','API-Key':config.apiKey};
 async function call(path:string, body?:unknown) {
  const r=await fetch(new URL(path, origin),{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(config.timeoutMs)});
  if(!r.ok) throw new Error('Provider HTTP '+r.status);
  const data=await r.json(); if(!data.success) throw new Error('Provider reported failure');return data.data;
 }
 const created=await call('/api/v1/tasks/create',{task_name:'image',files:[imageUrl],model_id:modelId,classes,confidence_threshold:0.5,iou_threshold:0.5});
 console.log('Created task:',created.task_id);
 await writeFile('artifacts/ai-detect/live-task.json',JSON.stringify({taskId:created.task_id},null,2));
 let result;
 for(let i=0;i<60;i++) {
  result=await call('/api/v1/tasks/result/'+encodeURIComponent(created.task_id));
  if(result.status==='success') break;
  if(result.status==='failed') throw new Error('Detection failed');
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 if(result?.status!=='success') throw new Error('Polling timed out');
 const predictions=normalizeAiozOutput(result.output,[{assetId:'external-image-preview',imageUrl}]);
 await writeFile('artifacts/ai-detect/normalized.json',JSON.stringify({taskId:created.task_id,predictions},null,2));
 const response=await fetch(imageUrl,{redirect:'error',signal:AbortSignal.timeout(config.timeoutMs)});if(!response.ok) throw new Error('Image HTTP '+response.status);
 const bytes=Buffer.from(await response.arrayBuffer());
 await writeFile('artifacts/ai-detect/source.jpeg',bytes);
 const {width,height}=result.output[0];
 const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
 const boxes=predictions.map(p=>{const b=p.boundingBoxes as {x:number;y:number;width:number;height:number};return `<rect x="${b.x*width}" y="${b.y*height}" width="${b.width*width}" height="${b.height*height}" fill="none" stroke="#22e593" stroke-width="3"/><text x="${b.x*width+4}" y="${b.y*height-8}" fill="white" stroke="#13251d" stroke-width="3" paint-order="stroke" font-family="sans-serif" font-size="15">${escape(p.labelKey)} ${(p.confidence*100).toFixed(1)}%</text>`;}).join('');
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><image href="data:image/jpeg;base64,${bytes.toString('base64')}" width="${width}" height="${height}"/>${boxes}</svg>`;
 await writeFile('artifacts/ai-detect/result.svg',svg);
 await writeFile('artifacts/ai-detect/result.html',`<!doctype html><html><meta charset="utf-8"><title>AI detection result</title><style>body{background:#141819;color:#fff;font:16px system-ui;max-width:700px;margin:32px auto;padding:20px}svg{max-height:75vh;width:100%}</style><h1>AI detection result</h1><p>${predictions.length} detections · task ${escape(created.task_id)}</p>${svg}</html>`);
 console.log('Normalized and rendered:',predictions.length,'detections');
}
main().catch(()=>{console.error('Live verification failed; inspect the saved task ID before retrying submission.');process.exitCode=1;});
