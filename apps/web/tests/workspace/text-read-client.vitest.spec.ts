import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureTextSourceReady, fetchTextSource, triggerTextSourcePreparation } from "@/lib/workspace/text-read-client";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), { status });
}

describe("text-read-client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetchTextSource calls the exact route and returns the unwrapped data", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, readiness: "READY", assetId: "a1", datasetId: "d1", sourceIdentity: "sha256:x", offsetUnit: "UTF16_CODE_UNIT", sourceByteLength: 1, sourceCodeUnitLength: 1, text: "x", boundaryOffsets: [0, 1] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchTextSource("a1");
    expect(fetchMock).toHaveBeenCalledWith("/api/assets/a1/text", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    expect(result).toMatchObject({ ok: true, readiness: "READY", text: "x" });
  });

  it("triggerTextSourcePreparation POSTs and returns the unwrapped data", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ jobId: "j1", status: "QUEUED", created: true, ready: false }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await triggerTextSourcePreparation("a1");
    expect(fetchMock).toHaveBeenCalledWith("/api/assets/a1/text/prepare", expect.objectContaining({ method: "POST" }));
    expect(result).toEqual({ jobId: "j1", status: "QUEUED", created: true, ready: false });
  });

  it("a non-2xx or error-shaped response throws with the server error code attached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "GITEA_NOT_FOUND", message: "nope" } }), { status: 404 })));
    await expect(fetchTextSource("missing")).rejects.toMatchObject({ code: "GITEA_NOT_FOUND", status: 404 });
  });

  it("ensureTextSourceReady: an already-READY source resolves on the first fetch, never calling prepare", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/prepare")) throw new Error("must not call prepare for an already-ready source");
      return jsonResponse({ ok: true, readiness: "READY", assetId: "a1", datasetId: "d1", sourceIdentity: "sha256:x", offsetUnit: "UTF16_CODE_UNIT", sourceByteLength: 1, sourceCodeUnitLength: 1, text: "x", boundaryOffsets: [0, 1] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await ensureTextSourceReady("a1", { intervalMs: 0 });
    expect(result.ok && result.readiness).toBe("READY");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ensureTextSourceReady: an UNPREPARED source triggers preparation once, then polls until READY", async () => {
    let getCalls = 0;
    let prepareCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/prepare")) {
        prepareCalls += 1;
        return jsonResponse({ jobId: "j1", status: "QUEUED", created: true, ready: false }, 202);
      }
      getCalls += 1;
      const readiness = getCalls < 3 ? "PREPARING" : "READY";
      return jsonResponse({ ok: true, readiness, assetId: "a1", datasetId: "d1", ...(readiness === "READY" ? { sourceIdentity: "sha256:x", offsetUnit: "UTF16_CODE_UNIT", sourceByteLength: 1, sourceCodeUnitLength: 1, text: "x", boundaryOffsets: [0, 1] } : {}) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await ensureTextSourceReady("a1", { intervalMs: 0, maxAttempts: 10 });
    expect(prepareCalls).toBe(1);
    expect(getCalls).toBe(3);
    expect(result.ok && result.readiness).toBe("READY");
  });

  it("ensureTextSourceReady: stops polling immediately once the signal is aborted, without a spurious extra fetch", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) controller.abort();
      return jsonResponse({ ok: true, readiness: "PREPARING", assetId: "a1", datasetId: "d1" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await ensureTextSourceReady("a1", { intervalMs: 0, signal: controller.signal });
    expect(result.ok && result.readiness).toBe("PREPARING");
    expect(calls).toBe(1);
  });

  it("ensureTextSourceReady: a NOT_FOUND outcome is terminal immediately -- never tries to prepare a concealed/missing asset", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/prepare")) throw new Error("must not call prepare for a NOT_FOUND asset");
      return new Response(JSON.stringify({ error: { code: "GITEA_NOT_FOUND", message: "not found" } }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(ensureTextSourceReady("missing", { intervalMs: 0 })).rejects.toMatchObject({ code: "GITEA_NOT_FOUND" });
  });
});
