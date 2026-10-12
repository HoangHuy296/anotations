import "../../../../scripts/db-safety/test-entry.cjs"; // G1 gate (offline test: pure rules and source-contract checks, no database is opened).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canCancelPath, canFinishPath, classifyPathClick, isPathClosing, isPathTool, isWithinPathCloseThreshold, minimumPathVertices, pathPreviewPoints, POLYGON_CLOSE_THRESHOLD_PX } from "@/lib/workspace/path-interaction";

const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
const canvas = source("components/workspace/canvas-stage.tsx");
const body = (name: string) => { const start = canvas.indexOf(`function ${name}(`); assert.ok(start >= 0, name); let depth = 0, seen = false; for (let i = canvas.indexOf("{", start); i < canvas.length; i += 1) { if (canvas[i] === "{") { depth += 1; seen = true; } else if (canvas[i] === "}") { depth -= 1; if (seen && depth === 0) return canvas.slice(start, i + 1); } } throw new Error(name); };

test("the polygon close threshold is 12 screen pixels and includes its boundary", () => {
  assert.equal(POLYGON_CLOSE_THRESHOLD_PX, 12);
  assert.equal(isWithinPathCloseThreshold({ x: 12, y: 0 }, { x: 0, y: 0 }), true);
  assert.equal(isWithinPathCloseThreshold({ x: 12.01, y: 0 }, { x: 0, y: 0 }), false);
});

test("a polygon needs three vertices, a polyline two; nothing else is a path tool", () => {
  assert.deepEqual([isPathTool("polygon"), isPathTool("polyline"), isPathTool("box"), isPathTool("select")], [true, true, false, false]);
  assert.equal(minimumPathVertices("polygon"), 3); assert.equal(minimumPathVertices("polyline"), 2);
  assert.deepEqual([0, 1, 2, 3].map((n) => canFinishPath("polygon", n)), [false, false, false, true]);
  assert.deepEqual([0, 1, 2, 3].map((n) => canFinishPath("polyline", n)), [false, false, true, true]);
  assert.equal(canFinishPath("box", 9), false);
  assert.deepEqual([0, 1, 5].map(canCancelPath), [false, true, true]);
});

test("click classification: a short shape never finishes; close-by-proximity and double-click finish; otherwise the click appends", () => {
  const click = (tool: "polygon" | "polyline", vertexCount: number, doubleClick = false, nearFirstVertex = false) => classifyPathClick({ tool, vertexCount, doubleClick, nearFirstVertex });
  for (const tool of ["polygon", "polyline"] as const) assert.equal(click(tool, 0, true, true), "append", `${tool}: an empty path cannot finish`);
  assert.equal(click("polygon", 2, true, true), "append", "two polygon vertices are not enough, even on the first vertex");
  assert.equal(click("polygon", 3, false, true), "finish", "a click in the close zone closes a polygon");
  assert.equal(click("polygon", 3, false, false), "append");
  assert.equal(click("polygon", 3, true, false), "finish", "double-click finishes at the vertices already committed");
  assert.equal(click("polyline", 2, false, true), "append", "the close zone is a polygon rule: a polyline keeps extending");
  assert.equal(click("polyline", 1, true, false), "append", "one polyline vertex is not a shape");
  assert.equal(click("polyline", 2, true, false), "finish");
  assert.equal(click("polyline", 7, false, false), "append", "a polyline can have many vertices");
  assert.deepEqual([isPathClosing("polygon", 3, true), isPathClosing("polygon", 2, true), isPathClosing("polyline", 5, true), isPathClosing("polygon", 5, false)], [true, false, false, false]);
});

test("the preview line is the committed vertices plus the cursor, in image pixels", () => {
  assert.deepEqual(pathPreviewPoints([[0.1, 0.2], [0.3, 0.4]], null, 100, 200), [10, 40, 30, 80]);
  assert.deepEqual(pathPreviewPoints([[0.1, 0.2]], [0.5, 0.5], 100, 200), [10, 40, 50, 100]);
  assert.deepEqual(pathPreviewPoints([], null, 100, 200), []);
});

test("canvas contract: pointer movement while drawing a path updates Konva nodes only - no React state, no persistence, no requestAnimationFrame state loop", () => {
  const preview = body("updatePathPreview");
  assert.ok(!/\bset[A-Z]\w*\(/.test(preview), "updatePathPreview must not call a React state setter");
  assert.ok(!/persist|scheduleAutosave|putAssetAnnotations|beginOptimisticCreate|upsertSafeAnnotation/.test(preview), "no persistence while moving");
  assert.ok(/previewLineRef\.current/.test(preview) && /batchDraw\(\)/.test(preview), "the preview is drawn imperatively");
  const move = body("updateCanvasDraft");
  assert.ok(move.includes("updatePathPreview()") && !/requestAnimationFrame/.test(canvas), "mouse-move routes to the imperative preview; no rAF-driven React state");
  assert.ok(!/setCurrentPathPoint|setPathCloseCandidate/.test(canvas), "the cursor and the close candidate are not React state");
});

test("canvas contract: only finishing a path persists; cancel, tool change and Escape never write", () => {
  assert.ok(/scheduleAutosave\(`create-\$\{id\}`, \(\) => persistCreate\(id, type, geometry\), 0\)/.test(body("finishPath")), "a finished path is created once, at its commit boundary");
  const finish = body("finishPath"), cancel = body("cancelPath");
  assert.ok(finish.includes("canFinishPath(tool, pathPoints.length)") && finish.includes("beginOptimisticCreate") && finish.includes("persistCreate"), "finish commits once");
  assert.ok(!/persist|scheduleAutosave|putAssetAnnotations|beginOptimisticCreate/.test(cancel), "cancel writes nothing");
  assert.match(canvas, /useEffect\(\(\) => \{ previewCursorRef\.current = null; setPathPoints\(\[\]\); draftRef\.current = null; setDrawingStart\(null\); \}, \[tool\]\)/, "a tool change drops the half-drawn path and any box/circle drag");
  assert.match(canvas, /event\.key !== "Escape"/); assert.match(canvas, /cancelPath\(\)/);
  const down = body("startCanvasInteraction");
  assert.ok(down.includes("classifyPathClick(") && down.includes('action === "finish"'), "mouse-down uses the pure rule");
  assert.ok(!/persist|scheduleAutosave/.test(down.slice(down.indexOf("isPathTool(tool)"), down.indexOf('if (action === "finish")'))), "appending a vertex persists nothing");
});

test("canvas contract: navigation remounts the canvas per Asset, so an unfinished path cannot leak into another Asset", () => {
  const engine = source("components/workspace/image-engine.tsx");
  assert.match(engine, /<CanvasStage key=\{`canvas-\$\{currentImage\.id\}`\}/);
  const toolbar = source("components/workspace/toolbar.tsx");
  assert.ok(toolbar.includes("onCancelPath") && toolbar.includes("canCancelPath") && toolbar.includes("Cancel path") && toolbar.includes("Finish shape"), "both polygon and polyline offer Finish and Cancel");
});

test("canvas contract: dragging a box or circle updates a ref and Konva nodes only - no React state, no persistence", () => {
  const move = body("updateCanvasDraft");
  assert.ok(!/(?<![.\w])set[A-Z]\w*\(/.test(move.slice(move.indexOf('tool !== "box"'))), "the box/circle move path calls no React state setter (Konva node methods such as .setAttrs are not React state)");
  assert.ok(!/persist|scheduleAutosave|putAssetAnnotations|beginOptimisticCreate|upsertSafeAnnotation/.test(move), "no persistence while dragging");
  assert.ok(/draftRef\.current = rect/.test(move) && /draftRectRef\.current\?\.setAttrs\(rect\)/.test(move) && /draftCircleRef\.current\?\.radius\(/.test(move) && /batchDraw\(\)/.test(move), "the draft is drawn imperatively");
  assert.ok(!/useState<\{ x: number; y: number; width: number; height: number \} \| null>/.test(canvas) && !/setDraft\b/.test(canvas), "the per-move draft state no longer exists");
});

test("canvas contract: a box or circle is created once at mouse up from the ref; cancel, Escape and tool change write nothing", () => {
  const finish = body("finishCanvasInteraction");
  assert.ok(finish.includes("const draft = draftRef.current") && finish.includes("normalizeBoundingBox(draft, originalWidth, originalHeight)"), "final geometry comes from the ref, in image coordinates");
  assert.ok(/draftRef\.current = null;\s*setDrawingStart\(null\);\s*\}\s*$/.test(finish.trimEnd() + "") || finish.includes("draftRef.current = null"), "the draft is cleared when the drag ends");
  const cancel = body("cancelDraft");
  assert.ok(!/persist|scheduleAutosave|putAssetAnnotations|beginOptimisticCreate/.test(cancel) && cancel.includes("draftRef.current = null") && cancel.includes("setDrawingStart(null)"), "cancel writes nothing");
  assert.match(canvas, /cancelOnEscape[\s\S]*event\.key === "Escape"[\s\S]*cancelDraft\(\)/, "Escape cancels an in-progress drag");
});
