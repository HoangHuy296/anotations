import "../../../../scripts/db-safety/deny-entry.cjs"; // G1: pre-recovery fixture is not approved for the recovered baseline.
// Isolated fixture preparation BEFORE Phase029 migration; never production/backfill.
import { PrismaClient } from '../../../../lib/generated/prisma/client';
const url = process.env.DATABASE_URL!;
if (!url?.includes('127.0.0.1:55439/phase029_baseline')) throw new Error('Disposable database only');
const db = new PrismaClient({datasources:{db:{url}}});
async function main(){
 await db.user.create({data:{id:'p029-owner',email:'p029-owner@test.invalid',role:'MANAGER'},select:{id:true}});
 for(const id of ['empty','single','mixed','archived','race','delete-race']) await db.dataset.create({data:{id:`p029-${id}`,ownerId:'p029-owner',name:id},select:{id:true}});
 for(const [id,parent,modality] of [['single-image','single','IMAGE'],['mixed-image','mixed','IMAGE'],['mixed-audio','mixed','AUDIO'],['archived-image','archived','IMAGE'],['archived-audio','archived','AUDIO']] as const){await db.asset.create({data:{id:`p029-${id}`,datasetId:`p029-${parent}`,filename:id,relativePath:id,sourceFingerprint:`phase029-fixture:${id}`,modality,mimeType:modality==='IMAGE'?'image/png':'audio/wav',...(id==='archived-audio'?{deletedAt:new Date()}: {})},select:{id:true}})}
}
main().finally(()=>db.$disconnect());
