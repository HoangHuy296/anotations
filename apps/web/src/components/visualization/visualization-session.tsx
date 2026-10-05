"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { visualizationFetch, handleVisualizationAccessError } from "@/lib/visualization/read-client";

const Context = createContext<{ datasetId: string; read: (suffix: string, signal?: AbortSignal) => Promise<Response> } | null>(null);
export function VisualizationSession({ datasetId, children }: { datasetId: string; children: ReactNode }) {
  const router = useRouter();
  const [blocked, setBlocked] = useState(false);
  const read = useCallback(async (suffix: string, signal?: AbortSignal) => {
    try { return await visualizationFetch(`/api/datasets/${datasetId}/visualization${suffix}`, signal); }
    catch (error) {
      if (handleVisualizationAccessError(error, datasetId, () => setBlocked(true), path => router.replace(path))) router.refresh();
      throw error;
    }
  }, [datasetId, router]);
  useEffect(() => {
    const controller = new AbortController();
    const verify = () => { if (document.visibilityState !== "hidden") void read("", controller.signal).catch(() => {}); };
    verify();
    window.addEventListener("focus", verify);
    document.addEventListener("visibilitychange", verify);
    return () => { controller.abort(); window.removeEventListener("focus", verify); document.removeEventListener("visibilitychange", verify); };
  }, [read]);
  return <Context.Provider value={{ datasetId, read }}>{blocked ? <p role="status">Dataset access changed. Returning to your workspace.</p> : children}</Context.Provider>;
}
export function useVisualizationSession() {
  const value = useContext(Context);
  if (!value) throw new Error("Visualization session is required.");
  return value;
}
export function useVisualizationRead<T>(path: string) {
  const { read } = useVisualizationSession();
  const [attempt, setAttempt] = useState(0);
  const key = `${path}:${attempt}`;
  const [result, setResult] = useState<{ key: string; data?: T; error?: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void read(path, controller.signal).then(response => response.json()).then(body => {
      if (!controller.signal.aborted) setResult({ key, data: body.data as T });
    }).catch(() => { if (!controller.signal.aborted) setResult({ key, error: "This view could not be loaded." }); });
    return () => controller.abort();
  }, [key, path, read]);
  return { data: result?.key === key ? result.data : undefined, error: result?.key === key ? result.error : undefined, retry: () => setAttempt(value => value + 1) };
}
