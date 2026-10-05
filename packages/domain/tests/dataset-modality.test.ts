import test from "node:test";
import assert from "node:assert/strict";
import { datasetModalities, datasetModalityStateSchema, datasetModalityResolutionInputSchema, datasetModalityReceiptSchema, projectDatasetModality, datasetWorkspaceEngine, assertAssetModality, canResolveEmptyDataset, isModalityTransactionConflict, retryModalityTransaction } from "../src/dataset-modality";

test("four resolved modalities are authoritative, including empty content", () => {
  for (const modality of datasetModalities) {
    assert.equal(datasetWorkspaceEngine(projectDatasetModality(modality, [])), modality);
    assert.equal(datasetWorkspaceEngine(projectDatasetModality(modality, ["TEXT", "AUDIO"])), modality);
    assertAssetModality(modality, modality);
    for (const other of datasetModalities.filter(m => m !== modality)) assert.throws(() => assertAssetModality(modality, other), /ASSET_MODALITY_MISMATCH/);
  }
});
test("historical EMPTY SINGLE MIXED are explicit and never infer an engine", () => {
  for (const [assets, expected] of [[[], "EMPTY_UNRESOLVED"], [["IMAGE", "IMAGE"], "SINGLE_UNRESOLVED"], [["IMAGE", "AUDIO"], "MIXED_UNRESOLVED"]] as const) {
    const state = projectDatasetModality(null, assets);
    assert.equal(state.modalityResolution, expected); assert.equal(datasetWorkspaceEngine(state), null);
  }
  assert.throws(() => assertAssetModality(null, "IMAGE"), /DATASET_MODALITY_UNRESOLVED/);
});
test("DTO validates state pairing and rejects browser-supplied receipts or inferred defaults", () => {
  assert.equal(datasetModalityStateSchema.safeParse({ modality: "IMAGE", modalityResolution: "EMPTY_UNRESOLVED" }).success, false);
  for (const input of [{}, {modality:null}, {modality:"image"}, {modality:"MIXED"}, {modality:"IMAGE",modalityResolverSubject:"forged"}]) assert.equal(datasetModalityResolutionInputSchema.safeParse(input).success, false);
  assert.equal(datasetModalityReceiptSchema.safeParse({id:"id",modality:"IMAGE",modalityResolution:"RESOLVED",resolvedAt:null}).success, false);
});
test("only actual owner/system ADMIN authority, never dataset MANAGER implicitly", () => {
  assert.equal(canResolveEmptyDataset({id:"owner",role:"LABELER"},"owner"),true);
  assert.equal(canResolveEmptyDataset({id:"other",role:"ADMIN"},"owner"),true);
  assert.equal(canResolveEmptyDataset({id:"other",role:"MANAGER"},"owner"),false);
});
test("retries whole P2034 transactions within bounds, not schema/auth/integrity errors", async () => {
  let attempts=0;
  assert.equal(await retryModalityTransaction(async()=>{ if(++attempts<3)throw {code:"P2034"};return "ok";}),"ok");
  assert.equal(attempts,3);
  for(const code of ["P2022","P2004","FORBIDDEN"]){
    attempts=0;await assert.rejects(retryModalityTransaction(async()=>{attempts++;throw {code};}));assert.equal(attempts,1);
    assert.equal(isModalityTransactionConflict({code}),false);
  }
  attempts=0;await assert.rejects(retryModalityTransaction(async()=>{attempts++;throw {code:"P2034"};}));assert.equal(attempts,3);
  await assert.rejects(retryModalityTransaction(async()=>null,0),RangeError);
});

const connector = (state="40P01", message="deadlock detected") => Object.assign(new Error(
  `Invalid \`tx.dataset.update()\` invocation\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${state}", message: "${message}", severity: "ERROR", detail: Some("Process 598 waits for ShareLock on transaction 910; blocked by process 596.\\nProcess 596 waits for ShareLock on transaction 911; blocked by process 598."), column: None, hint: Some("See server log for query details.") }), transient: false })`
), {name:"PrismaClientUnknownRequestError",clientVersion:"6.19.3"});
const rawConflict=(code:string)=>Object.assign(new Error("Raw query failed"),{name:"PrismaClientKnownRequestError",clientVersion:"6.19.3",code:"P2010",meta:{code,message:"database diagnostic"}});
test("verified versioned connector and structured raw SQLSTATE contracts",()=>{
  assert.equal(isModalityTransactionConflict(connector()),true);
  for(const state of ["40P01","40001"])assert.equal(isModalityTransactionConflict(rawConflict(state)),true);
});
test("unrelated, malformed, ambiguous or unverified wrappers never retry",()=>{
  const errors:unknown[]=[null,undefined,"40P01",{code:"40P01"},{code:"40001"},{cause:{code:"40P01"}},new Error("deadlock detected 40P01"),rawConflict("23505"),rawConflict("23503"),rawConflict("57014"),Object.assign(rawConflict("40P01"),{code:"P2004"}),Object.assign(rawConflict("40001"),{meta:{code:40001}}),Object.assign(connector(),{clientVersion:"7.0.0"}),Object.assign(connector(),{name:"Error"}),Object.assign(connector(),{code:"P2022"}),Object.assign(connector(),{cause:{code:"40P01"}}),{...connector(),message:connector().message},connector("23505"),connector("40P01","could not serialize access due to concurrent update"),connector("40001"),connector("40001","could not serialize access due to concurrent update")];
  for(const mutate of [(s:string)=>s+" extra",(s:string)=>s.replace("column: None","column: Some(\"code\")"),(s:string)=>s.replace("severity: \"ERROR\"","severity: \"WARNING\""),(s:string)=>s.replace("transient: false","transient: true"),(s:string)=>s.replace("detail: Some(","detail: Broken("),(s:string)=>"Error occurred during query execution:\n"+s]){
    const e=connector();e.message=mutate(e.message);errors.push(e);
  }
  for(const error of errors)assert.equal(isModalityTransactionConflict(error),false);
});
test("connector and raw conflicts preserve default bound and rethrow exact exhausted error",async()=>{
  for(const error of [connector(),rawConflict("40001"),rawConflict("40P01")]){
    let attempts=0;await assert.rejects(retryModalityTransaction(async()=>{attempts++;throw error;}),e=>e===error);assert.equal(attempts,3);
    attempts=0;assert.equal(await retryModalityTransaction(async()=>{if(++attempts===1)throw error;return "committed";}),"committed");assert.equal(attempts,2);
  }
  let attempts=0;const error=rawConflict("23505");await assert.rejects(retryModalityTransaction(async()=>{attempts++;throw error;}),e=>e===error);assert.equal(attempts,1);
});
