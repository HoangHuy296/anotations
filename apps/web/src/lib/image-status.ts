import type { AssetStatus } from "@internal/db";

export const imageStatusOptions = [
  "NEW", "PROCESSING", "READY", "IN_PROGRESS", "COMPLETED", "NEEDS_REVIEW",
  "REVIEWED", "REJECTED", "SKIPPED", "ARCHIVED", "FAILED",
] as const satisfies readonly AssetStatus[];

export const imageStatusPresentation = {
  NEW: {
    label: "New",
    variant: "neutral" as const,
  },
  PROCESSING: {
    label: "Processing",
    variant: "info" as const,
  },
  READY: {
    label: "Ready",
    variant: "info" as const,
  },
  IN_PROGRESS: {
    label: "In progress",
    variant: "warning" as const,
  },
  COMPLETED: {
    label: "Completed",
    variant: "success" as const,
  },
  NEEDS_REVIEW: {
    label: "Needs review",
    variant: "warning" as const,
  },
  REVIEWED: {
    label: "Reviewed",
    variant: "success" as const,
  },
  REJECTED: {
    label: "Rejected",
    variant: "danger" as const,
  },
  SKIPPED: {
    label: "Skipped",
    variant: "neutral" as const,
  },
  ARCHIVED: {
    label: "Archived",
    variant: "neutral" as const,
  },
  FAILED: {
    label: "Failed",
    variant: "danger" as const,
  },
} satisfies Record<AssetStatus, { label: string; variant: "neutral" | "info" | "warning" | "success" | "danger" }>;
