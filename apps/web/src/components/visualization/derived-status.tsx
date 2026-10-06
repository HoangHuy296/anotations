"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useVisualizationRead } from "@/components/visualization/visualization-session";
import type { ViewerDerivedProfile } from "@/types/visualization";

const statusLabels = { pending: "Pending", processing: "Processing", ready: "Ready", failed: "Failed" };

export function DerivedStatus() {
  const { data, error, retry } = useVisualizationRead<ViewerDerivedProfile>("/derived");

  if (error) return (
    <div role="status" className="mt-3">
      <p className="text-xs leading-5 text-zinc-500 dark:text-zinc-400">Preview status could not be loaded.</p>
      <Button type="button" variant="secondary" size="sm" className="mt-2 h-7 min-h-7 rounded-md" onClick={retry}>Retry preview status</Button>
    </div>
  );

  if (!data) return (
    <div role="status" className="mt-3 space-y-2">
      <span className="sr-only">Loading preview status</span>
      <span aria-hidden="true" className="block h-5 w-20 rounded bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-800" />
      <span aria-hidden="true" className="block h-3 rounded bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-800" />
    </div>
  );

  const { status, current } = data.state;
  const description = status === "ready"
    ? current ? "Generated previews are available for the current snapshot." : "An earlier snapshot is available. Source records have changed."
    : status === "processing" ? "Snapshot previews are being generated. Stored original images can still be inspected."
      : status === "failed" ? "Preview generation failed. Stored original images can still be inspected."
        : "Snapshot previews are awaiting processing. Stored original images can still be inspected.";

  return (
    <div role="status" className="mt-3">
      <Badge variant={status === "ready" ? "success" : status === "failed" ? "danger" : status === "processing" ? "info" : "neutral"} className="rounded-md px-2 py-1">{statusLabels[status]}</Badge>
      <p className="mt-2 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{description}</p>
    </div>
  );
}
