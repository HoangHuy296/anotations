import "../../../../scripts/db-safety/test-entry.cjs";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveEmptyDataset, readDatasetModality } from "@/lib/datasets/modality";
import { db } from "@/lib/db";
import type { RequestActor } from "@/lib/auth";
import { datasetModalities } from "@annotationplatform/domain";

const actor = (id:string, role: RequestActor["role"] = "MANAGER"):RequestActor => ({id,role,email:"",name:""});
const owner=actor("g2-owner"),admin=actor("g2-admin","ADMIN");
const state=(id:string)=>db.dataset.findUniqueOrThrow({where:{id},select:{modality:true,modalityContentRevision:true,modalityResolvedAt:true,modalityResolverSubject:true,updatedAt:true,visualizationGeneration:true}});

test("historical EMPTY SINGLE MIXED and deleted children remain unresolved; only EMPTY is eligible", async () => {
  for(const [id,resolution,eligible] of [["empty","EMPTY_UNRESOLVED",true],["single","SINGLE_UNRESOLVED",false],["mixed","MIXED_UNRESOLVED",false],["deleted-child","SINGLE_UNRESOLVED",false]] as const){
    const result=await readDatasetModality(owner,`g2-${id}`);
    assert.equal(result?.modality,null);assert.equal(result?.modalityResolution,resolution);assert.equal(result?.canResolve,eligible);
  }
  assert.equal((await readDatasetModality(actor("g2-manager"),"g2-empty"))?.canResolve,false);
  assert.equal(await readDatasetModality(owner,"g2-archived"),null);
  assert.equal(await readDatasetModality(owner,"g2-deleted"),null);
});
test("rejected SINGLE MIXED and deleted-child requests roll back the entire parent fence", async () => {
  for(const id of ["g2-single","g2-mixed","g2-deleted-child"]){
    const before=await state(id);const result=await resolveEmptyDataset(owner,id,"IMAGE");
    assert.deepEqual(result,{ok:false,code:"DATASET_NOT_EMPTY",status:409});
    assert.deepEqual(await state(id),before);
  }
});
test("OWNER/system ADMIN only, current persisted role, archived/deleted denial", async () => {
  const before=await state("g2-empty");
  assert.deepEqual(await resolveEmptyDataset(actor("g2-manager"),"g2-empty","IMAGE"),{ok:false,code:"FORBIDDEN",status:403});
  assert.deepEqual(await resolveEmptyDataset(actor("g2-former-admin","ADMIN"),"g2-empty","IMAGE"),{ok:false,code:"FORBIDDEN",status:403});
  assert.deepEqual(await state("g2-empty"),before);
  assert.equal(await readDatasetModality(actor("g2-former-admin","ADMIN"),"g2-empty"),null);
  for(const id of ["g2-archived","g2-deleted"])assert.deepEqual(await resolveEmptyDataset(admin,id,"IMAGE"),{ok:false,code:"DATASET_NOT_FOUND",status:404});
});
test("one-time EMPTY assignment, immutable safe receipt, same-value replay and current authorization", async () => {
  const resolved=await resolveEmptyDataset(owner,"g2-empty","IMAGE");assert.equal(resolved.ok,true);
  if(!resolved.ok)throw new Error("Expected resolution");
  assert.deepEqual(Object.keys(resolved.data).sort(),["id","modality","modalityResolution","resolvedAt"].sort());
  const before=await state("g2-empty");assert.equal(before.modalityResolverSubject,owner.id);assert.equal(before.modalityContentRevision,BigInt(1));
  assert.deepEqual(await resolveEmptyDataset(owner,"g2-empty","IMAGE"),resolved);assert.deepEqual(await state("g2-empty"),before);
  assert.deepEqual(await resolveEmptyDataset(owner,"g2-empty","AUDIO"),{ok:false,code:"DATASET_MODALITY_IMMUTABLE",status:409});
  assert.equal((await readDatasetModality(owner,"g2-empty"))?.canResolve,false);
  assert.deepEqual(await resolveEmptyDataset(actor("g2-manager"),"g2-empty","IMAGE"),{ok:false,code:"FORBIDDEN",status:403});
  assert.equal((await resolveEmptyDataset(admin,"g2-admin-empty","VIDEO")).ok,true);
});
test("database enforces explicit modality, immutable empty parent, receipt shape and all four enum values", async () => {
  await assert.rejects(db.dataset.create({data:{id:"g2-invalid-new",name:"invalid",ownerId:owner.id},select:{id:true}}));
  await assert.rejects(db.dataset.update({where:{id:"g2-empty"},data:{modality:"TEXT"},select:{id:true}}));
  await assert.rejects(db.dataset.update({where:{id:"g2-empty"},data:{modality:null,modalityResolverSubject:null,modalityResolvedAt:null},select:{id:true}}));
  await assert.rejects(db.dataset.update({where:{id:"g2-empty"},data:{modalityResolverSubject:"forged"},select:{id:true}}));
  await assert.rejects(db.dataset.update({where:{id:"g2-empty"},data:{modalityResolvedAt:new Date(0)},select:{id:true}}));
  await assert.rejects(db.dataset.update({where:{id:"g2-empty"},data:{modalityContentRevision:BigInt(0)},select:{id:true}}));
  for(const modality of datasetModalities){
    const row=await db.dataset.create({data:{id:`g2-new-${modality}`,name:modality,ownerId:owner.id,modality,modalityResolverSubject:owner.id,modalityResolvedAt:new Date(0)},select:{modality:true,modalityResolvedAt:true}});
    assert.equal(row.modality,modality);assert.ok(row.modalityResolvedAt!.getTime()>0);
  }
  await assert.rejects(db.dataset.create({data:{name:"bad receipt",ownerId:owner.id,modality:"IMAGE",modalityResolverSubject:""},select:{id:true}}));
});
test("opaque subject survives actor deletion without FK cascade or clearing the receipt", async () => {
  const id="g2-subject-lifetime";
  await db.dataset.create({data:{id,name:id,ownerId:owner.id,modality:"IMAGE",modalityResolverSubject:"g2-receipt-actor"},select:{id:true}});
  const before=await state(id);await db.user.delete({where:{id:"g2-receipt-actor"},select:{id:true}});assert.deepEqual(await state(id),before);
});
test("candidate rejects incompatible writes and assignment against deleted history (sequential smoke only)", async () => {
  const data={id:"g2-new-asset",filename:"sample",relativePath:"sample",sourceFingerprint:"g2:sample",mimeType:"audio/wav",modality:"AUDIO" as const};
  await assert.rejects(db.asset.create({data:{...data,datasetId:"g2-empty"},select:{id:true}}));
  await assert.rejects(db.asset.create({data:{...data,datasetId:"g2-mixed"},select:{id:true}}));
  await assert.rejects(db.dataset.update({where:{id:"g2-deleted-child"},data:{modality:"IMAGE",modalityResolverSubject:owner.id},select:{id:true}}));
  assert.equal((await state("g2-mixed")).modality,null);
  const annotation=await db.annotation.findUniqueOrThrow({where:{id:"g2-annotation"},select:{revision:true,geometry:true}});
  assert.equal(annotation.revision,7);assert.deepEqual(annotation.geometry,{x:0.1,y:0.2,width:0.3,height:0.4});
});
test.after(async()=>{await db.$disconnect();});
