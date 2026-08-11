import type { ComponentType, ReactElement } from "react";
import type { AssetStatus, Modality } from "@internal/db";

import { AnnotationCanvas } from "@/components/workspace/annotation-canvas";
import { AudioEngine } from "@/components/workspace/audio-engine";
import { TextEngine } from "@/components/workspace/text-engine";
import { VideoEngine } from "@/components/workspace/video-engine";
import { ImageToolbox } from "@/components/workspace/image-toolbox";
import { VideoToolbox } from "@/components/workspace/video-toolbox";
import { AudioToolbox } from "@/components/workspace/audio-toolbox";
import { TextToolbox } from "@/components/workspace/text-toolbox";
import { ImagePropertiesTabs } from "@/components/workspace/image-properties-tabs";
import { VideoPropertiesTabs } from "@/components/workspace/video-properties-tabs";
import { PlaceholderPropertiesTabs } from "@/components/workspace/placeholder-properties-tabs";
import { ImageStatusFields } from "@/components/workspace/image-status-fields";
import { PlaceholderStatusFields } from "@/components/workspace/placeholder-status-fields";
import type { SafeWorkspaceAsset } from "@/types/image-workspace";
import type { WorkspaceSelection } from "@/types/workspace";
import { SafeVideoWorkspaceAsset } from "@/types/video-workspace";

type Engine = WorkspaceSelection["engine"];

/** Shared props every `PropertiesPanel` tabs implementation may use, regardless of engine. */
export type PropertiesTabsProps = {
  datasetId: string;
  selection: WorkspaceSelection;
  images: SafeWorkspaceAsset[];
  videos: SafeVideoWorkspaceAsset[];
  page: number;
  pageSize: number;
  totalAssets: number;
  completedAssets: number;
  search: string;
  statuses: AssetStatus[];
  selectedAssetId: string | null;
  tab: string;
  setTab: (tab: string) => void;
};

/**
 * One entry per `WorkspaceSelection.engine`. `WorkspaceEngine`,
 * `DatasetSidebar`, `PropertiesPanel`, and the shared status surface each
 * read their modality-specific content from this single registry instead of
 * maintaining an independent `switch`/`if` over `engine`/`asset.modality`
 * (spec FR-041–FR-044). See `contracts/workspace-shell-contract.md`.
 */
export type WorkspaceEngineRegistryEntry = {
  /** Rendered by `WorkspaceEngine` — canvas/player/waveform/document surface only. */
  Component: ComponentType<{ selection: WorkspaceSelection }>;
  /** Rendered by `DatasetSidebar`'s toolbox region. */
  Toolbox: ComponentType<Record<string, never>>;
  /** Rendered by `PropertiesPanel`'s tab region. */
  Tabs: ComponentType<PropertiesTabsProps>;
  /** Rendered by the shared status surface (`workspace-header.tsx`). */
  StatusFields: ComponentType<Record<string, never>>;
};

function ImageEngineEntry({ selection }: { selection: WorkspaceSelection }): ReactElement | null {
  if (selection.engine !== "IMAGE") return null;
  return <AnnotationCanvas image={selection.asset} annotations={selection.annotations} unsupportedAnnotations={selection.unsupportedAnnotations} labels={selection.labels} />;
}

function VideoEngineEntry({ selection }: { selection: WorkspaceSelection }): ReactElement | null {
  if (selection.engine !== "VIDEO") return null;
  return <VideoEngine key={selection.asset.id} asset={selection.asset} readiness={selection.readiness} annotations={selection.annotations} />;
}

function AudioEngineEntry({ selection }: { selection: WorkspaceSelection }): ReactElement | null {
  if (selection.engine !== "AUDIO") return null;
  return <AudioEngine key={selection.asset.id} asset={selection.asset} readiness={selection.readiness} />;
}

function TextEngineEntry({ selection }: { selection: WorkspaceSelection }): ReactElement | null {
  if (selection.engine !== "TEXT") return null;
  return <TextEngine key={selection.asset.id} asset={selection.asset} />;
}

function ImageTabsEntry(props: PropertiesTabsProps): ReactElement | null {
  if (props.selection.engine !== "IMAGE") return null;
  return <ImagePropertiesTabs datasetId={props.datasetId} selection={props.selection} images={props.images} page={props.page} pageSize={props.pageSize} totalAssets={props.totalAssets} completedAssets={props.completedAssets} search={props.search} statuses={props.statuses} selectedAssetId={props.selectedAssetId} tab={props.tab} setTab={props.setTab} />;
}

function VideoTabsEntry(props: PropertiesTabsProps): ReactElement | null {
  if (props.selection.engine !== "VIDEO") return null;
  return <VideoPropertiesTabs datasetId={props.datasetId} selection={props.selection} images={props.images} page={props.page} pageSize={props.pageSize} totalAssets={props.totalAssets} completedAssets={props.completedAssets} search={props.search} statuses={props.statuses} selectedAssetId={props.selectedAssetId} tab={props.tab} setTab={props.setTab} />;
}

function placeholderTabsEntry(engine: "AUDIO" | "TEXT") {
  return function PlaceholderTabsEntry(props: PropertiesTabsProps): ReactElement | null {
    if (props.selection.engine !== engine) return null;
    return <PlaceholderPropertiesTabs datasetId={props.datasetId} selection={props.selection} images={props.images} page={props.page} pageSize={props.pageSize} totalAssets={props.totalAssets} completedAssets={props.completedAssets} search={props.search} statuses={props.statuses} selectedAssetId={props.selectedAssetId} />;
  };
}

function placeholderStatusFields(engine: Exclude<Modality, "IMAGE">) {
  return function PlaceholderStatusFieldsEntry() {
    return <PlaceholderStatusFields engine={engine} />;
  };
}

export const workspaceEngineRegistry: Record<Engine, WorkspaceEngineRegistryEntry> = {
  IMAGE: {
    Component: ImageEngineEntry,
    Toolbox: ImageToolbox,
    Tabs: ImageTabsEntry,
    StatusFields: ImageStatusFields,
  },
  VIDEO: {
    Component: VideoEngineEntry,
    Toolbox: VideoToolbox,
    Tabs: VideoTabsEntry,
    StatusFields: placeholderStatusFields("VIDEO"),
  },
  AUDIO: {
    Component: AudioEngineEntry,
    Toolbox: AudioToolbox,
    Tabs: placeholderTabsEntry("AUDIO"),
    StatusFields: placeholderStatusFields("AUDIO"),
  },
  TEXT: {
    Component: TextEngineEntry,
    Toolbox: TextToolbox,
    Tabs: placeholderTabsEntry("TEXT"),
    StatusFields: placeholderStatusFields("TEXT"),
  },
};
