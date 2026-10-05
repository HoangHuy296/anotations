import "../../../../scripts/db-safety/test-entry.cjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveEmptyDataset } from "@/lib/datasets/modality";
import { isModalityTransactionConflict } from "@annotationplatform/domain";
import { db } from "@/lib/db";

const receipt = JSON.parse(readFileSync(process.env.DB_SAFETY_RECEIPT!, "utf8"));

test("synthetic unresolved history is seeded only after complete recovered 23-migration baseline", async () => {
  const { PrismaClient } = await import(pathToFileURL(join(dirname(receipt.config), "baseline-client/client.ts")).href);
  const baseline = new PrismaClient();
  try {
    await baseline.$transaction(async (tx: typeof baseline) => {
      for (const [id,role] of [["g2-owner","MANAGER"],["g2-admin","ADMIN"],["g2-manager","MANAGER"],["g2-former-admin","LABELER"],["g2-receipt-actor","ADMIN"]]) {
        await tx.user.create({data:{id,email:`${id}@test.invalid`,role},select:{id:true}});
      }
      for (const name of ["empty","admin-empty","mixed","single","deleted-child","archived","deleted","former-admin-empty"]) {
        await tx.dataset.create({data:{id:`g2-${name}`,name,ownerId:"g2-owner",...(name==="archived"?{archivedAt:new Date()}:{}),...(name==="deleted"?{deletedAt:new Date()}:{}),metadata:{workflowStatus:"COMPLETED"}},select:{id:true}});
      }
      await tx.datasetMember.create({data:{datasetId:"g2-empty",userId:"g2-manager",role:"MANAGER"},select:{id:true}});
      for(const [id,parent,modality] of [["single","single","IMAGE"],["mixed-image","mixed","IMAGE"],["mixed-audio","mixed","AUDIO"],["deleted","deleted-child","TEXT"]]) {
        await tx.asset.create({data:{id:`g2-asset-${id}`,datasetId:`g2-${parent}`,filename:id,relativePath:id,sourceFingerprint:`g2-fixture:${id}`,modality,mimeType:modality==="IMAGE"?"image/png":modality==="AUDIO"?"audio/wav":"text/plain",...(id==="deleted"?{deletedAt:new Date()}: {})},select:{id:true}});
      }
      await tx.label.create({data:{id:"g2-label",datasetId:"g2-single",name:"Object",normalizedName:"object",color:"#123456"},select:{id:true}});
      await tx.annotation.create({data:{id:"g2-annotation",datasetId:"g2-single",assetId:"g2-asset-single",labelId:"g2-label",createdById:"g2-owner",modality:"IMAGE",type:"BOUNDING_BOX",revision:7,geometry:{x:0.1,y:0.2,width:0.3,height:0.4}},select:{id:true}});
    });
    // Missing candidate fields must propagate as a fault, never a successful retry conflict.
    await assert.rejects(resolveEmptyDataset({id:"g2-owner",role:"MANAGER",email:"",name:""},"g2-empty","IMAGE"), error => !isModalityTransactionConflict(error));
  } finally {await baseline.$disconnect();await db.$disconnect();}
});
