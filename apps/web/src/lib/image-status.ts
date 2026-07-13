import { AssetStatus } from "@internal/db";

export const imageStatusOptions = [
  AssetStatus.NEW,
  AssetStatus.PROCESSING,
  AssetStatus.READY,
  AssetStatus.IN_PROGRESS,
  AssetStatus.COMPLETED,
  AssetStatus.NEEDS_REVIEW,
  AssetStatus.REVIEWED,
  AssetStatus.REJECTED,
  AssetStatus.SKIPPED,
  AssetStatus.ARCHIVED,
  AssetStatus.FAILED,
] as const;

export const imageStatusPresentation = {
  [AssetStatus.NEW]: {
    label: "New",
    variant: "neutral" as const,
  },
  [AssetStatus.PROCESSING]: {
    label: "Processing",
    variant: "info" as const,
  },
  [AssetStatus.READY]: {
    label: "Ready",
    variant: "info" as const,
  },
  [AssetStatus.IN_PROGRESS]: {
    label: "In progress",
    variant: "warning" as const,
  },
  [AssetStatus.COMPLETED]: {
    label: "Completed",
    variant: "success" as const,
  },
  [AssetStatus.NEEDS_REVIEW]: {
    label: "Needs review",
    variant: "warning" as const,
  },
  [AssetStatus.REVIEWED]: {
    label: "Reviewed",
    variant: "success" as const,
  },
  [AssetStatus.REJECTED]: {
    label: "Rejected",
    variant: "danger" as const,
  },
  [AssetStatus.SKIPPED]: {
    label: "Skipped",
    variant: "neutral" as const,
  },
  [AssetStatus.ARCHIVED]: {
    label: "Archived",
    variant: "neutral" as const,
  },
  [AssetStatus.FAILED]: {
    label: "Failed",
    variant: "danger" as const,
  },
};
