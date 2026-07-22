import { Badge } from "@/components/ui/badge";

export function JobStageIndicator({ status, stage }: { status: string; stage: string | null }) {
  const variant = status === "COMPLETED" ? "success" : status === "FAILED" || status === "CANCELED" ? "danger" : status === "CANCELING" ? "warning" : "info";
  return <div className="flex flex-wrap items-center gap-2"><Badge variant={variant}>{status.replaceAll("_", " ")}</Badge>{stage ? <span className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600">{stage.replaceAll("_", " ")}</span> : null}</div>;
}
