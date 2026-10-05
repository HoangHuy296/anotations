import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), actor: vi.fn(), connection: vi.fn() }));
vi.mock("@/lib/visualization/access", () => ({ readVisualizationAccess: mocks.access }));
vi.mock("@/lib/auth", () => ({ getRequestActor: mocks.actor }));
vi.mock("next/server", () => ({ connection: mocks.connection }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NOT_FOUND"); },
  redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); },
}));
vi.mock("@/components/layout/app-shell", () => ({ AppShell: () => null }));

import VisualizationPage from "@/app/(app)/datasets/visualize/[datasetId]/page";
import VisualizationIndexPage from "@/app/(app)/datasets/visualize/page";
import { VisualizationShell } from "@/components/visualization/visualization-shell";

const dataset = { id: "00000000-0000-4000-8000-000000000001", name: "Authorized dataset" };
const render = (tab?: string | string[]) => VisualizationPage({ params: Promise.resolve({ datasetId: dataset.id }), searchParams: Promise.resolve({ tab }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue({ id: "actor" });
  mocks.access.mockResolvedValue({ kind: "ready", dataset });
});

test("every section retains the fresh guard before receiving dataset identity", async () => {
  for (const tab of [undefined, "data", "insights", "schema", "versions", "activity", "invalid", ["schema", "data"]]) {
    const page = await render(tab);
    expect(page.props.children.type).toBe(VisualizationShell);
    expect(page.props.children.props.dataset).toEqual(dataset);
    expect(page.props.children.props.tab).toBe(typeof tab === "string" && tab !== "invalid" ? tab : "data");
  }
  expect(mocks.connection).toHaveBeenCalledTimes(8);
  expect(mocks.access).toHaveBeenCalledTimes(8);
  expect(mocks.access).toHaveBeenLastCalledWith({ id: "actor" }, dataset.id);
});

test("reopening or access denial stops shell rendering on all direct tab URLs", async () => {
  for (const tab of ["data", "insights", "schema", "versions", "activity"]) {
    mocks.access.mockResolvedValue({ kind: "redirect", destination: `/workspace/${dataset.id}` });
    await expect(render(tab)).rejects.toThrow(`REDIRECT:/workspace/${dataset.id}`);
    mocks.access.mockResolvedValue({ kind: "not-found" });
    await expect(render(tab)).rejects.toThrow("NOT_FOUND");
  }
});

test("index still redirects to the single dataset catalog", () => {
  expect(() => VisualizationIndexPage()).toThrow("REDIRECT:/datasets");
});
