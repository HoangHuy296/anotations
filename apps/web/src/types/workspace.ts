import type { SafeMediaReadiness } from "@/types/media-processing";
import type { SafeVideoAnnotations } from "@/types/video-annotation";
import type { SafeImageAnnotation, SafeImageWorkspaceAsset, SafeReadOnlyImageAnnotation, SafeWorkspaceLabel } from "@/types/image-workspace";

export type SafeReadOnlyWorkspaceAsset = {
  id: string;
  modality: "TEXT";
  filename: string;
  description: string | null;
};

export type WorkspaceSelection =
  | { engine: "IMAGE"; asset: SafeImageWorkspaceAsset; annotations: SafeImageAnnotation[]; unsupportedAnnotations: SafeReadOnlyImageAnnotation[]; labels: SafeWorkspaceLabel[] }
  | { engine: "VIDEO"; asset: { id: string; modality: "VIDEO"; filename: string; description: string | null; version: number }; readiness: SafeMediaReadiness; annotations: SafeVideoAnnotations }
  | { engine: "AUDIO"; asset: { id: string; modality: "AUDIO"; filename: string; description: string | null }; readiness: SafeMediaReadiness }
  | { engine: "TEXT"; asset: SafeReadOnlyWorkspaceAsset };
