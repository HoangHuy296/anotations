#!/usr/bin/env node
// Phase 029 fresh-install MVP black-box acceptance (real PostgreSQL, Redis, MinIO, Gitea over HTTP).
// Read-only SELECTs against the disposable MVP database are used only as publication evidence.
// No secret is printed or written: user passwords are random per run and never logged.
//
//   NODE_EXTRA_CA_CERTS=<tls dir>/gitea.crt node scripts/mvp/acceptance/run.mjs --label red|green [--web http://127.0.0.1:3300]
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const LABEL = args.label ?? "run";
const WEB = args.web ?? "http://127.0.0.1:3300";
const GITEA_HOST = args.gitea ?? "https://localhost:3310";
const GITEA_INTERNAL = "https://gitea:3000";
const PG_CONTAINER = "phase029-g1-mvp-postgres";
const GITEA_CONTAINER = "annotationplatformmvp-gitea-1";
const runId = `${LABEL}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z")}`;
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), "../../../specs/029-modality-specific-datasets/verification/mvp-acceptance", runId);

const results = [];
const check = (flow, id, pass, observed, expected) => { results.push({ flow, id, pass: Boolean(pass), expected, observed }); console.log(`${pass ? "PASS" : "FAIL"} [${flow}] ${id}`); };
class FixtureError extends Error {}

// ---------- fixtures ----------
function crc32(buf) { let c, crc = ~0; for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(seed = 0) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(4 * (1 + 12), 0); for (let i = 0; i < raw.length; i++) raw[i] = (i + seed) % 251;
  for (let r = 0; r < 4; r++) raw[r * 13] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// ---------- http ----------
class Session {
  constructor(label) { this.label = label; this.cookie = ""; }
  async req(method, url, body, extra = {}) {
    const headers = { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}), ...extra };
    const res = await fetch(url.startsWith("http") ? url : WEB + url, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), redirect: "manual" });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  async register(role = "MANAGER") {
    this.email = `mvp-${this.label}-${randomBytes(4).toString("hex")}@example.test`;
    const password = randomBytes(12).toString("hex") + "Aa1!";
    const signup = await this.req("POST", "/api/auth/signup", { email: this.email, password, name: this.label, role });
    if (signup.status !== 201) throw new FixtureError(`signup ${signup.status}`);
    const login = await fetch(WEB + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: this.email, password }) });
    if (login.status !== 200) throw new FixtureError(`login ${login.status}`);
    this.cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    if (!this.cookie) throw new FixtureError("no session cookie");
    return this;
  }
}
const sql = (q) => execFileSync("docker", ["exec", PG_CONTAINER, "psql", "-U", "postgres", "-d", "fieldframe", "-tAc", q], { encoding: "utf8" }).trim();
const assetCount = (datasetId) => Number(sql(`select count(*) from "Asset" where "datasetId"='${datasetId.replace(/[^A-Za-z0-9-]/g, "")}'`));
const datasetModalityDb = (datasetId) => sql(`select modality from "Dataset" where id='${datasetId.replace(/[^A-Za-z0-9-]/g, "")}'`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollJob(s, jobId, ms = 120_000) {
  const end = Date.now() + ms; let last = null;
  while (Date.now() < end) {
    const r = await s.req("GET", `/api/jobs/${jobId}`); last = r.json?.data ?? r.json;
    if (last && ["COMPLETED", "FAILED", "CANCELLED", "PARTIAL", "SUCCEEDED", "REJECTED"].includes(last.status)) return last;
    await sleep(1500);
  }
  return last;
}

// ---------- gitea ----------
const gt = { user: `mvp${randomBytes(3).toString("hex")}`, pass: randomBytes(12).toString("hex") + "Aa1!" };
async function gitea(method, p, body) {
  const res = await fetch(GITEA_HOST + "/api/v1" + p, { method, headers: { authorization: "Basic " + Buffer.from(`${gt.user}:${gt.pass}`).toString("base64"), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); return { status: res.status, json: text ? JSON.parse(text) : null };
}
async function giteaSetup() {
  execFileSync("docker", ["exec", "-u", "git", GITEA_CONTAINER, "gitea", "admin", "user", "create", "--admin", "--username", gt.user, "--password", gt.pass, "--email", `${gt.user}@example.test`, "--must-change-password=false"], { stdio: "pipe" });
}
async function giteaRepo(name, files) {
  const created = await gitea("POST", "/user/repos", { name, private: false, auto_init: true, default_branch: "main" });
  if (created.status !== 201) throw new FixtureError(`gitea repo ${created.status}`);
  for (const [p, buf] of Object.entries(files)) {
    const r = await gitea("POST", `/repos/${gt.user}/${name}/contents/${p}`, { content: buf.toString("base64"), message: `add ${p}`, branch: "main" });
    if (r.status !== 201) throw new FixtureError(`gitea file ${r.status}`);
  }
}
const repoBody = (name, modality, key, extra = {}) => ({
  modality, provider: "GITEA", credentialMode: "PUBLIC", serverUrl: GITEA_INTERNAL,
  repository: { owner: gt.user, name, ref: "main", expectedVisibility: "PUBLIC", ...(extra.rootPath === null ? {} : { rootPath: "data" }) },
  datasetName: `acc-${name}`.slice(0, 150), idempotencyKey: key, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "rootPath")),
});

// ---------- local-folder helper ----------
async function localFolder(s, { name, modality, items, key = `lf-${randomUUID()}`, startExtra = {} }) {
  const manifest = items.map((i) => ({ logicalPath: i.path, contentType: i.contentType, sizeBytes: i.bytes.length, fingerprint: sha256(i.bytes) }));
  const start = await s.req("POST", "/api/imports/local-folder", { name, modality, idempotencyKey: key, items: manifest, ...startExtra });
  return { start, key, manifest };
}
async function uploadAndComplete(s, started, items) {
  const prep = started.start.json?.data?.preparation;
  if (!prep) throw new FixtureError(`start failed ${started.start.status}`);
  const caps = await s.req("POST", `/api/imports/${prep.id}/upload-capabilities`, { itemIds: prep.items.map((i) => i.id) });
  if (caps.status !== 200) throw new FixtureError(`capabilities ${caps.status}`);
  const out = [];
  for (let i = 0; i < prep.items.length; i++) {
    const cap = caps.json.data.capabilities.find((c) => c.itemId === prep.items[i].id);
    const form = new FormData();
    for (const [k, v] of Object.entries(cap.formFields)) form.append(k, v);
    form.append("file", new Blob([items[i].bytes], { type: items[i].contentType }), "f");
    const up = await fetch(cap.uploadUrl, { method: "POST", body: form });
    if (![200, 201, 204].includes(up.status)) throw new FixtureError(`minio upload ${up.status}`);
    const done = await s.req("POST", `/api/imports/${prep.id}/items/${prep.items[i].id}/complete`, { fileId: cap.fileId });
    out.push(done);
  }
  return { prep, completes: out };
}

// ---------- main ----------
const modalityOf = (r) => r?.json?.data?.dataset?.modality;
async function main() {
  const owner = await new Session("owner").register("MANAGER");
  const other = await new Session("other").register("MANAGER");
  await giteaSetup();
  const good1 = png(1), good2 = png(2), truncated = png(3).subarray(0, 20);
  const textAsPng = Buffer.from("this is not an image, just text pretending to be .png\n".repeat(4));

  // ===== FLOW 3: /workspace/{datasetId} =====
  const ds = {};
  for (const m of ["IMAGE", "VIDEO", "TEXT", "AUDIO"]) {
    const r = await owner.req("POST", "/api/datasets", { name: `ws-${m.toLowerCase()}-${randomBytes(2).toString("hex")}`, modality: m });
    if (r.status !== 201) throw new FixtureError(`dataset ${m} ${r.status}`);
    ds[m] = r.json.data?.id ?? r.json.id;
  }
  for (const m of Object.keys(ds)) {
    const plain = await owner.req("GET", `/api/datasets/${ds[m]}/workspace-state`);
    check("workspace", `state-${m}-authoritative`, plain.status === 200 && plain.json?.data?.modality === m, { status: plain.status, modality: plain.json?.data?.modality }, m);
    const forged = ["VIDEO", "IMAGE"].filter((x) => x !== m)[0];
    const q = await owner.req("GET", `/api/datasets/${ds[m]}/workspace-state?modality=${forged}&engine=${forged}&assetModality=${forged}`);
    check("workspace", `state-${m}-query-hint-ignored`, q.status === 200 && q.json?.data?.modality === m, { status: q.status, modality: q.json?.data?.modality }, m);
    const page = await owner.req("GET", `/workspace/${ds[m]}?modality=${forged}&engine=${forged}`);
    check("workspace", `page-${m}-renders-with-hint-ignored`, page.status === 200, { status: page.status }, 200);
  }
  const foreign = await other.req("GET", `/api/datasets/${ds.IMAGE}/workspace-state`);
  check("workspace", "foreign-user-cannot-read-state", [403, 404].includes(foreign.status), { status: foreign.status }, "403|404");
  const anon = await fetch(`${WEB}/api/datasets/${ds.IMAGE}/workspace-state`);
  check("workspace", "anonymous-rejected", anon.status === 401, { status: anon.status }, 401);
  const bad = await owner.req("GET", `/api/datasets/not-a-valid-id/workspace-state`);
  check("workspace", "invalid-id-400", bad.status === 400, { status: bad.status }, 400);

  // ===== FLOW 1: /datasets/imports (repository import) =====
  await giteaRepo("ok-images", { "data/a.png": good1, "data/b.png": good2 });
  await giteaRepo("spoof-text", { "data/fake.png": textAsPng });
  await giteaRepo("truncated", { "data/cut.png": truncated });
  await giteaRepo("only-png", { "data/p.png": good1 });

  const keyA = `imp-${randomUUID()}`;
  const a1 = await owner.req("POST", "/api/datasets/from-repository", repoBody("ok-images", "IMAGE", keyA));
  check("repository", "fresh-creation-accepted", a1.status === 202, { status: a1.status, code: a1.json?.error?.code }, 202);
  check("repository", "fresh-response-exposes-dataset.modality", modalityOf(a1) === "IMAGE", { dataset: a1.json?.data?.dataset }, "data.dataset.modality=IMAGE");
  const aDataset = a1.json?.data?.dataset?.id, aJob = a1.json?.data?.job?.id;
  if (aDataset) check("repository", "fresh-modality-matches-persisted", datasetModalityDb(aDataset) === modalityOf(a1) && modalityOf(a1) === "IMAGE", { persisted: datasetModalityDb(aDataset), response: modalityOf(a1) }, "equal");
  const a2 = await owner.req("POST", "/api/datasets/from-repository", repoBody("ok-images", "IMAGE", keyA));
  check("repository", "replay-is-200-same-dataset", a2.status === 200 && a2.json?.data?.dataset?.id === aDataset, { status: a2.status, same: a2.json?.data?.dataset?.id === aDataset }, "200 same dataset");
  check("repository", "replay-response-exposes-dataset.modality", modalityOf(a2) === "IMAGE", { dataset: a2.json?.data?.dataset }, "data.dataset.modality=IMAGE");
  const aFinal = aJob ? await pollJob(owner, aJob) : null;
  check("repository", "valid-images-import-completes", aFinal?.status === "COMPLETED", { status: aFinal?.status }, "COMPLETED");
  if (aDataset) check("repository", "valid-images-published-exactly-2-assets-no-replay-duplicates", assetCount(aDataset) === 2, { assets: assetCount(aDataset) }, 2);
  const conflict = await owner.req("POST", "/api/datasets/from-repository", repoBody("only-png", "IMAGE", keyA));
  check("repository", "same-key-different-request-409", conflict.status === 409, { status: conflict.status, code: conflict.json?.error?.code }, 409);

  for (const [name, id] of [["spoof-text", "text-content-named-png-rejected-nothing-published"], ["truncated", "truncated-png-rejected-nothing-published"]]) {
    const r = await owner.req("POST", "/api/datasets/from-repository", repoBody(name, "IMAGE", `imp-${randomUUID()}`));
    const dsId = r.json?.data?.dataset?.id, jobId = r.json?.data?.job?.id;
    if (r.status === 202 && jobId) {
      const fin = await pollJob(owner, jobId);
      check("repository", id, assetCount(dsId) === 0 && fin?.status !== "COMPLETED", { job: fin?.status, assets: assetCount(dsId) }, "no asset; job not COMPLETED");
    } else check("repository", id, r.status >= 400 && r.status < 500, { status: r.status, code: r.json?.error?.code }, "rejected before publication");
  }
  const repo2 = await new Session("repo2").register("MANAGER");
  // content mismatch inside a repository: a text file (README) sits next to valid PNGs in an IMAGE dataset (no rootPath narrowing)
  const mixed = await repo2.req("POST", "/api/datasets/from-repository", { ...repoBody("ok-images", "IMAGE", `imp-${randomUUID()}`, { rootPath: null }), datasetName: "acc-mixed-readme" });
  if (mixed.status === 202 && mixed.json?.data?.job?.id) {
    const fin = await pollJob(repo2, mixed.json.data.job.id);
    const mid = mixed.json.data.dataset.id;
    check("repository", "text-file-in-IMAGE-dataset-never-published", Number(sql(`select count(*) from "Asset" where "datasetId"='${mid}' and "modality"<>'IMAGE'`)) === 0 && assetCount(mid) <= 2 && fin?.status !== "COMPLETED", { job: fin?.status, assets: assetCount(mid), nonImage: sql(`select count(*) from "Asset" where "datasetId"='${mid}' and "modality"<>'IMAGE'`) }, "no non-IMAGE asset; job not COMPLETED");
  } else check("repository", "text-file-in-IMAGE-dataset-never-published", false, { status: mixed.status }, 202);
  // forged modality: PNG-only repo requested as VIDEO must fail closed and publish nothing
  const forged = await repo2.req("POST", "/api/datasets/from-repository", repoBody("only-png", "VIDEO", `imp-${randomUUID()}`));
  if (forged.status === 202 && forged.json?.data?.job?.id) {
    const fin = await pollJob(repo2, forged.json.data.job.id);
    check("repository", "forged-modality-fail-closed", assetCount(forged.json.data.dataset.id) === 0 && fin?.status !== "COMPLETED", { job: fin?.status, assets: assetCount(forged.json.data.dataset.id), datasetModality: datasetModalityDb(forged.json.data.dataset.id) }, "no asset; job not COMPLETED");
  } else check("repository", "forged-modality-fail-closed", forged.status >= 400 && forged.status < 500, { status: forged.status }, "rejected");
  const extraField = await repo2.req("POST", "/api/datasets/from-repository", { ...repoBody("only-png", "IMAGE", `imp-${randomUUID()}`), assetModality: "VIDEO", datasetModality: "VIDEO" });
  check("repository", "client-modality-hint-fields-rejected-400", extraField.status === 400, { status: extraField.status }, 400);

  // ===== FLOW 2: /datasets/local-folder =====
  const lf = await new Session("lf").register("MANAGER");
  const okItems = [{ path: "d/a.png", contentType: "image/png", bytes: good1 }];
  const l1 = await localFolder(lf, { name: `lf-ok-${randomBytes(2).toString("hex")}`, modality: "IMAGE", items: okItems });
  check("local-folder", "start-201-or-200", [200, 201].includes(l1.start.status), { status: l1.start.status }, "2xx");
  check("local-folder", "start-response-exposes-data.dataset{id,modality}", l1.start.json?.data?.dataset?.modality === "IMAGE" && Boolean(l1.start.json?.data?.dataset?.id), { dataset: l1.start.json?.data?.dataset, preparationKeys: Object.keys(l1.start.json?.data?.preparation ?? {}) }, "data.dataset={id,modality:IMAGE}");
  const lfDataset = l1.start.json?.data?.preparation?.datasetId;
  const l1r = await lf.req("POST", "/api/imports/local-folder", { name: "lf-ok", modality: "IMAGE", idempotencyKey: l1.key, items: l1.manifest });
  check("local-folder", "replay-response-exposes-data.dataset", l1r.json?.data?.replayed === true && l1r.json?.data?.dataset?.modality === "IMAGE" && l1r.json?.data?.dataset?.id === lfDataset, { status: l1r.status, replayed: l1r.json?.data?.replayed, dataset: l1r.json?.data?.dataset }, "replayed with data.dataset");
  const up1 = await uploadAndComplete(lf, l1, okItems);
  check("local-folder", "valid-png-complete-accepted", up1.completes[0].status >= 200 && up1.completes[0].status < 300 && Boolean(up1.completes[0].json?.data?.assetId), { status: up1.completes[0].status, code: up1.completes[0].json?.error?.code }, "2xx");
  const commit = await lf.req("POST", `/api/jobs/${up1.prep.jobId}/commit-import`);
  check("local-folder", "commit-succeeds", commit.status === 200, { status: commit.status, code: commit.json?.error?.code }, 200);
  check("local-folder", "valid-png-published-exactly-1-asset", assetCount(lfDataset) === 1, { assets: assetCount(lfDataset) }, 1);
  const dup = await lf.req("POST", `/api/imports/${up1.prep.id}/items/${up1.prep.items[0].id}/complete`, { fileId: "x".repeat(40) });
  check("local-folder", "bogus-fileId-rejected", dup.status >= 400 && dup.status < 500, { status: dup.status }, "4xx");
  const keyConflict = await lf.req("POST", "/api/imports/local-folder", { name: "lf-ok", modality: "VIDEO", idempotencyKey: l1.key, items: l1.manifest });
  check("local-folder", "same-key-different-modality-409", keyConflict.status === 409, { status: keyConflict.status, code: keyConflict.json?.error?.code }, 409);
  const forgedStart = await lf.req("POST", "/api/imports/local-folder", { name: "lf-f", modality: "IMAGE", idempotencyKey: `lf-${randomUUID()}`, items: l1.manifest, datasetId: ds.VIDEO, assetModality: "VIDEO" });
  check("local-folder", "client-hint-fields-rejected-400", forgedStart.status === 400, { status: forgedStart.status }, 400);

  const negatives = [
    { id: "text-bytes-declared-png-rejected", modality: "IMAGE", item: { path: "d/fake.png", contentType: "image/png", bytes: textAsPng } },
    { id: "truncated-png-rejected-422-INVALID_MEDIA", modality: "IMAGE", item: { path: "d/cut.png", contentType: "image/png", bytes: truncated }, wantStatus: 422, wantCode: "INVALID_MEDIA" },
    { id: "png-bytes-declared-jpeg-mime-never-trusted", sameModalityMimeSpoof: true, modality: "IMAGE", item: { path: "d/spoof.jpg", contentType: "image/jpeg", bytes: good1 } },
    { id: "png-bytes-declared-text-in-TEXT-dataset-rejected", modality: "TEXT", item: { path: "d/x.txt", contentType: "text/plain", bytes: good1 } },
    { id: "png-in-VIDEO-dataset-rejected", modality: "VIDEO", item: { path: "d/v.mp4", contentType: "video/mp4", bytes: good1 } },
  ];
  for (const n of negatives) {
    const items = [n.item];
    // The import rate limit is per actor and per minute; a fresh actor per negative keeps scenarios independent.
    const actor = await new Session("neg").register("MANAGER");
    const st = await localFolder(actor, { name: `lfn-${randomBytes(2).toString("hex")}`, modality: n.modality, items });
    const dsId = st.start.json?.data?.preparation?.datasetId;
    if (!dsId) { check("local-folder", n.id, false, { startStatus: st.start.status, code: st.start.json?.error?.code }, "start ok"); continue; }
    const r = await uploadAndComplete(actor, st, items);
    const c = r.completes[0];
    if (n.sameModalityMimeSpoof) {
      const stored = sql(`select "mimeType"||'/'||"modality" from "Asset" where "datasetId"='${dsId}'`);
      check("local-folder", n.id, (c.status >= 400 && c.status < 500 && assetCount(dsId) === 0) || stored === "image/png/IMAGE", { status: c.status, storedMimeAndModality: stored }, "rejected, or stored with the server-classified type image/png and modality IMAGE (never the client-declared type)");
      continue;
    }
    const statusOk = n.wantStatus ? c.status === n.wantStatus : c.status >= 400 && c.status < 500;
    const codeOk = n.wantCode ? c.json?.error?.code === n.wantCode : true;
    check("local-folder", n.id, statusOk && codeOk && assetCount(dsId) === 0, { status: c.status, code: c.json?.error?.code, assets: assetCount(dsId) }, `${n.wantStatus ?? "4xx"}${n.wantCode ? " " + n.wantCode : ""} and no asset`);
    const cm = await actor.req("POST", `/api/jobs/${r.prep.jobId}/commit-import`);
    check("local-folder", `${n.id}::commit-publishes-nothing`, assetCount(dsId) === 0, { commitStatus: cm.status, assets: assetCount(dsId) }, "no asset");
  }

  // ===== AI target (IMAGE batch limit) is covered by unit/focused suites; recorded as not exercised here =====
  return { datasets: ds };
}

let fatal = null;
try { await main(); } catch (e) { fatal = e instanceof FixtureError ? `FIXTURE/RUNTIME: ${e.message}` : `UNEXPECTED: ${e.stack?.split("\n")[0]}`; console.error(fatal); }
mkdirSync(outDir, { recursive: true });
const summary = { runId, label: LABEL, web: WEB, fatal, total: results.length, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).map((r) => `${r.flow}/${r.id}`), results };
const file = path.join(outDir, "acceptance.json");
writeFileSync(file, JSON.stringify(summary, null, 2) + "\n", { mode: 0o400 }); try { chmodSync(file, 0o400); } catch { /* best effort */ }
console.log(JSON.stringify({ runId, fatal, total: summary.total, passed: summary.passed, failed: summary.failed }, null, 2));
process.exit(fatal ? 2 : summary.failed.length ? 1 : 0);
