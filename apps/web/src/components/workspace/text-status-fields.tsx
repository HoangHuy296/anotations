"use client";

import { Badge } from "@/components/ui/badge";
import { useTextAnnotationStore } from "@/stores/text-annotation-store";
import type { WorkspaceSelection } from "@/types/workspace";

type TextSelection = Extract<WorkspaceSelection, { engine: "TEXT" }>;

export function TextStatusFields({ selection, details = false, compact = false }: { selection?: TextSelection; details?: boolean; compact?: boolean }) {
  const reader = useTextAnnotationStore((store) => store.reader);
  const range = useTextAnnotationStore((store) => store.selection);
  const workspace = selection ?? reader?.workspace;
  if (!workspace) return compact ? <Badge variant="neutral" title="No document loaded">Text</Badge> : <span>Text · No document loaded</span>;
  const current = reader?.workspace.asset.id === workspace.asset.id ? reader : null;
  const ready = current?.status === "ready";
  const fields = [
    ["Filename", workspace.asset.filename],
    ["Encoding", ready ? "UTF-8" : "Unavailable"],
    ["Length (UTF-16 code units)", ready ? String(current.sourceLength) : "Unavailable"],
    ["Language", workspace.asset.language ?? "Unavailable"],
    ["Processing", current?.readiness ?? workspace.source.readiness],
  ];
  if (details) return <dl className="space-y-3 text-xs">{fields.map(([label, value]) => <div key={label} className="flex justify-between gap-3"><dt className="text-zinc-500">{label}</dt><dd className="max-w-[60%] break-words text-right text-zinc-900">{value}</dd></div>)}</dl>;
  // Header slot: one compact badge like the other engines, so the shared header row never grows or wraps. The detail stays in the tooltip.
  if (compact) return <Badge variant="neutral" title={`${ready ? `${current.sourceLength} UTF-16 code units` : current?.readiness ?? workspace.source.readiness} · ${range ? `Selected [${range.startOffset}, ${range.endOffset})` : "No text selected"}`}>Text</Badge>;
  return <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-600">
    <span>Text</span><span>{ready ? `${current.sourceLength} UTF-16 code units` : current?.readiness ?? workspace.source.readiness}</span>
    <span>{range ? `Selected [${range.startOffset}, ${range.endOffset})` : "No text selected"}</span>
  </div>;
}
