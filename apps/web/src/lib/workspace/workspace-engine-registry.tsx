"use client";

import type { ComponentType, ReactElement } from "react";
import type { AssetStatus, Modality } from "@internal/db";

import { ImageEngine } from "@/components/workspace/image-engine";
import { AudioEngine } from "@/components/workspace/audio-engine";
import { TextEngine } from "@/components/workspace/text-engine";
import { VideoEngine } from "@/components/workspace/video-engine";
import { ImageToolbox } from "@/components/workspace/image-toolbox";
import { VideoToolbox } from "@/components/workspace/video-toolbox";
import { AudioToolbox } from "@/components/workspace/audio-toolbox";
import { TextToolbox } from "@/components/workspace/text-toolbox";
import { ImagePropertiesTabs } from "@/components/workspace/image-properties-tabs";
import { VideoPropertiesTabs } from "@/components/workspace/video-properties-tabs";
import { AudioPropertiesTabs } from "@/components/workspace/audio-properties-tabs";
import { TextPropertiesTabs } from "@/components/workspace/text-properties-tabs";
import { TextStatusFields } from "@/components/workspace/text-status-fields";
import { ImageStatusFields } from "@/components/workspace/image-status-fields";
import { PlaceholderStatusFields } from "@/components/workspace/placeholder-status-fields";
import type { AssetNavigatorFilters } from "@/components/workspace/asset-navigator";
import type { SafeWorkspaceAsset } from "@/types/workspace";
import type { WorkspaceSelection } from "@/types/workspace";
import { createEngineFlush, type EngineFlushResult } from "@/lib/workspace/workspace-engine-flush";
import { UNAVAILABLE_TEXT_ENGINE_CAPABILITIES, type TextEngineCapabilities } from "@/lib/workspace/text-engine-capabilities";

export type { EngineFlushResult } from "@/lib/workspace/workspace-engine-flush";
export type { TextEngineCapabilities } from "@/lib/workspace/text-engine-capabilities";

type Engine = WorkspaceSelection["engine"];

/** Shared props every `PropertiesPanel` tabs implementation may use, regardless of engine. */
export type PropertiesTabsProps = {
  datasetId: string;
  selection: WorkspaceSelection;
  /** Shared, modality-neutral list for the Assets tab. */
  assets: SafeWorkspaceAsset[];
  page: number;
  pageSize: number;
  totalAssets: number;
  completedAssets: number;
  search: string;
  statuses: AssetStatus[];
  selectedAssetId: string | null;
  tab: string;
  setTab: (tab: string) => void;
  /** Active Asset Browser filters/sort (022). */
  filters: AssetNavigatorFilters;
};

/**
 * One entry per authoritative Dataset modality. `WorkspaceEngine`,
 * `DatasetSidebar`, `PropertiesPanel`, and the shared status surface each
 * read their modality-specific content from this single registry instead of
 * maintaining an independent `switch`/`if` over `engine`/`asset.modality`
 * (spec FR-041–FR-044). See `contracts/workspace-shell-contract.md`.
 */
export type WorkspaceEngineRegistryEntry = {
  /** Rendered by `WorkspaceEngine` — canvas/player/waveform/document surface only. */
  Component: ComponentType<{ selection: WorkspaceSelection | null }>;
  /** Rendered by `DatasetSidebar`'s toolbox region. */
  Toolbox: ComponentType<Record<string, never>>;
  /** Rendered by `PropertiesPanel`'s tab region. */
  Tabs: ComponentType<PropertiesTabsProps>;
  /** Rendered by the shared status surface (`workspace-header.tsx`). */
  StatusFields: ComponentType<Record<string, never>>;
  /**
   * The active-engine save barrier (data-model.md "Workflow and client
   * state"): every navigation/workflow caller awaits this before reading
   * the current asset revision. Success carries that revision; failure
   * blocks Submit/navigation instead of proceeding with stale state.
   */
  flush: (datasetId: string, assetId: string) => Promise<EngineFlushResult>;
  /** TEXT-only for now (T045); other engines are always fully capable once an asset is selected. */
  deriveCapabilities?: (selection: WorkspaceSelection) => TextEngineCapabilities;
};

function isWorkflowReadOnly(status: AssetStatus) {
  // This registry is reachable from client components, so `AssetStatus` must
  // stay type-only: importing Prisma's runtime enum here would bundle Prisma
  // into the browser. These values are the persisted Asset.status contract.
  return status === "NEEDS_REVIEW" || status === "REVIEWED" || status === "REJECTED";
}

/** A Dataset-selected engine shell with no content, player or fake Asset. */
function EmptyEngineSurface({ modality }: { modality: Exclude<Engine, "IMAGE"> }) {
  const label = { VIDEO: "video", AUDIO: "audio", TEXT: "text" }[modality];
  return <section className="canvas-grid grid min-h-[520px] min-w-0 place-items-center bg-zinc-950 px-6 text-center lg:min-h-0"><div><h2 className="text-sm font-semibold text-zinc-200">{label[0].toUpperCase() + label.slice(1)} workspace</h2><p className="mt-2 text-xs leading-5 text-zinc-400">No {label} selected. Choose an asset from the list or import compatible content into this dataset.</p></div></section>;
}

function ImageEngineEntry({ selection }: { selection: WorkspaceSelection | null }): ReactElement | null {
  if (!selection) return <ImageEngine image={null} annotations={[]} unsupportedAnnotations={[]} labels={[]} />;
  if (selection.engine !== "IMAGE") return null;
  return <ImageEngine image={selection.asset} annotations={selection.annotations} unsupportedAnnotations={selection.unsupportedAnnotations} labels={selection.labels} readOnly={isWorkflowReadOnly(selection.asset.status)} />;
}

function VideoEngineEntry({ selection }: { selection: WorkspaceSelection | null }): ReactElement | null {
  if (!selection) return <EmptyEngineSurface modality="VIDEO" />;
  if (selection.engine !== "VIDEO") return null;
  return <VideoEngine key={selection.asset.id} video={selection.asset} readiness={selection.readiness} annotations={selection.annotations} readOnly={isWorkflowReadOnly(selection.asset.status)} />;
}

function AudioEngineEntry({ selection }: { selection: WorkspaceSelection | null }): ReactElement | null {
  if (!selection) return <EmptyEngineSurface modality="AUDIO" />;
  if (selection.engine !== "AUDIO") return null;
  return <AudioEngine key={selection.asset.id} audio={selection.asset} readiness={selection.readiness} />;
}

function TextEngineEntry({ selection }: { selection: WorkspaceSelection | null }): ReactElement | null {
  if (!selection) return <EmptyEngineSurface modality="TEXT" />;
  if (selection.engine !== "TEXT") return null;
  return <TextEngine key={selection.asset.id} selection={selection} />;
}

function ImageTabsEntry(props: PropertiesTabsProps): ReactElement | null {
  if (props.selection.engine !== "IMAGE") return null;
  return <ImagePropertiesTabs datasetId={props.datasetId} selection={props.selection} assets={props.assets} page={props.page} pageSize={props.pageSize} totalAssets={props.totalAssets} completedAssets={props.completedAssets} search={props.search} statuses={props.statuses} selectedAssetId={props.selectedAssetId} tab={props.tab} setTab={props.setTab} filters={props.filters} />;
}

function VideoTabsEntry(props: PropertiesTabsProps): ReactElement | null {
  if (props.selection.engine !== "VIDEO") return null;
  return <VideoPropertiesTabs datasetId={props.datasetId} selection={props.selection} assets={props.assets} page={props.page} pageSize={props.pageSize} totalAssets={props.totalAssets} completedAssets={props.completedAssets} search={props.search} statuses={props.statuses} selectedAssetId={props.selectedAssetId} tab={props.tab} setTab={props.setTab} filters={props.filters} />;
}

function AudioTabsEntry(props: PropertiesTabsProps): ReactElement | null {
  if (props.selection.engine !== "AUDIO") return null;
  return <AudioPropertiesTabs datasetId={props.datasetId} selection={props.selection} assets={props.assets} page={props.page} pageSize={props.pageSize} totalAssets={props.totalAssets} completedAssets={props.completedAssets} search={props.search} statuses={props.statuses} selectedAssetId={props.selectedAssetId} tab={props.tab} setTab={props.setTab} filters={props.filters} />;
}

function TextTabsEntry(props: PropertiesTabsProps): ReactElement | null {
  if (props.selection.engine !== "TEXT") return null;
  return <TextPropertiesTabs datasetId={props.datasetId} selection={props.selection} assets={props.assets} page={props.page} pageSize={props.pageSize} totalAssets={props.totalAssets} completedAssets={props.completedAssets} search={props.search} statuses={props.statuses} selectedAssetId={props.selectedAssetId} tab={props.tab} setTab={props.setTab} filters={props.filters} />;
}

function TextStatusFieldsEntry() {
  return <TextStatusFields />;
}

function placeholderStatusFields(engine: Exclude<Modality, "IMAGE">) {
  return function PlaceholderStatusFieldsEntry() {
    return <PlaceholderStatusFields engine={engine} />;
  };
}

function deriveTextCapabilitiesEntry(selection: WorkspaceSelection): TextEngineCapabilities {
  // workspace-read.ts (T048) computes the real capabilities server-side
  // (readiness + policy + permissions + workflow state) and carries them on
  // the selection itself; this is just the registry's typed accessor.
  return selection.engine === "TEXT" ? selection.capabilities : UNAVAILABLE_TEXT_ENGINE_CAPABILITIES;
}

export const workspaceEngineRegistry: Record<Engine, WorkspaceEngineRegistryEntry> = {
  IMAGE: {
    Component: ImageEngineEntry,
    Toolbox: ImageToolbox,
    Tabs: ImageTabsEntry,
    StatusFields: ImageStatusFields,
    flush: createEngineFlush(false),
  },
  VIDEO: {
    Component: VideoEngineEntry,
    Toolbox: VideoToolbox,
    Tabs: VideoTabsEntry,
    StatusFields: placeholderStatusFields("VIDEO"),
    flush: createEngineFlush(true),
  },
  AUDIO: {
    Component: AudioEngineEntry,
    Toolbox: AudioToolbox,
    Tabs: AudioTabsEntry,
    StatusFields: placeholderStatusFields("AUDIO"),
    flush: createEngineFlush(false),
  },
  TEXT: {
    Component: TextEngineEntry,
    Toolbox: TextToolbox,
    Tabs: TextTabsEntry,
    StatusFields: TextStatusFieldsEntry,
    flush: createEngineFlush(false, true),
    deriveCapabilities: deriveTextCapabilitiesEntry,
  },
};
