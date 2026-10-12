import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import { afterEach, describe, expect, it, vi } from "vitest";

import { MEDIA_PROCESSING_JOB_TYPE, requestMediaProcessing, shouldAwaitMediaProcessing, shouldRequestMediaProcessing, waitForMediaProcessing } from "@/lib/workspace/media-processing-client";

const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });

describe("media-processing-client", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("requests processing only for an Asset that was never requested, and waits on any non-terminal state", () => {
    expect(shouldRequestMediaProcessing("NOT_REQUESTED")).toBe(true);
    for (const state of ["QUEUED", "RUNNING", "RETRYING", "CANCELING", "COMPLETED", "FAILED", "CANCELED"] as const) expect(shouldRequestMediaProcessing(state)).toBe(false);
    for (const state of ["NOT_REQUESTED", "QUEUED", "RUNNING", "RETRYING", "CANCELING"] as const) expect(shouldAwaitMediaProcessing(state)).toBe(true);
    for (const state of ["COMPLETED", "FAILED", "CANCELED"] as const) expect(shouldAwaitMediaProcessing(state)).toBe(false);
  });

  it("POSTs exactly the Asset-scoped route with the job type of the modality, never storage or Dataset input", async () => {
    const fetchMock = vi.fn(async () => json({ jobId: "j1", status: "QUEUED", reused: false }, 201));
    vi.stubGlobal("fetch", fetchMock);
    expect(await requestMediaProcessing("a1", "VIDEO")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/assets/a1/media-processing", expect.objectContaining({ method: "POST", credentials: "same-origin", body: JSON.stringify({ type: "EXTRACT_VIDEO_METADATA" }) }));
    await requestMediaProcessing("a2", "AUDIO");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/assets/a2/media-processing", expect.objectContaining({ body: JSON.stringify({ type: MEDIA_PROCESSING_JOB_TYPE.AUDIO }) }));
  });

  it("a refused request (no permission or ineligible source) is not an error and starts no wait", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ code: "MEDIA_ASSET_INELIGIBLE" }, 422)));
    expect(await requestMediaProcessing("a1", "VIDEO")).toBe(false);
  });

  it("polls the status route until a terminal state and returns it", async () => {
    vi.useFakeTimers();
    const states = ["QUEUED", "RUNNING", "COMPLETED"];
    const fetchMock = vi.fn(async () => json({ state: states.shift() }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = waitForMediaProcessing("a1", new AbortController().signal, 10, 10);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe("COMPLETED");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith("/api/assets/a1/media-processing/status", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("stops waiting when aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => json({ state: "RUNNING" })));
    const pending = waitForMediaProcessing("a1", controller.signal, 10, 1000);
    await vi.advanceTimersByTimeAsync(25);
    controller.abort();
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toBe("RUNNING");
  });
});
