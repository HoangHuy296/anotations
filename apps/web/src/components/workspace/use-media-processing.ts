"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { requestMediaProcessing, shouldAwaitMediaProcessing, shouldRequestMediaProcessing, waitForMediaProcessing, type MediaProcessingKind } from "@/lib/workspace/media-processing-client";
import type { SafeMediaReadiness } from "@/types/media-processing";

/**
 * Requests per-Asset media processing when a VIDEO/AUDIO Asset opens without one, waits for the durable Job, then refreshes the server-rendered
 * readiness so the engine receives the probed fps/duration/waveform. Duplicate mounts are safe: the server returns the same Job for the same Asset
 * and source revision. Engine selection never depends on this; it only supplies metadata.
 */
export function useMediaProcessing(assetId: string, kind: MediaProcessingKind, state: SafeMediaReadiness["state"]) {
  const router = useRouter();
  useEffect(() => {
    if (!shouldAwaitMediaProcessing(state)) return;
    const controller = new AbortController();
    void (async () => {
      try {
        if (shouldRequestMediaProcessing(state) && !(await requestMediaProcessing(assetId, kind, controller.signal))) return;
        const final = await waitForMediaProcessing(assetId, controller.signal);
        if (!controller.signal.aborted && final && final !== state) router.refresh();
      } catch { /* the engine keeps working with its documented fallbacks */ }
    })();
    return () => controller.abort();
  }, [assetId, kind, state, router]);
}
