import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  textSpanGeometrySchema,
  textDocumentGeometrySchema,
  textRelationGeometrySchema,
  textGeometrySchema,
  serializeSafeTextAnnotation,
  UTF16_CODE_UNIT,
  TEXT_GEOMETRY_SCHEMA_VERSION,
} from "../src/text-annotation-contract.js";
import { textBoundaryArtifactSchema, isTextBoundaryOffset } from "../src/text-boundary-contract.js";
import { readTextSourceLimits, TEXT_SOURCE_LIMIT_DEFAULTS } from "../src/text-source-limits.js";
import { decodeUtf8SourceBytes } from "../src/text-source-decode.js";

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

test("browser-safe export boundary: TEXT contract modules import no app/server code or raw process.env", () => {
  const textModules = readdirSync(srcDir).filter((file) => file.startsWith("text-") && file.endsWith(".ts"));
  assert.ok(textModules.length >= 5, "expected the shared TEXT contract modules to exist");
  for (const file of textModules) {
    const contents = readFileSync(path.join(srcDir, file), "utf8");
    assert.doesNotMatch(contents, /from ["']next/, `${file} must not import Next.js`);
    assert.doesNotMatch(contents, /from ["'].*apps\/(web|worker)/, `${file} must not import an app package`);
    assert.doesNotMatch(contents, /require\(/, `${file} must use ESM imports only`);
    assert.doesNotMatch(contents, /process\.env/, `${file} must not read process.env directly`);
  }
});

test("cross-app import check: index.ts publishes every shared TEXT contract symbol", () => {
  const indexContents = readFileSync(path.join(srcDir, "index.ts"), "utf8");
  for (const specifier of [
    "./text-properties-contract.js",
    "./text-annotation-contract.js",
    "./text-boundary-contract.js",
    "./text-source-decode.js",
    "./text-source-limits.js",
  ]) {
    assert.match(indexContents, new RegExp(`export \\* from ["']${specifier.replace(/[./]/g, "\\$&")}["']`));
  }
});

test("named geometry schemas accept only their own kind and reject unknown fields", () => {
  const span = { schemaVersion: 1, kind: "text-span", sourceIdentity: "sha256:a", offsetUnit: UTF16_CODE_UNIT, startOffset: 0, endOffset: 6 };
  assert.equal(textSpanGeometrySchema.safeParse(span).success, true);
  assert.equal(textSpanGeometrySchema.safeParse({ ...span, extra: 1 }).success, false);
  assert.equal(textSpanGeometrySchema.safeParse({ ...span, startOffset: 6, endOffset: 6 }).success, false, "collapsed range rejected");
  assert.equal(textSpanGeometrySchema.safeParse({ ...span, startOffset: 7, endOffset: 6 }).success, false, "reversed range rejected");
  assert.equal(textSpanGeometrySchema.safeParse({ ...span, startOffset: 1.5 }).success, false, "fractional offset rejected");
  assert.equal(textSpanGeometrySchema.safeParse({ ...span, startOffset: -1 }).success, false, "negative offset rejected");

  const document = { schemaVersion: 1, kind: "text-document", sourceIdentity: "sha256:a" };
  assert.equal(textDocumentGeometrySchema.safeParse(document).success, true);
  assert.equal(textGeometrySchema.safeParse(document).success, true);

  const relation = { schemaVersion: 1, kind: "text-relation", sourceIdentity: "sha256:a" };
  assert.equal(textRelationGeometrySchema.safeParse(relation).success, true);
  assert.equal(textGeometrySchema.safeParse(span).success, true);
  assert.equal(TEXT_GEOMETRY_SCHEMA_VERSION, 1);
});

test("serializeSafeTextAnnotation drops endpoint IDs for non-relation kinds and normalizes timestamps", () => {
  const base = {
    id: "ann_1",
    assetId: "asset_1",
    datasetId: "dataset_1",
    labelId: null,
    status: "DRAFT",
    revision: 1,
    properties: { custom: { note: "x" } },
    fromAnnotationId: "ann_2",
    toAnnotationId: "ann_3",
    createdById: "user_1",
    updatedById: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const span = serializeSafeTextAnnotation({
    ...base,
    geometry: { schemaVersion: 1, kind: "text-span", sourceIdentity: "sha256:a", offsetUnit: UTF16_CODE_UNIT, startOffset: 0, endOffset: 6 },
  });
  assert.equal(span.fromAnnotationId, null);
  assert.equal(span.toAnnotationId, null);
  assert.equal(span.createdAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(span.properties, { custom: { note: "x" } });

  const relation = serializeSafeTextAnnotation({
    ...base,
    geometry: { schemaVersion: 1, kind: "text-relation", sourceIdentity: "sha256:a" },
  });
  assert.equal(relation.fromAnnotationId, "ann_2");
  assert.equal(relation.toAnnotationId, "ann_3");

  assert.throws(() => serializeSafeTextAnnotation({ ...base, geometry: { kind: "bogus" } }));
});

test("boundary artifact schema enforces sorted unique offsets bounded to source length", () => {
  const profile = { schemaVersion: 1, algorithm: "EXTENDED_GRAPHEME_CLUSTER", nodeVersion: "22.23.1", icuVersion: "78.2", unicodeVersion: "17.0" };
  const valid = { schemaVersion: 1, profile, sourceIdentity: "sha256:a", offsetUnit: UTF16_CODE_UNIT, sourceCodeUnitLength: 4, boundaryOffsets: [0, 1, 3, 4] };
  assert.equal(textBoundaryArtifactSchema.safeParse(valid).success, true);
  assert.equal(textBoundaryArtifactSchema.safeParse({ ...valid, boundaryOffsets: [1, 3, 4] }).success, false, "must start at 0");
  assert.equal(textBoundaryArtifactSchema.safeParse({ ...valid, boundaryOffsets: [0, 1, 3] }).success, false, "must end at length");
  assert.equal(textBoundaryArtifactSchema.safeParse({ ...valid, boundaryOffsets: [0, 1, 1, 4] }).success, false, "must be strictly increasing");
  assert.equal(textBoundaryArtifactSchema.safeParse({ ...valid, boundaryOffsets: [0, 5] }).success, false, "must not exceed length");

  const parsed = textBoundaryArtifactSchema.parse(valid);
  assert.equal(isTextBoundaryOffset(parsed, 3), true);
  assert.equal(isTextBoundaryOffset(parsed, 2), false);
  assert.equal(isTextBoundaryOffset(parsed, 0), true);
  assert.equal(isTextBoundaryOffset(parsed, 4), true);
});

test("readTextSourceLimits defaults and rejects invalid overrides without duplicating literals", () => {
  const defaults = readTextSourceLimits({});
  assert.deepEqual(defaults, TEXT_SOURCE_LIMIT_DEFAULTS);
  const overridden = readTextSourceLimits({
    TEXT_WORKSPACE_MAX_SOURCE_BYTES: "2097152",
    TEXT_WORKSPACE_MAX_CODE_UNITS: "200000",
    TEXT_WORKSPACE_MAX_ANNOTATIONS: "10000",
  });
  assert.deepEqual(overridden, { maxSourceBytes: 2097152, maxCodeUnits: 200000, maxAnnotations: 10000 });
  for (const bad of ["0", "-5", "1.5", "abc", ""]) {
    if (bad === "") continue; // empty string falls back to default, tested separately
    assert.throws(() => readTextSourceLimits({ TEXT_WORKSPACE_MAX_SOURCE_BYTES: bad }));
  }
  assert.deepEqual(readTextSourceLimits({ TEXT_WORKSPACE_MAX_SOURCE_BYTES: "" }), defaults);
});

test("decodeUtf8SourceBytes round-trips a simple ASCII fixture", () => {
  const decoded = decodeUtf8SourceBytes(new TextEncoder().encode("OpenAI builds AI."));
  assert.equal(decoded.text, "OpenAI builds AI.");
  assert.equal(decoded.codeUnitLength, 17);
});
