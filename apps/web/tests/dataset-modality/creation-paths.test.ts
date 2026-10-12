import "../../../../scripts/db-safety/test-entry.cjs"; // G1 gate (offline test: reads source files only, no database is opened).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

// Contract proven: no code path creates a Dataset without a declared modality. Every `dataset.create/createMany/upsert` call site in product source and the dev seeds is
// inventoried; each must pass `modality` (and `primaryModality`) in the same call, and a NEW site fails this test until it is classified here.
// (The database also refuses a NULL-modality INSERT — phase029_guard_dataset_insert, proven in asset-guard-transitions.test.ts; this is the source-level half.)

const ROOT = resolve(import.meta.dirname, "../../../..");
const SCAN = ["apps/web/src", "apps/worker/src", "apps/realtime/src", "packages", "prisma/seed.ts", "prisma/review.seed.ts"];
const SKIP = new Set(["node_modules", "dist", ".next", "generated"]);
const walk = (path: string, out: string[] = []): string[] => {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return out;
  if (stat.isFile()) { if (/\.(ts|tsx|mts)$/.test(path) && !/\.(test|spec)\./.test(path)) out.push(path); return out; }
  for (const entry of readdirSync(path)) if (!SKIP.has(entry)) walk(join(path, entry), out);
  return out;
};
const CALL = /\b(?:db|tx|client|prisma)\.dataset\.(create|createMany|upsert)\(/g;

function callBody(text: string, start: number) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") { depth -= 1; if (depth === 0) return text.slice(start, i + 1); }
  }
  return text.slice(start);
}

const sites = SCAN.flatMap((entry) => walk(join(ROOT, entry))).flatMap((file) => {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(CALL)].map((match) => ({ file: relative(ROOT, file), method: match[1]!, body: callBody(text, match.index! + match[0].length - 1) }));
});

test("the Dataset creation-site inventory is exactly the four product paths and the review seed", () => {
  assert.deepEqual(sites.map((site) => `${site.file}#${site.method}`).sort(), [
    "apps/web/src/app/api/datasets/route.ts#create",                    // POST /api/datasets (explicit modality, required by createDatasetSchema)
    "apps/web/src/lib/dataset-import.ts#create",                        // repository import that creates the Dataset
    "apps/web/src/lib/imports/prepare-local-folder-import.ts#create",   // local-folder / prepared import
    "apps/web/src/lib/queue/enqueue-job.ts#create",                     // POST /api/datasets/from-repository
    "prisma/review.seed.ts#create",                                     // review-stack demo seed (IMAGE)
  ].sort(), "a new Dataset creation site must be classified here and must declare its modality");
});

test("every Dataset creation call declares modality and primaryModality in the same write", () => {
  for (const site of sites) {
    assert.match(site.body, /\bmodality\b/, `${site.file} (${site.method}) must pass modality`);
    assert.match(site.body, /\bprimaryModality\b/, `${site.file} (${site.method}) must pass primaryModality`);
    assert.doesNotMatch(site.body, /modality:\s*(null|undefined)\b/, `${site.file} must never pass a null modality`);
  }
});

test("the API creation schema requires a modality from the four supported values", () => {
  const schema = readFileSync(join(ROOT, "apps/web/src/lib/validation/dataset.ts"), "utf8");
  assert.match(schema, /modality:\s*z\.enum\(modalities\)/, "required (no .optional()/.nullable()/default)");
  assert.doesNotMatch(schema, /modality:\s*z\.enum\(modalities\)\s*\.(optional|nullable|default)/);
  const domain = readFileSync(join(ROOT, "packages/domain/src/dataset-modality.ts"), "utf8");
  assert.match(domain, /datasetModalities\s*=\s*\[\s*"IMAGE",\s*"VIDEO",\s*"AUDIO",\s*"TEXT"\s*\]/);
});

test("the Dataset PATCH route refuses a modality key before validation (immutability at the API)", () => {
  const route = readFileSync(join(ROOT, "apps/web/src/app/api/datasets/[datasetId]/route.ts"), "utf8");
  assert.match(route, /DATASET_MODALITY_IMMUTABLE/);
});
