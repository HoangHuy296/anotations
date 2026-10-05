import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ data: undefined as unknown, read: vi.fn() }));
vi.mock("@/components/visualization/visualization-session", () => ({
  VisualizationSession: ({ children }: { children: unknown }) => children,
  useVisualizationRead: () => ({ data: mocks.data, retry: vi.fn() }),
  useVisualizationSession: () => ({ read: mocks.read }),
}));
import { VisualizationShell } from "@/components/visualization/visualization-shell";
import { AssetImage, BoundingBoxOverlay } from "@/components/visualization/image-viewer";
import { visualizationTabs } from "@/types/visualization";

test("shell retains real identity, native navigation, single landmark, and real snapshot-only Versions", () => {
  const dataset = { id: "00000000-0000-4000-8000-000000000001", name: "Actual <dataset>" };
  for (const tab of visualizationTabs) {
    mocks.data = undefined;
    const html = renderToStaticMarkup(createElement(VisualizationShell, { dataset, tab }));
    expect(html).toContain("Actual &lt;dataset&gt;"); expect(html).toContain("Read-only"); expect(html).not.toContain("<main");
    expect(html.match(/aria-current="page"/g)).toHaveLength(1); expect(html).toContain('aria-labelledby="visualization-panel-title"');
    if (tab === "versions") expect(html).toContain("Only successfully published snapshots appear here");
    expect(html).not.toMatch(/Upload|Delete|Export|Grant/);
  }
});
test("unsupported modalities and missing media have explicit rendered states", () => {
  const asset = { row_id: "asset", filename: "asset", modality: "VIDEO", width: null, height: null, mediaAvailable: false };
  for (const modality of ["VIDEO", "AUDIO", "TEXT"]) expect(renderToStaticMarkup(createElement(AssetImage, { asset: { ...asset, modality } }))).toContain(`${modality} viewing is not supported yet`);
  expect(renderToStaticMarkup(createElement(AssetImage, { asset: { ...asset, modality: "IMAGE" } }))).toContain("Image media unavailable");
  expect(mocks.read).not.toHaveBeenCalled();
});

test("actual SVG overlay derives pixel rectangles from normalized geometry at multiple sizes", () => {
  for (const [width, height, x, y, boxWidth, boxHeight] of [[1000, 500, 100, 100, 300, 200], [200, 100, 20, 20, 60, 40]]) {
    const detail = { row_id: "asset", filename: "image", modality: "IMAGE", mediaAvailable: true, width, height, annotationCount: 1, annotationsTruncated: false, annotations: [{ id: "annotation", type: "BOUNDING_BOX", revision: 1, geometry: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, overlayUnavailable: null, label: { id: "label", name: "Car", color: "#12abef" } }] };
    const html = renderToStaticMarkup(createElement(BoundingBoxOverlay, { detail }));
    expect(html).toContain(`viewBox="0 0 ${width} ${height}"`);
    expect(html).toContain(`<rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}"`);
    expect(html).toContain('stroke="#12abef"');
    expect(renderToStaticMarkup(createElement(BoundingBoxOverlay, { detail: { ...detail, width: null } }))).toBe("");
  }
});

test("Versions shows zero or exactly one persisted snapshot without invented history", async () => {
  const { VersionsTab } = await import("@/components/visualization/versions-tab");
  mocks.data = { items: [], total: 0, page: 1, pageSize: 20, state: { status: "pending", current: false, snapshotId: null, generation: "0" } };
  expect(renderToStaticMarkup(createElement(VersionsTab))).toContain("No immutable snapshots");
  mocks.data = { ...mocks.data as object, items: [{ id: "vs_real", ordinal: 1, generation: "3", assetCount: 7, annotationCount: 12, publishedAt: "2026-09-29T00:00:00Z" }], total: 1 };
  const html = renderToStaticMarkup(createElement(VersionsTab)); expect(html).toContain("Version 1"); expect(html).not.toContain("Version 2"); expect(html).toContain("7 assets");
});

test("overview displays persisted counts and Data exposes accessible layout controls", async () => {
  const { DatasetSummary } = await import("@/components/visualization/dataset-summary");
  mocks.data = { assetCount: 17, imageCount: 15, unsupportedCount: 2, annotationCount: 43, state: { status: "pending" } };
  const html = renderToStaticMarkup(createElement(DatasetSummary, { dataset: { id: "real-dataset", name: "Actual dataset" } }));
  expect(html).toContain("real-dataset");
  for (const count of [17, 15, 2, 43]) expect(html).toContain(`>${count}</dd>`);
  expect(html).toContain("across all review states");
  mocks.data = undefined;
  const { DataTab } = await import("@/components/visualization/data-tab");
  const data = renderToStaticMarkup(createElement(DataTab));
  expect(data).toContain('aria-label="Grid view"');
  expect(data).toContain('aria-label="List view"');
  expect(data).toContain('aria-pressed="true"');
  expect(data).not.toMatch(/Upload|Delete|Export|Grant/);
});
