import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Structural/source-text assertions -- this repo has no jsdom/testing-library
// (AGENTS.md requires explicit permission before adding one), so component
// composition boundaries (spec FR-032, FR-041) are verified against source
// text rather than a rendered tree, matching the existing
// `video-engine-read.test.ts` precedent of reading source under test.

const workspaceDir = path.resolve(import.meta.dirname, "../../src/components/workspace");
const registryPath = path.resolve(import.meta.dirname, "../../src/lib/workspace/workspace-engine-registry.tsx");

async function readSource(file: string) {
  return readFile(path.join(workspaceDir, file), "utf8");
}

test("workspace-engine.tsx is the only component switching on selection.engine, via one registry lookup", async () => {
  const source = await readSource("workspace-engine.tsx");
  assert.match(source, /workspaceEngineRegistry\[selection\.engine\]/, "must look up the registry by selection.engine");
  assert.doesNotMatch(source, /switch\s*\(\s*selection\.engine\s*\)/, "must not contain an inline switch over selection.engine");
});

test("dataset-sidebar.tsx sources its toolbox from the registry and contains no independent engine switch", async () => {
  const source = await readSource("dataset-sidebar.tsx");
  assert.match(source, /workspaceEngineRegistry\[activeEngine\]/, "must look up the registry by the active engine");
  assert.doesNotMatch(source, /switch\s*\(/, "must not contain a switch statement");
  assert.doesNotMatch(source, /engine\s*===\s*"(IMAGE|VIDEO|AUDIO|TEXT)"/, "must not branch on a literal engine string outside the registry");
});

test("properties-panel.tsx sources its tabs from the registry and contains no independent engine switch", async () => {
  const source = await readSource("properties-panel.tsx");
  assert.match(source, /workspaceEngineRegistry\[selection\.engine\]/, "must look up the registry by selection.engine");
  assert.doesNotMatch(source, /switch\s*\(/, "must not contain a switch statement");
  assert.doesNotMatch(source, /engine\s*===\s*"(IMAGE|VIDEO|AUDIO|TEXT)"/, "must not branch on a literal engine string outside the registry");
});

test("workspace-header.tsx sources its status fields from the registry and contains no independent engine switch", async () => {
  const source = await readSource("workspace-header.tsx");
  assert.match(source, /workspaceEngineRegistry\[engine\s*\?\?\s*"IMAGE"\]/, "must look up the registry by the active engine");
  assert.doesNotMatch(source, /switch\s*\(/, "must not contain a switch statement");
});

// video-engine.tsx still imports VideoToolbar/VideoDetailsPanel/
// VideoTemporalLabels as of this checkpoint (spec User Story 7) -- that
// relocation is explicitly User Story 8's job (tasks T076-T080), not this
// phase's. A test asserting their absence belongs with T075, once US8 has
// actually removed them; asserting it here would fail against true current
// state and contradict this project's evidence discipline.

test("workspace-engine-registry.tsx defines exactly the four closed-union engine keys", async () => {
  const source = await readFile(registryPath, "utf8");
  for (const engine of ["IMAGE", "VIDEO", "AUDIO", "TEXT"]) {
    assert.match(source, new RegExp(`\\b${engine}:\\s*\\{`), `registry must define a ${engine} entry`);
  }
});
