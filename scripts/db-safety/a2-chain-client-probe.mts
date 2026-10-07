// Generated-client compatibility probe for the PROMOTED M26 (disposable database only; invoked by a2-chain.mjs, never by the application).
//  1. Regenerate a client from the tracked schema into a scratch directory and prove it equals the tracked client (only the two checkout-path lines may differ).
//  2. Exercise MediaVerification/Job through the TRACKED regenerated client against the migrated database, every write inside a transaction that is rolled back,
//     except one committed Job fixture (disposable DB) used to show what an OLD client does when it reads the new JobType value.
//  3. Run the OLD (M25-state) client, extracted from the immutable M25 commit, against the 26-migration database to document the fix-forward implication.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const url = process.env.A2_PROBE_DATABASE_URL!, schemaPath = process.env.A2_PROBE_SCHEMA!, root = process.env.A2_PROBE_ROOT!;
const lines: string[] = []; let failed = false;
const rec = (id: string, pass: boolean, detail?: unknown) => { lines.push(`${pass ? "PASS" : "FAIL"} ${id}${detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 220)}`); if (!pass) failed = true; };
class Rollback extends Error {}

const dir = mkdtempSync(join(tmpdir(), "a2-client-"));
try {
  // the tracked schema is copied byte-identical to <dir>/prisma/schema.prisma so its relative output (../lib/generated/prisma) resolves to <dir>/lib/generated/prisma,
  // the same layout as the checkout; the generator then differs from the tracked client only in the two embedded absolute paths
  const outDir = join(dir, "lib/generated/prisma");
  mkdirSync(join(dir, "prisma"), { recursive: true });
  writeFileSync(join(dir, "prisma/schema.prisma"), readFileSync(schemaPath));
  symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, "prisma.config.ts"), `import {defineConfig} from ${JSON.stringify(join(root, "node_modules/prisma/config.js"))}; export default defineConfig(${JSON.stringify({ schema: join(dir, "prisma/schema.prisma"), engine: "classic", datasource: { url } })});`);
  const gen = spawnSync(process.execPath, [join(root, "node_modules/prisma/build/index.js"), "generate", "--config", join(dir, "prisma.config.ts")], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: url } });
  rec("client-regenerated-into-scratch-from-the-tracked-schema", gen.status === 0, gen.status === 0 ? readdirSync(outDir).slice(0, 4) : (gen.stderr || gen.stdout).slice(0, 200));
  if (gen.status !== 0) throw new Error("GENERATE_FAILED");

  // 1. the regenerated scratch client equals the tracked client; only the embedded checkout paths (class.ts) may differ.
  const walk = (base: string, rel = ""): string[] => readdirSync(join(base, rel)).flatMap(name => { const next = rel ? `${rel}/${name}` : name; return statSync(join(base, next)).isDirectory() ? walk(base, next) : [next]; });
  const trackedDir = join(root, "lib/generated/prisma");
  const scratchFiles = walk(outDir).sort(), trackedFiles = walk(trackedDir).sort();
  const differing: string[] = [];
  for (const file of trackedFiles) {
    let a = readFileSync(join(trackedDir, file)), b = scratchFiles.includes(file) ? readFileSync(join(outDir, file)) : Buffer.alloc(0);
    if (file === "internal/class.ts") {
      // the generator embeds the output directory and the schema path of the checkout it ran in; everything else must be byte-identical
      const OUTPUT = /"value": "[^"\n]*\/lib\/generated\/prisma"/g, SCHEMA = /"sourceFilePath": "[^"\n]*\/prisma\/schema\.prisma"/g;
      const count = (buf: Buffer, re: RegExp) => (buf.toString("utf8").match(re) ?? []).length;
      if (count(a, OUTPUT) !== 1 || count(a, SCHEMA) !== 1 || count(b, OUTPUT) !== 1 || count(b, SCHEMA) !== 1) { differing.push(`${file}:path-field-count`); continue; }
      const norm = (buf: Buffer) => Buffer.from(buf.toString("utf8").replace(OUTPUT, '"value": "<OUTPUT>"').replace(SCHEMA, '"sourceFilePath": "<SCHEMA>"'));
      a = norm(a); b = norm(b);
    }
    if (!a.equals(b)) differing.push(file);
  }
  rec("tracked-client-equals-a-fresh-generation-from-the-tracked-schema-except-the-two-embedded-checkout-paths", JSON.stringify(scratchFiles) === JSON.stringify(trackedFiles) && differing.length === 0, { files: trackedFiles.length, differing });

  process.env.DATABASE_URL = url;
  const candidate = await import(join(root, "lib/generated/prisma/client.ts"));
  const db = new candidate.PrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const fixture = async (tx: any) => {
    const user = await tx.user.create({ data: { email: `a2probe-${suffix}-${randomUUID().slice(0, 4)}@test.invalid`, role: "MANAGER", passwordHash: "x" } });
    const dataset = await tx.dataset.create({ data: { ownerId: user.id, name: `a2probe-${suffix}`, modality: "VIDEO", modalityResolverSubject: user.id } });
    const job = await tx.job.create({ data: { datasetId: dataset.id, createdById: user.id, type: "VERIFY_UPLOADED_MEDIA", modality: "VIDEO", status: "QUEUED", totalItems: 1, idempotencyKey: `a2probe:${suffix}:${randomUUID().slice(0, 4)}`, input: { verificationId: randomUUID(), contractVersion: 1 } } });
    return { user, dataset, job };
  };
  const row = (f: any, extra: Record<string, unknown> = {}) => ({
    datasetId: f.dataset.id, requestedById: f.user.id, source: "DIRECT_UPLOAD", boundDatasetModality: "VIDEO", stagedBucket: "b", stagedKey: `direct-uploads/${randomUUID()}`, stagedEtag: "e",
    stagedSizeBytes: 123n, stagedLastModified: new Date(), filename: "v.mp4", declaredContentType: "video/mp4", declaredSizeBytes: 123n, verificationDeadlineAt: new Date(Date.now() + 30 * 60_000), ...extra,
  });
  const rolledBack = async (fn: (tx: any) => Promise<void>) => { try { await db.$transaction(async (tx: any) => { await fn(tx); throw new Rollback(); }); } catch (error) { if (!(error instanceof Rollback)) throw error; } };
  const expectCode = async (fn: (tx: any) => Promise<void>) => { try { await db.$transaction(async (tx: any) => { await fn(tx); }); return "NO_ERROR"; } catch (error: any) { if (error instanceof Rollback) return "ROLLED_BACK_OK"; return error?.code ?? error?.message ?? "ERR"; } };

  await rolledBack(async tx => {
    const f = await fixture(tx);
    rec("JobType-VERIFY_UPLOADED_MEDIA-writes-and-reads-through-the-candidate-client", f.job.type === "VERIFY_UPLOADED_MEDIA");
    const created = await tx.mediaVerification.create({ data: row(f, { currentJobId: f.job.id }) });
    rec("MediaVerification-defaults-status-PENDING-generation-1-and-relations-resolve", created.status === "PENDING" && created.generation === 1 && created.sealedKey === null && created.assetId === null && created.objectsClearedAt === null, { status: created.status, generation: created.generation });
    const read = await tx.mediaVerification.findUnique({ where: { id: created.id }, include: { dataset: true, requestedBy: true, currentJob: true } });
    rec("relations-dataset-requestedBy-currentJob-load", read.dataset.id === f.dataset.id && read.requestedBy.id === f.user.id && read.currentJob.id === f.job.id);
    rec("BigInt-DateTime-and-enum-round-trip", typeof read.stagedSizeBytes === "bigint" && read.stagedLastModified instanceof Date && read.boundDatasetModality === "VIDEO" && read.source === "DIRECT_UPLOAD");
    await tx.mediaVerification.update({ where: { id: created.id }, data: { status: "SEALED", sealedKey: `verified-uploads/${f.dataset.id}/${created.id}/source`, sealedEtag: "e2", sealedSizeBytes: 123n, sealedLastModified: new Date(), sealedAt: new Date() } });
    rec("status-and-sealed-columns-update", (await tx.mediaVerification.findUnique({ where: { id: created.id } })).status === "SEALED");
    await tx.dataset.delete({ where: { id: f.dataset.id } }).catch(() => null);
  });
  rec("duplicate-staged-triple-is-P2002", await expectCode(async tx => { const f = await fixture(tx); const r = row(f, { stagedKey: `direct-uploads/dup-${suffix}` }); await tx.mediaVerification.create({ data: r }); await tx.mediaVerification.create({ data: { ...r } }); }) === "P2002");
  rec("same-staged-key-with-generation-2-is-allowed", await expectCode(async tx => { const f = await fixture(tx); const r = row(f, { stagedKey: `direct-uploads/gen-${suffix}` }); await tx.mediaVerification.create({ data: r }); await tx.mediaVerification.create({ data: { ...r, generation: 2 } }); throw new Rollback(); }) === "ROLLED_BACK_OK");
  rec("duplicate-sealedKey-is-P2002", await expectCode(async tx => { const f = await fixture(tx); const key = `verified-uploads/x/${suffix}/source`; await tx.mediaVerification.create({ data: row(f, { sealedKey: key }) }); await tx.mediaVerification.create({ data: row(f, { sealedKey: key }) }); }) === "P2002");
  rec("unknown-dataset-is-a-foreign-key-violation-P2003", await expectCode(async tx => { const f = await fixture(tx); await tx.mediaVerification.create({ data: row({ ...f, dataset: { id: "does-not-exist" } }) }); }) === "P2003");
  let cascade = "";
  await rolledBack(async tx => { const f = await fixture(tx); const mv = await tx.mediaVerification.create({ data: row(f) }); try { await tx.dataset.delete({ where: { id: f.dataset.id } }); cascade = (await tx.mediaVerification.findUnique({ where: { id: mv.id } })) === null ? "CASCADED" : "KEPT"; } catch (error: any) { cascade = `BLOCKED:${error.code}`; } });
  rec("deleting-the-Dataset-cascades-its-verifications-or-is-blocked-by-an-existing-constraint", cascade === "CASCADED" || cascade.startsWith("BLOCKED"), cascade);

  // committed fixture (disposable DB): one Job with the new type, so the tracked client's behaviour can be observed
  const committed = await fixture(db);
  rec("committed-fixture-Job-with-the-new-type-exists", (await db.job.count({ where: { id: committed.job.id } })) === 1);
  await db.$disconnect();

  // the CURRENT tracked (M25) client against the 26-migration database
  const m25Dir = join(dir, "m25");
  const archive = spawnSync("git", ["archive", process.env.A2_PROBE_M25_COMMIT!, "--", "lib/generated/prisma"], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  spawnSync("mkdir", ["-p", m25Dir]); spawnSync("tar", ["-x", "-C", m25Dir], { input: archive.stdout });
  const old = await import(join(m25Dir, "lib/generated/prisma/client.ts"));
  const oldDb = new old.PrismaClient();
  rec("OLD-M25-client-still-reads-existing-tables", (await oldDb.user.count()) >= 1 && (await oldDb.dataset.count()) >= 1);
  rec("OLD-M25-client-filtered-job-reads-for-existing-types-work", (await oldDb.job.findMany({ where: { type: "IMPORT_DATASET" } })).length >= 0);
  let oldRead = "READ_OK";
  try { await oldDb.job.findUnique({ where: { id: committed.job.id } }); } catch (error: any) { oldRead = `REJECTED:${String(error?.name ?? "error")}`; }
  rec("FIX-FORWARD-NOTE OLD-M25-client-reading-a-VERIFY_UPLOADED_MEDIA-Job", true, { outcome: oldRead, implication: oldRead === "READ_OK" ? "tolerant" : "web/worker must be upgraded before any VERIFY_UPLOADED_MEDIA Job can exist" });
  await oldDb.$disconnect();
} catch (error: any) {
  rec("probe-completed", false, String(error?.message ?? error).slice(0, 200));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(lines.join("\n"));
process.exit(failed ? 1 : 0);
