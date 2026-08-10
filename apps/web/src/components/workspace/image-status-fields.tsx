import { Badge } from "@/components/ui/badge";

/**
 * IMAGE's shared-status-surface content: the modality badge previously
 * hard-coded in `workspace-header.tsx`. Save/dirty/conflict display and the
 * "Connected" indicator stay in the shared header shell itself — they are
 * identical across engines today, not IMAGE-specific.
 */
export function ImageStatusFields() {
  return <Badge variant="neutral">Image</Badge>;
}
