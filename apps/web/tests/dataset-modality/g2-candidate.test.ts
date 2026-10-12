import "../../../../scripts/db-safety/test-entry.cjs";
import test from "node:test";
import assert from "node:assert/strict";
import { resolveEmptyDataset, readDatasetModality } from "@/lib/datasets/modality";
import { db } from "@/lib/db";
import type { RequestActor } from "@/lib/auth";
import { datasetModalities, isModalityTransactionConflict, retryModalityTransaction } from "@annotationplatform/domain";
import { Prisma, PrismaClient } from "@internal/db";

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

test("an insert before EMPTY resolution is refused without changing the parent or its first-assignment receipt", { timeout: 20_000 }, async () => {
  const datasetId = "g2-insert-first-empty";
  const before = await state(datasetId);
  const writer = new PrismaClient();
  const resolver = new PrismaClient();
  try {
    await assert.rejects(writer.asset.create({
      data: { id: "g2-insert-first-asset", datasetId, filename: "insert-first.png", relativePath: "insert-first.png", sourceFingerprint: "g2:insert-first", modality: "IMAGE", mimeType: "image/png" },
      select: { id: true },
    }), /DATASET_MODALITY_UNRESOLVED/);
    assert.equal(await writer.asset.count({ where: { datasetId } }), 0);
    assert.deepEqual(await state(datasetId), before, "the rejected insert rolls back its attempted parent fence");

    const resolved = await resolveEmptyDataset(owner, datasetId, "IMAGE", resolver);
    assert.equal(resolved.ok, true);
    if (!resolved.ok) throw new Error("Expected EMPTY resolution after the rejected insert");
    const after = await state(datasetId);
    assert.equal(after.modality, "IMAGE");
    assert.equal(after.modalityResolverSubject, owner.id);
    assert.equal(after.modalityResolvedAt?.toISOString(), resolved.data.resolvedAt);
    assert.equal(after.modalityContentRevision, before.modalityContentRevision + BigInt(1));
    assert.deepEqual(await resolveEmptyDataset(owner, datasetId, "IMAGE", resolver), resolved);
    assert.deepEqual(await state(datasetId), after, "same-value replay preserves the original receipt and fence");
  } finally {
    await Promise.allSettled([writer.$disconnect(), resolver.$disconnect()]);
  }
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function awaitBarrier(promise: Promise<void>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function resolutionInsertRace(datasetId: string, modality: "IMAGE" | "AUDIO") {
  const before = await state(datasetId);
  const resolver = new PrismaClient();
  const writer = new PrismaClient();
  const fenceHeld = barrier();
  const releaseFence = barrier();
  const insertStarted = barrier();
  const assetId = `${datasetId}-asset`;
  const conflicts: unknown[] = [];
  let attempts = 0;
  let paused = false;

  // Extensions observe real Prisma queries; they neither replace a database
  // operation nor fabricate its result. The service's first parent UPDATE
  // has acquired the actual fence before the independent writer starts.
  const resolutionClient = resolver.$extends({
    query: {
      dataset: {
        async update({ args, query }) {
          const result = await query(args);
          if (!paused && args.where.id === datasetId && args.data.modality === undefined && args.data.modalityContentRevision !== undefined) {
            paused = true;
            fenceHeld.release();
            await releaseFence.promise;
          }
          return result;
        },
      },
    },
  });
  const writerClient = writer.$extends({
    query: {
      asset: {
        async create({ args, query }) {
          const pending = query(args);
          if (args.data.id === assetId) insertStarted.release();
          return pending;
        },
      },
    },
  });
  // This cast only restores the base-client type the service accepts; query
  // extensions preserve its real transaction and database behavior.
  const resolution = resolveEmptyDataset(owner, datasetId, "IMAGE", resolutionClient as unknown as typeof db);
  const resolutionSettled = resolution.then(
    result => ({ ok: true as const, result }),
    error => ({ ok: false as const, error }),
  );
  let insertionSettled: Promise<{ ok: true; result: { id: string } } | { ok: false; error: unknown }> | undefined;
  try {
    await awaitBarrier(fenceHeld.promise, "the resolution fence");
    const insertion = retryModalityTransaction(async () => {
      attempts += 1;
      try {
        return await writerClient.$transaction(async tx => {
          const snapshot = await tx.dataset.findUniqueOrThrow({ where: { id: datasetId }, select: { modality: true, modalityContentRevision: true } });
          if (attempts === 1) {
            assert.equal(snapshot.modality, null, "the independent writer observes the historical snapshot while the resolution fence is uncommitted");
            assert.equal(snapshot.modalityContentRevision, before.modalityContentRevision);
          } else {
            assert.equal(snapshot.modality, "IMAGE", "the whole-transaction retry reloads the committed Dataset authority");
          }
          return tx.asset.create({
            data: { id: assetId, datasetId, filename: `${assetId}.fixture`, relativePath: `${assetId}.fixture`, sourceFingerprint: `g2:${assetId}`, modality, mimeType: modality === "IMAGE" ? "image/png" : "audio/wav" },
            select: { id: true },
          });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000, maxWait: 5_000 });
      } catch (error) {
        if (isModalityTransactionConflict(error)) conflicts.push(error);
        throw error;
      }
    });
    insertionSettled = insertion.then(
      result => ({ ok: true as const, result }),
      error => ({ ok: false as const, error }),
    );
    await awaitBarrier(insertStarted.promise, "the independent insert query");
    releaseFence.release();
    const [resolutionResult, insertionResult] = await Promise.all([resolutionSettled, insertionSettled]);
    if (!resolutionResult.ok) throw resolutionResult.error;
    const resolved = resolutionResult.result;
    assert.equal(resolved.ok, true);
    if (!resolved.ok) throw new Error("Expected the fenced EMPTY resolution to commit first");
    assert.equal(conflicts.length, 1, "the writer's stale Serializable snapshot must conflict with the committed resolution fence");
    assert.equal(attempts, 2, "the conflict retries the complete writer transaction once");
    if (modality === "IMAGE") {
      if (!insertionResult.ok) throw insertionResult.error;
      assert.equal(insertionResult.result.id, assetId);
      assert.equal(await writer.asset.count({ where: { datasetId, modality: "IMAGE" } }), 1);
    } else {
      assert.equal(insertionResult.ok, false);
      if (insertionResult.ok) throw new Error("An incompatible insert must not commit");
      assert.match(String(insertionResult.error), /ASSET_MODALITY_MISMATCH/);
      assert.equal(await writer.asset.count({ where: { datasetId } }), 0);
    }
    const after = await state(datasetId);
    assert.equal(after.modality, "IMAGE");
    assert.equal(after.modalityResolverSubject, owner.id);
    assert.equal(after.modalityResolvedAt?.toISOString(), resolved.data.resolvedAt);
    assert.equal(after.modalityContentRevision, before.modalityContentRevision + BigInt(modality === "IMAGE" ? 2 : 1), "failed insert attempts roll back their fences; only committed writes remain");
    assert.deepEqual(await resolveEmptyDataset(owner, datasetId, "IMAGE", resolver), resolved);
    assert.deepEqual(await state(datasetId), after, "replay cannot replace the first-assignment receipt or advance the fence");
  } finally {
    releaseFence.release();
    await Promise.allSettled([resolutionSettled, ...(insertionSettled ? [insertionSettled] : [])]);
    await Promise.allSettled([resolver.$disconnect(), writer.$disconnect()]);
  }
}

test("EMPTY resolution serializes a compatible insert through a real parent-fence conflict and whole-transaction retry", { timeout: 20_000 }, async () => {
  await resolutionInsertRace("g2-resolve-compatible-empty", "IMAGE");
});

test("EMPTY resolution rejects an incompatible concurrent insert without preserving either failed insert fence", { timeout: 20_000 }, async () => {
  await resolutionInsertRace("g2-resolve-incompatible-empty", "AUDIO");
});
test.after(async()=>{await db.$disconnect();});
