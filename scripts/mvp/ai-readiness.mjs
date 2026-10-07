#!/usr/bin/env node
// Read-only AI provider readiness diagnostic (Phase029 MVP). It never writes to the database, the provider or any container, and prints no secret.
// HTTP 200 is not readiness: the model-list contract, the discovered IMAGE/detection models, their intersection with locally ACTIVE
// aioz-company AiModel rows and web/worker endpoint agreement must all hold.
//   node scripts/mvp/ai-readiness.mjs [--expect <canonical url>] [--stack annotationplatformmvp] [--pg phase029-g1-mvp-postgres]
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALIASES = ["AIOZ_ANNOTATION_SERVICES_BASE_URL", "AIOZ_COMPANY_API_BASE_URL"];

/** Same acceptance rule as readAiProviderBaseUrl: http(s), no credentials, query or fragment. */
export function normalizeEndpoint(value) {
  try {
    const url = new URL((value ?? "").trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url.toString();
  } catch { return null; }
}

/** Validates the provider model-list contract for one filtered query; returns the verified models and any contract violations. */
export function validateCatalog(body, { type, taskName }) {
  const violations = [];
  if (!body || body.success !== true || !Array.isArray(body.data)) return { models: [], violations: ["ENVELOPE_INVALID"] };
  const models = [];
  for (const entry of body.data) {
    if (!entry || !UUID.test(entry.model_id ?? "") || typeof entry.model_name !== "string" || !entry.model_name.trim() || typeof entry.type !== "string" || typeof entry.task_name !== "string" || !entry.task_name.trim()) { violations.push("ENTRY_INVALID"); continue; }
    if (entry.type.toLowerCase() !== type || entry.task_name !== taskName) { violations.push("FILTER_NOT_APPLIED"); continue; }
    models.push({ providerModelId: entry.model_id, name: entry.model_name });
  }
  return { models, violations: [...new Set(violations)] };
}

export function evaluate({ expect, web, worker, catalog, localRows, workerKeyConfigured }) {
  const checks = [];
  const add = (id, pass, detail) => checks.push({ id, pass: Boolean(pass), ...(detail === undefined ? {} : { detail }) });
  const webUrl = normalizeEndpoint(web.url), workerUrl = normalizeEndpoint(worker.url);
  add("web-endpoint-configured-and-valid", webUrl, webUrl ?? "missing or invalid");
  add("worker-endpoint-configured-and-valid", workerUrl, workerUrl ?? "missing or invalid");
  add("web-and-worker-resolve-the-same-endpoint", webUrl && webUrl === workerUrl, webUrl === workerUrl ? "equal" : "different");
  if (expect) add("endpoint-equals-frozen-canonical", webUrl === normalizeEndpoint(expect) && workerUrl === normalizeEndpoint(expect));
  add("no-endpoint-alias-variables-set", ![...web.aliases, ...worker.aliases].length, [...web.aliases, ...worker.aliases]);
  add("provider-reachable", catalog.reachable, catalog.error ?? `http ${catalog.status}`);
  const verified = catalog.reachable ? validateCatalog(catalog.body, { type: "image", taskName: "detection" }) : { models: [], violations: ["UNREACHABLE"] };
  add("model-list-contract-valid", catalog.reachable && !verified.violations.length, verified.violations);
  add("image-detection-models-discovered", verified.models.length > 0, verified.models.map((m) => m.providerModelId));
  const active = new Map(localRows.filter((r) => r.isActive && r.provider === "aioz-company" && r.modality === "IMAGE" && r.taskType === "DETECTION").map((r) => [r.key, r]));
  const usable = verified.models.filter((m) => active.has(m.providerModelId));
  add("aidetect-has-at-least-one-usable-model", usable.length > 0, { usable: usable.map((m) => m.providerModelId), discoveredNotRegistered: verified.models.filter((m) => !active.has(m.providerModelId)).map((m) => m.providerModelId), registeredNotInProvider: [...active.keys()].filter((k) => !verified.models.some((m) => m.providerModelId === k)) });
  add("worker-api-key-configured", workerKeyConfigured, "presence only");
  return { result: checks.every((c) => c.pass) ? "READY" : "NOT_READY", failing: checks.filter((c) => !c.pass).map((c) => c.id), endpoint: webUrl, discovered: verified.models, checks };
}

function sh(cmd, args) { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function containerEnv(container) {
  const env = Object.fromEntries(sh("docker", ["inspect", container, "--format", "{{range .Config.Env}}{{println .}}{{end}}"]).split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  return { env, view: { url: env.AIOZ_ANNOTATION_SERVICES_URL, aliases: ALIASES.filter((a) => env[a]) } };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []));
  const stack = args.stack ?? "annotationplatformmvp", pg = args.pg ?? "phase029-g1-mvp-postgres";
  const web = containerEnv(`${stack}-web-1`), worker = containerEnv(`${stack}-worker-1`);
  const endpoint = normalizeEndpoint(web.view.url);
  let catalog;
  if (!endpoint) catalog = { reachable: false, error: "no valid endpoint" };
  else {
    try {
      const url = new URL("/api/v1/models/list", endpoint); url.searchParams.set("type", "image"); url.searchParams.set("task_name", "detection");
      const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
      catalog = { reachable: res.ok, status: res.status, body: res.ok ? await res.json().catch(() => null) : null };
    } catch (e) { catalog = { reachable: false, error: e.cause?.code ?? e.name }; }
  }
  const rows = sh("docker", ["exec", pg, "psql", "-U", "postgres", "-d", "fieldframe", "-tAF|", "-c", `select key,provider,modality,"taskType","isActive" from "AiModel"`]).split("\n").filter(Boolean).map((l) => { const [key, provider, modality, taskType, isActive] = l.split("|"); return { key, provider, modality, taskType, isActive: isActive === "t" }; });
  const report = evaluate({ expect: args.expect, web: web.view, worker: worker.view, catalog, localRows: rows, workerKeyConfigured: Boolean(worker.env.AIOZ_COMPANY_API_KEY) });
  console.log(JSON.stringify({ ...report, localAiModelRows: rows.length }, null, 2));
  process.exit(report.result === "READY" ? 0 : 1);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
