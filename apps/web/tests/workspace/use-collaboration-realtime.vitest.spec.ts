import { afterEach, describe, expect, it, vi } from "vitest";

let effect: (() => void | (() => void)) | undefined;

vi.mock("react", () => ({
  useEffect: (callback: () => void | (() => void), dependencies?: unknown[]) => {
    if (typeof dependencies?.[0] === "string") effect = callback;
    else callback();
  },
  useRef: <T,>(value: T) => ({ current: value }),
}));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  close() { this.onclose?.(); }
  open() { this.onopen?.(); }
}

describe("useCollaborationRealtime", () => {
  afterEach(() => {
    effect = undefined;
    FakeWebSocket.instances = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses a fresh ticket and invalidates after reconnect even when an offline event was missed", async () => {
    vi.useFakeTimers();
    let postgresRevision = 1;
    const observedRevisions: number[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { token: "initial-ticket" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { token: "fresh-ticket" } }) });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { location: { protocol: "http:", hostname: "localhost", host: "localhost:3000", port: "3000" } });
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const { useCollaborationRealtime } = await import("@/components/workspace/use-collaboration-realtime");
    useCollaborationRealtime({ datasetIds: ["dataset-a"], onInvalidate: () => observedRevisions.push(postgresRevision) });
    const cleanup = effect?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].open();
    expect(observedRevisions).toEqual([]);

    // The socket is offline while the authoritative PostgreSQL projection
    // changes. No websocket message is emitted or replayed.
    FakeWebSocket.instances[0].close();
    postgresRevision = 2;
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toContain("fresh-ticket");
    expect(FakeWebSocket.instances[1].url).not.toContain("initial-ticket");

    FakeWebSocket.instances[1].open();
    expect(observedRevisions).toEqual([2]);
    cleanup?.();
  });
});
