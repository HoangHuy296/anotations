import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  responses: {} as Record<string, unknown>,
  errors: {} as Record<string, string | undefined>,
  paths: [] as string[],
  read: vi.fn(),
  retry: vi.fn(),
}));
vi.mock("@/components/visualization/visualization-session", () => ({
  VisualizationSession: ({ children }: { children: unknown }) => children,
  useVisualizationRead: (path: string) => {
    mocks.paths.push(path);
    const endpoint = path.split("?")[0];
    return { data: mocks.responses[endpoint], error: mocks.errors[endpoint], retry: mocks.retry };
  },
  useVisualizationSession: () => ({ read: mocks.read }),
}));
import { VisualizationShell } from "@/components/visualization/visualization-shell";
import { AssetImage, BoundingBoxOverlay } from "@/components/visualization/image-viewer";
import { DataTab } from "@/components/visualization/data-tab";
import { DatasetSummary } from "@/components/visualization/dataset-summary";
import { PageControls } from "@/components/visualization/read-state";
import { visualizationTabs } from "@/types/visualization";
import type { ViewerAsset, ViewerInsights, ViewerPage } from "@/types/visualization";

const insights: ViewerInsights = {
  assetCount: 17, imageCount: 15, unsupportedCount: 2, annotationCount: 43,
  labelDistribution: [
    { label: { id: "label-car", name: "Car", color: "#ef4444" }, count: 28 },
    { label: { id: "label-person", name: "Person", color: "#3b82f6" }, count: 15 },
  ],
  distributionTruncated: false,
  dimensions: { count: 15, minWidth: 640, maxWidth: 1920, minHeight: 480, maxHeight: 1080 },
};
const pendingDerived = {
  profileSnapshotId: null, profileCurrent: false, profile: null,
  state: { status: "pending", current: false, snapshotId: null, generation: "0" },
};
const assets: ViewerPage<ViewerAsset> = {
  items: [
    { row_id: "asset-native", filename: "street <native>.png", modality: "IMAGE", width: 1920, height: 1080, mediaAvailable: false },
    { row_id: "asset-no-dimensions", filename: "notes.txt", modality: "TEXT", width: null, height: null, mediaAvailable: false },
  ],
  page: 1, pageSize: 20, total: 21,
};
const summaryDataset = { id: "00000000-0000-4000-8000-000000000001", name: "Actual dataset" };

beforeEach(() => {
  mocks.responses = {};
  mocks.errors = {};
  mocks.paths = [];
  vi.clearAllMocks();
});

test("shell retains real identity, native navigation, single landmark, and real snapshot-only Versions", () => {
  const dataset = { id: "00000000-0000-4000-8000-000000000001", name: "Actual <dataset>" };
  for (const tab of visualizationTabs) {
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
  mocks.responses["/versions"] = { items: [], total: 0, page: 1, pageSize: 20, state: pendingDerived.state };
  expect(renderToStaticMarkup(createElement(VersionsTab))).toContain("No immutable snapshots");
  mocks.responses["/versions"] = { ...mocks.responses["/versions"] as object, items: [{ id: "vs_real", ordinal: 1, generation: "3", assetCount: 7, annotationCount: 12, publishedAt: "2026-09-29T00:00:00Z" }], total: 1 };
  const html = renderToStaticMarkup(createElement(VersionsTab)); expect(html).toContain("Version 1"); expect(html).not.toContain("Version 2"); expect(html).toContain("7 assets");
});

test("sidebar displays live persisted counts and actual annotation label distribution", () => {
  mocks.responses["/insights"] = insights;
  mocks.responses["/derived"] = pendingDerived;
  const html = renderToStaticMarkup(createElement(DatasetSummary, { dataset: summaryDataset }));
  expect(html).toContain(summaryDataset.id);
  for (const count of [17, 15, 2, 43]) expect(html).toContain(`>${count}</dd>`);
  expect(html).toContain("Label distribution");
  expect(html).toContain("Car");
  expect(html).toContain("Person");
  expect(html).toContain(">28<");
  expect(html).toContain("across all review states");
  expect(html).not.toMatch(/Downloads|Likes|Community|SQL console/);
});

test("Data defaults to a semantic table with real record metadata and accessible inspection", () => {
  mocks.responses["/assets"] = assets;
  const data = renderToStaticMarkup(createElement(DataTab));
  expect(data).toContain('aria-label="Grid view"');
  const buttons = data.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)!;
  expect(buttons.find(button => button.includes('aria-label="Table view"'))).toContain('aria-pressed="true"');
  expect(data).toContain("<table");
  expect(data).toContain("<thead");
  expect(data).toContain("<tbody");
  const headers = data.match(/<th\b[^>]*>[\s\S]*?<\/th>/g)!;
  expect(headers).toHaveLength(6);
  for (const field of ["image", "filename", "modality", "width", "height", "row_id"]) {
    expect(headers.some(header => header.includes(field))).toBe(true);
  }
  expect(headers.every(header => header.includes('scope="col"'))).toBe(true);
  expect(headers.find(header => header.includes("filename"))).toContain('aria-sort="ascending"');
  expect(data).toContain('aria-label="Inspect street &lt;native&gt;.png"');
  expect(data).toContain("street &lt;native&gt;.png");
  expect(data).toContain("asset-native");
  expect(data).toContain("notes.txt");
  expect(data).toMatch(/1[,.]?920/);
  expect(data).toMatch(/1[,.]?080/);
  expect(data).toContain('aria-label="Width unavailable"');
  expect(data).toContain('aria-label="Height unavailable"');
  expect(data).not.toContain("street <native>.png");
  expect(data).not.toMatch(/Upload|Delete|Export|Grant/);

  const request = new URL(mocks.paths.find(path => path.startsWith("/assets?"))!, "http://localhost");
  expect(request.searchParams.get("page")).toBe("1");
  expect(request.searchParams.get("sort")).toBe("filename");
  expect(request.searchParams.get("q")).toBe("");
  expect(request.searchParams.get("order")).toBe("asc");
  expect(request.searchParams.get("modality")).toBe("ALL");
});

test("Data loading and read failures expose status and retry without fabricated rows", () => {
  const loading = renderToStaticMarkup(createElement(DataTab));
  expect(loading).toContain('role="status"');
  expect(loading).toContain("Loading dataset");
  expect(loading).not.toContain("asset-native");
  mocks.errors["/assets"] = "Dataset records could not be loaded.";
  const failed = renderToStaticMarkup(createElement(DataTab));
  expect(failed).toContain('role="alert"');
  expect(failed).toContain("Dataset records could not be loaded.");
  expect(failed).toContain("Retry read");
  expect(failed).not.toContain("asset-native");
});

test("empty Data reports zero records and disables both pagination directions", () => {
  mocks.responses["/assets"] = { items: [], total: 0, page: 1, pageSize: 20 };
  const html = renderToStaticMarkup(createElement(DataTab));
  expect(html).toContain("No assets yet");
  expect(html).toContain("0–0 of 0 records");
  expect(html).not.toContain("asset-native");
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)!;
  for (const label of ["Previous page", "Next page"]) {
    expect(buttons.find(button => button.includes(label))).toContain('disabled=""');
  }
});

test("sidebar reports statistics and preview failures independently", () => {
  mocks.errors["/insights"] = "Unavailable";
  mocks.responses["/derived"] = pendingDerived;
  const failedStatistics = renderToStaticMarkup(createElement(DatasetSummary, { dataset: summaryDataset }));
  expect(failedStatistics).toContain("Dataset statistics could not be loaded.");
  expect(failedStatistics).toContain("Retry statistics");
  expect(failedStatistics).not.toContain("Preview status could not be loaded.");
  mocks.responses["/insights"] = insights;
  mocks.responses["/derived"] = undefined;
  mocks.errors["/derived"] = "Unavailable";
  const failedPreview = renderToStaticMarkup(createElement(DatasetSummary, { dataset: summaryDataset }));
  expect(failedPreview).toContain("Preview status could not be loaded.");
  expect(failedPreview).toContain("Retry preview status");
  expect(failedPreview).toContain(">17</dd>");
});

test.each([
  { page: 1, pageSize: 20, total: 0, previousDisabled: true, nextDisabled: true },
  { page: 1, pageSize: 20, total: 20, previousDisabled: true, nextDisabled: true },
  { page: 1, pageSize: 20, total: 21, previousDisabled: true, nextDisabled: false },
  { page: 2, pageSize: 20, total: 21, previousDisabled: false, nextDisabled: true },
  { page: 10000, pageSize: 20, total: 200001, previousDisabled: false, nextDisabled: true },
])("pagination honors dataset and API boundaries: page=$page, total=$total", ({ page, pageSize, total, previousDisabled, nextDisabled }) => {
  const html = renderToStaticMarkup(createElement(PageControls, { page, pageSize, total, onPage: vi.fn() }));
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)!;
  for (const [label, disabled] of [["Previous page", previousDisabled], ["Next page", nextDisabled]] as const) {
    const button = buttons.find(button => button.includes(label));
    expect(button).toBeDefined();
    expect(button!.includes('disabled=""')).toBe(disabled);
  }
});
