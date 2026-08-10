# Shared Workspace Shell Contract

This is a component-boundary contract, not an HTTP API contract. It governs
`apps/web/src/components/workspace/*.tsx` and
`apps/web/src/lib/workspace/workspace-engine-registry.ts`. It exists because:

- Phase 4 (spec FR-041–FR-044, User Story 7) builds the registry — the single
  lookup mechanism described below.
- Phase 5 (spec FR-032–FR-040, User Story 8) is about *where* existing VIDEO
  controls render, using that registry — not about any new request/response
  shape.

## The registry

`workspace-engine-registry.ts` exports one map, keyed by
`WorkspaceSelection.engine` (`src/types/workspace.ts`):

```ts
type WorkspaceEngineRegistryEntry = {
  Component: ComponentType<{ selection: Extract<WorkspaceSelection, { engine: Engine }> }>;
  toolbox: ToolboxSpec;       // consumed by DatasetSidebar
  tabs: TabsSpec;             // consumed by PropertiesPanel
  statusFields: StatusFieldsSpec; // consumed by the shared status surface
};

const workspaceEngineRegistry: Record<WorkspaceSelection["engine"], WorkspaceEngineRegistryEntry> = {
  IMAGE: { Component: ImageEngine, toolbox: imageToolbox, tabs: imageTabs, statusFields: imageStatusFields },
  VIDEO: { Component: VideoEngine, toolbox: videoToolbox, tabs: videoTabs, statusFields: videoStatusFields },
  AUDIO: { Component: AudioEngine, toolbox: audioToolbox, tabs: audioTabs, statusFields: audioStatusFields },
  TEXT:  { Component: TextEngine,  toolbox: textToolbox,  tabs: textTabs,  statusFields: textStatusFields },
};
```

It carries component references and display specifications only — never
storage identity, credentials, or provider data (FR-043). It is a static,
closed-union TypeScript module, not a runtime/dynamic/database-backed plugin
system (spec Known limitations).

## Rule

Exactly one component decides which Engine renders: `WorkspaceEngine`, via
`workspaceEngineRegistry[selection.engine].Component`.

```ts
const entry = workspaceEngineRegistry[selection.engine];
return <entry.Component selection={selection} />;
```

No shared component (`WorkspaceEngine`, `DatasetSidebar`, `PropertiesPanel`,
the status surface) may contain an independent `switch`/`if` keyed on
`selection.engine` or `asset.modality` beyond looking up its own field
(`toolbox`/`tabs`/`statusFields`) on the same registry entry. Adding, editing,
or removing an entry in `workspace-engine-registry.ts` is the only change a
future modality requires (FR-040, FR-044); it must never require editing any
of those four component files beyond the registry lookup already wired in.

## Shared components (exactly one each)

| Component | File | Reads from the registry |
|---|---|---|
| `DatasetSidebar` | `dataset-sidebar.tsx` | `registry[engine].toolbox` (navigation stays engine-independent) |
| `PropertiesPanel` | `properties-panel.tsx` | `registry[engine].tabs` |
| Shared status surface | `workspace-header.tsx` | `registry[engine].statusFields` |
| `WorkspaceEngine` | `workspace-engine.tsx` | `registry[engine].Component` (which Engine renders) |

No `Image*`/`Video*`/`Audio*`/`Text*`-prefixed sibling of `DatasetSidebar`,
`PropertiesPanel`, or the shared status surface is permitted (FR-034).

## Engine components (rendering/interaction surface only)

| Engine | File | May render | Must NOT render |
|---|---|---|---|
| Image engine | `annotation-canvas.tsx` | canvas, shape drawing/selection | sidebar, details/properties, save-state chrome |
| `VideoEngine` | `video-engine.tsx` | player, overlay, timeline, keyframe drag/resize | track toolbar, Video Details, temporal-label list, save-state footer |
| `AudioEngine` | `audio-engine.tsx` | waveform/player (currently read-only) | sidebar, details, save-state chrome |
| `TextEngine` | `text-engine.tsx` | document viewer (currently read-only) | sidebar, details, save-state chrome |

## Toolbox content by engine (`DatasetSidebar`)

| Engine | Tools |
|---|---|
| IMAGE | Select, Pan, Bounding box, Polygon, Circle, Point, Polyline *(unchanged — current behavior)* |
| VIDEO | IMAGE set, plus Temporal segment, playback controls, and the relocated track toolbar (create/select/save/delete track, Add Keyframe Here) |
| AUDIO | Waveform tools, Segment *(placeholder — engine remains read-only)* |
| TEXT | Entity, Span, Relation *(placeholder — engine remains read-only)* |

## Tab content by engine (`PropertiesPanel`)

| Engine | Tabs |
|---|---|
| IMAGE | Details, Labels, Shapes, Assets *(unchanged — current behavior)* |
| VIDEO | Video Details, Tracks, Labels, Shapes, Properties, Assets — selecting a Shapes/Tracks row seeks the player, highlights the shape, selects the track, and loads its properties |
| AUDIO | Audio Details, Labels, Segments, Properties *(placeholder — engine remains read-only)* |
| TEXT | Text Details, Labels, Annotations *(placeholder — engine remains read-only)* |

## Status fields by engine (shared status surface)

Always shown: save/dirty/saving/conflict state for the active resource.

| Engine | Additional fields |
|---|---|
| IMAGE | Zoom, connection *(unchanged — current behavior)* |
| VIDEO | Current frame, timestamp, playback speed, latency |
| AUDIO | Current time, playback speed |
| TEXT | Selection state |

## Non-goals of this contract

- No new HTTP route, DTO, or revision domain — see
  `contracts/video-annotation-api.md` for the (unchanged) data contract.
- No new Prisma entity — see `data-model.md`.
- Does not authorize making AUDIO or TEXT editable; their toolbox/tab entries
  above are read-only-consistent placeholders.
