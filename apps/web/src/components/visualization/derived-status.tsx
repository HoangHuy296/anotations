"use client";
import { useVisualizationRead } from "@/components/visualization/visualization-session";
import type { ViewerDerivedProfile } from "@/types/visualization";
export function DerivedStatus() {
  const { data, error } = useVisualizationRead<ViewerDerivedProfile>("/derived");
  return <p role="status" className="mt-2 text-sm text-zinc-500">Previews and profiles: {data?.state.status ?? (error ? "unavailable" : "loading")}.
    {data?.state.status === "ready" ? " Generated thumbnails are preferred for the contact sheet." : " Original images remain available while derived artifacts are pending or unavailable."}</p>;
}
