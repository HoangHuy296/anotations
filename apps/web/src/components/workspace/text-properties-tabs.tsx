"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AssetStatus } from "@internal/db";
import type { MouseEvent, ReactNode } from "react";
import type { SafeTextAnnotation } from "@annotationplatform/domain/text-annotation-contract";

import { updateTextDescriptionAction } from "@/app/(app)/workspace/[datasetId]/actions";
import { AssetBrowserFilters } from "@/components/workspace/asset-browser-filters";
import { AssetNavigator, type AssetNavigatorFilters } from "@/components/workspace/asset-navigator";
import { BulkActionBar } from "@/components/workspace/bulk-action-bar";
import { AssetAssignmentPanel } from "@/components/workspace/asset-assignment-panel";
import { SaveConflictPanel } from "@/components/workspace/save-conflict-panel";
import { WorkflowHistoryPanel } from "@/components/workspace/workflow-history-panel";
import { TextAnnotationEditor } from "@/components/workspace/text-annotation-editor";
import { enableTextRelationLabel } from "@/lib/workspace/text-policy-client";
import { TextStatusFields } from "@/components/workspace/text-status-fields";
import { Badge } from "@/components/ui/badge";
import { imageStatusPresentation } from "@/lib/image-status";
import { workspaceEngineRegistry } from "@/lib/workspace/workspace-engine-registry";
import { submitTextAnnotationCommand } from "@/lib/annotations/text-annotation-client";
import { randomUUIDAuto } from "@/lib/browser-random-uuid";
import { useAnnotationStore } from "@/stores/image-annotation-store";
import { useDatasetLabels, useDatasetLabelsStore, type DatasetLabel } from "@/stores/dataset-labels-store";
import { useTextAnnotationStore } from "@/stores/text-annotation-store";
import type { SafeWorkspaceAsset } from "@/types/workspace";
import type { WorkspaceSelection } from "@/types/workspace";
import type { TextEligibilityField } from "@/lib/validation/label";
import type { TextClassificationGroup } from "@/lib/annotations/text-policy-service";

/** Mirrors `label-form.tsx`'s `TEXT_ELIGIBILITY_OPTIONS` exactly -- same values, same wording -- so the two label-creation surfaces present TEXT eligibility identically. */
const TEXT_ELIGIBILITY_CREATE_OPTIONS = [
  { value: "", label: "Not TEXT-eligible" },
  { value: "ENTITY", label: "Entity (span)" },
  { value: "CLASSIFICATION", label: "Classification" },
  { value: "SENTIMENT", label: "Sentiment" },
  { value: "INTENT", label: "Intent" },
  { value: "RELATION", label: "Relation" },
] as const satisfies readonly { value: TextEligibilityField; label: string }[];

type PanelTab = "description" | "labels" | "annotations" | "assets";

export type TextPropertiesTabsProps = {
  datasetId: string;
  selection: Extract<WorkspaceSelection, { engine: "TEXT" }>;
  assets: SafeWorkspaceAsset[];
  page: number;
  pageSize: number;
  totalAssets: number;
  completedAssets: number;
  search: string;
  statuses: AssetStatus[];
  selectedAssetId: string | null;
  filters: AssetNavigatorFilters;
  tab: string;
  setTab: (tab: string) => void;
};

/**
 * TEXT's `PropertiesPanel` tabs content, aligned with
 * `image-properties-tabs.tsx`/`video-properties-tabs.tsx`/
 * `audio-properties-tabs.tsx`'s exact tab set, order, and naming
 * (`description`/`labels`/<kind>/`assets`) rather than TEXT's own prior
 * `details`/`spans`/`labels`/`relations`/`assets` layout. Two deliberate
 * mappings from that prior layout:
 *
 * - "details" is gone as its own tab: the read-only `TextStatusFields`
 *   block (filename/encoding/length/language/processing) now lives inside
 *   the `description` tab, alongside the header's own filename/spans/
 *   relations summary -- the same place IMAGE/VIDEO/AUDIO keep
 *   `AssetAssignmentPanel`/`WorkflowHistoryPanel`, not a dedicated tab.
 * - "spans" and "relations" merge into one `annotations` tab (two
 *   sub-sections), matching every other engine's single content tab
 *   (`shapes`/`tracks`) rather than splitting by annotation kind.
 *
 * Description is now a real editable, autosaved field via
 * `updateTextDescriptionAction` (`text-mutations.ts`'s `updateTextDescription`,
 * mirroring `updateImageDescription`/`updateVideoDescription` exactly) --
 * previously read-only here because that action didn't exist yet. Autosave
 * scheduling reuses `useAnnotationStore`'s `scheduleAutosave`/
 * `setConflictDraft`, the same shared (despite its "image" name) registry
 * every other engine's description field already uses (see
 * `workspace-engine-flush.ts`'s `flushGenericAutosaves` doc comment) --
 * not a second, TEXT-only autosave mechanism.
 *
 * Spans/Relations are live, not just a read-only list: creation happens in
 * `text-engine.tsx` (Highlight Span / Relation tools), deletion lives here
 * via the same `submitTextAnnotationCommand` client (`deleteAnnotation` is
 * generic across every TEXT annotation kind server-side, so one delete
 * button serves both). Clicking a span row also calls
 * `useTextAnnotationStore().setSelection`, the same field the reader's own
 * text-drag selection uses, so `text-engine.tsx`'s existing
 * "Selected [start, end)" footer shows the chosen span with no reader
 * changes needed.
 *
 * Labels is a minimal create/list/delete taxonomy editor scoped to TEXT
 * eligibility (`Label.scope`/`modality`, `text-policy-service.ts`) -- the
 * same `POST /api/datasets/{datasetId}/labels` endpoint IMAGE/VIDEO/AUDIO's
 * own Labels tabs already use, just with `textEligibility` set. Configuring
 * which relation types connect which entity labels
 * (`Dataset.textPolicy.relationTypes`) is a separate, dataset-level policy
 * write (`text-policy-write-service.ts`) with no UI yet -- out of scope
 * here; this tab only creates the labels a policy could later reference.
 */
export function TextPropertiesTabs({ datasetId, selection, assets, page, pageSize, totalAssets, completedAssets, search, statuses, selectedAssetId, filters, tab, setTab }: TextPropertiesTabsProps) {
  const asset = selection.asset;
  const readOnly = asset.status === "NEEDS_REVIEW" || asset.status === "REVIEWED" || asset.status === "REJECTED";
  const router = useRouter();
  const taxonomy = useDatasetLabels(datasetId);
  const setSelectionRange = useTextAnnotationStore((store) => store.setSelection);
  const activeRange = useTextAnnotationStore((store) => store.selection);
  const policy = useTextAnnotationStore((store) => store.policy);
  const selectedAnnotationId = useTextAnnotationStore((store) => store.selectedAnnotationId);
  const selectAnnotation = useTextAnnotationStore((store) => store.selectAnnotation);
  const sourceText = useTextAnnotationStore((store) => store.reader?.workspace.asset.id === asset.id ? store.reader.sourceText ?? "" : "");
  const activeEntityLabelId = useTextAnnotationStore((store) => store.activeEntityLabelId);
  const activeRelationLabelId = useTextAnnotationStore((store) => store.activeRelationLabelId);
  const setActiveEntityLabelId = useTextAnnotationStore((store) => store.setActiveEntityLabelId);
  const setActiveRelationLabelId = useTextAnnotationStore((store) => store.setActiveRelationLabelId);
  useEffect(() => { if (selectedAnnotationId) setTab("annotations"); }, [selectedAnnotationId, setTab]);

  const annotations = useTextAnnotationStore((store) => store.assetId === asset.id ? store.snapshot?.savedAnnotations : undefined) ?? selection.annotations;
  const removeAnnotationLocal = useTextAnnotationStore((store) => store.removeAnnotationLocal);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [classificationSavingGroupId, setClassificationSavingGroupId] = useState<string | null>(null);
  const [classificationError, setClassificationError] = useState<string | null>(null);
  const upsertAnnotation = useTextAnnotationStore((store) => store.upsertAnnotation);
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#0EA5E9");
  const [newLabelEligibility, setNewLabelEligibility] = useState<TextEligibilityField>("ENTITY");
  const [labelError, setLabelError] = useState<string | null>(null);
  const [description, setDescription] = useState(asset.description ?? "");
  const [serverDescription, setServerDescription] = useState(asset.description ?? "");
  const [version, setVersion] = useState(asset.revision);
  const [descriptionState, setDescriptionState] = useState<"idle" | "pending" | "saving" | "saved" | "failed" | "conflict">("idle");
  const [conflictDraft, setConflictDraft] = useState<string | null>(null);
  const lastAttemptedDescriptionRef = useRef<string | null>(null);
  const scheduleAutosave = useAnnotationStore((store) => store.scheduleAutosave);
  const setConflictDraftInStore = useAnnotationStore((store) => store.setConflictDraft);

  // `useDatasetLabelsStore` is a module-level singleton -- once loaded for
  // `datasetId`, this resolves immediately with no network call on every
  // later mount (every asset switch remounts this component via
  // `PropertiesPanel`'s `key`, and switching back from IMAGE/VIDEO does too).
  useEffect(() => { void useDatasetLabelsStore.getState().ensureLoaded(datasetId); }, [datasetId]);

  useEffect(() => {
    if (readOnly) return;
    if (description === serverDescription || lastAttemptedDescriptionRef.current === description) return;
    const resourceKey = `text-description:${asset.id}`;
    setDescriptionState("pending");
    scheduleAutosave(resourceKey, async () => {
      lastAttemptedDescriptionRef.current = description;
      setDescriptionState("saving");
      const result = await updateTextDescriptionAction({ datasetId, assetId: asset.id, version, description: description.trim() || null });
      if (result.ok) {
        setVersion(result.asset.version);
        setServerDescription(result.asset.description ?? "");
        setDescriptionState("saved");
        return "saved";
      }
      if (result.error === "CONFLICT") {
        setConflictDraft(description);
        setConflictDraftInStore(resourceKey, description);
        setDescriptionState("conflict");
        return "conflict";
      }
      setDescriptionState("failed");
      return "failed";
    });
  }, [asset.id, datasetId, description, readOnly, scheduleAutosave, serverDescription, setConflictDraftInStore, version]);

  async function flushBeforeNavigation() {
    const flushed = await workspaceEngineRegistry.TEXT.flush(datasetId, asset.id);
    return flushed.ok || window.confirm("An edit could not be saved or has a conflict. Discard the local draft and leave this document?");
  }

  async function guardNavigation(event: MouseEvent<HTMLAnchorElement>, href: string) {
    event.preventDefault();
    if (!(await flushBeforeNavigation())) return;
    router.push(href);
  }

  function labelFor(labelId: string | null): DatasetLabel | null {
    return labelId ? (taxonomy.find((item) => item.id === labelId) ?? null) : null;
  }

  function selectSpan(annotation: SafeTextAnnotation) {
    if (annotation.geometry.kind !== "text-span") return;
    selectAnnotation(annotation.id);
    setSelectionRange({ startOffset: annotation.geometry.startOffset, endOffset: annotation.geometry.endOffset });
  }

  async function deleteAnnotation(annotation: SafeTextAnnotation) {
    if (readOnly || !policy || !selection.source || selection.source.readiness !== "READY") return;
    setDeleteError(null);
    setDeletingId(annotation.id);
    const outcome = await submitTextAnnotationCommand(asset.id, {
      operationId: randomUUIDAuto(),
      sourceIdentity: selection.source.sourceIdentity,
      expectedPolicyRevision: policy.revision,
      command: { kind: "deleteAnnotation", annotationId: annotation.id, expectedRevision: annotation.revision },
    });
    if (useTextAnnotationStore.getState().assetId !== asset.id) return;
    setDeletingId(null);
    if (outcome.ok) removeAnnotationLocal(annotation.id);
    else setDeleteError(outcome.reason ?? outcome.code ?? "This annotation could not be deleted.");
  }

  /**
   * T111: toggles one label's membership in a classification group.
   * `replaceClassification` (T105/T106) always takes the *complete* desired
   * membership plus the caller's belief of the *complete* current
   * membership -- so a SINGLE group toggling a different option replaces
   * the whole (0-or-1-member) set, and a MULTI group toggling one option
   * only adds/removes that one label from the current set, leaving every
   * other selected label alone.
   */
  async function toggleClassificationMember(group: TextClassificationGroup, labelId: string) {
    if (readOnly || !policy || !selection.source || selection.source.readiness !== "READY" || classificationSavingGroupId) return;
    const currentMembers = annotations.filter((item) => item.geometry.kind === "text-document" && group.memberLabelIds.includes(item.labelId ?? ""));
    const currentLabelIds = currentMembers.map((item) => item.labelId!);
    const isSelected = currentLabelIds.includes(labelId);
    const nextLabelIds = group.cardinality === "SINGLE"
      ? (isSelected ? [] : [labelId])
      : (isSelected ? currentLabelIds.filter((id) => id !== labelId) : [...currentLabelIds, labelId]);
    setClassificationSavingGroupId(group.id);
    setClassificationError(null);
    const outcome = await submitTextAnnotationCommand<SafeTextAnnotation[]>(asset.id, {
      operationId: randomUUIDAuto(), sourceIdentity: selection.source.sourceIdentity, expectedPolicyRevision: policy.revision,
      command: { kind: "replaceClassification", groupId: group.id, memberLabelIds: nextLabelIds, expectedMembers: currentMembers.map((item) => ({ id: item.id, revision: item.revision })) },
    });
    if (useTextAnnotationStore.getState().assetId !== asset.id) return;
    setClassificationSavingGroupId(null);
    if (outcome.ok) {
      const keptOrCreatedIds = new Set(outcome.result.map((row) => row.id));
      for (const removed of currentMembers) { if (!keptOrCreatedIds.has(removed.id)) removeAnnotationLocal(removed.id); }
      for (const row of outcome.result) upsertAnnotation(row);
    } else {
      setClassificationError(outcome.reason ?? outcome.code ?? "The classification could not be saved.");
    }
  }

  async function createLabel() {
    if (readOnly) return;
    const name = newLabelName.trim();
    if (!name) return;
    const color = /^#[0-9A-Fa-f]{6}$/.test(newLabelColor) ? newLabelColor : "#0EA5E9";
    setLabelError(null);
    const response = await fetch(`/api/datasets/${datasetId}/labels`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      // The select always expresses the full desired end state -- "Not
      // TEXT-eligible" is the explicit "NONE" clear, same as label-form.tsx's
      // submit -- never a silent no-op.
      body: JSON.stringify({ name, color, description: "", hotkey: "", textEligibility: newLabelEligibility || "NONE" }),
    });
    const payload = await response.json().catch(() => null) as { data?: DatasetLabel; error?: { message?: string } } | null;
    if (!response.ok || !payload?.data) {
      setLabelError(payload?.error?.message ?? "The label could not be created.");
      return;
    }
    useDatasetLabelsStore.getState().addLabel(datasetId, payload.data);
    setNewLabelName("");
    setNewLabelColor("#0EA5E9");
  }

  async function deleteLabel(labelId: string) {
    if (readOnly) return;
    setLabelError(null);
    const response = await fetch(`/api/labels/${labelId}`, { method: "DELETE", credentials: "same-origin" });
    if (response.status === 204) {
      useDatasetLabelsStore.getState().removeLabel(datasetId, labelId);
      return;
    }
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    setLabelError(payload?.error?.message ?? "The label could not be deleted.");
  }

  async function enableRelation(labelId: string) {
    if (readOnly) return;
    const next = await enableTextRelationLabel(datasetId, labelId).catch(() => null);
    if (!next) { setLabelError("Could not enable this relation label. Dataset label-management permission is required; reload if the policy changed."); return; }
    if (useTextAnnotationStore.getState().assetId !== asset.id) return;
    useTextAnnotationStore.getState().setPolicy(next);
    setActiveRelationLabelId(labelId);
    router.refresh();
  }

  const activeTab = (["description", "labels", "annotations", "assets"] as const).includes(tab as PanelTab) ? (tab as PanelTab) : "description";
  const presentation = imageStatusPresentation[asset.status];
  const selectedAnnotation = annotations.find((annotation) => annotation.id === selectedAnnotationId);
  const spans = annotations.filter((item) => item.geometry.kind === "text-span");
  const relations = annotations.filter((item) => item.geometry.kind === "text-relation");
  const classifications = annotations.filter((item) => item.geometry.kind === "text-document");
  const capabilityNotices = (
    [
      ["span", selection.capabilities.span, selection.capabilities.reasons.span] as const,
      ["relation", selection.capabilities.relation, selection.capabilities.reasons.relation] as const,
    ]
  ).filter(([, ok]) => !ok);

  return <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-zinc-200 bg-white">
    <div className="shrink-0 border-b border-zinc-200 p-4">
      <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-bold text-zinc-950">Text details</h2><Badge variant={presentation.variant}>{presentation.label}</Badge></div>
      <p className="mt-3 break-all text-xs font-semibold text-zinc-800">{asset.filename}</p>
      <dl className="mt-4 space-y-2 text-xs"><Detail label="Spans" value={String(spans.length)} /><Detail label="Relations" value={String(relations.length)} /><Detail label="Classifications" value={String(classifications.length)} /></dl>
    </div>
    <nav aria-label="Text management" className="flex shrink-0 border-b border-zinc-200">
      {(["description", "labels", "annotations", "assets"] as const).map((entry) => <button key={entry} type="button" aria-current={activeTab === entry ? "page" : undefined} onClick={() => setTab(entry)} className={`min-w-0 flex-auto whitespace-nowrap border-b-2 px-2 py-3 text-xs font-semibold capitalize focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-600 ${activeTab === entry ? "border-sky-600 text-sky-700" : "border-transparent text-zinc-500"}`}>{entry}</button>)}
    </nav>
    <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto [overflow-wrap:anywhere]">
    {activeTab === "description" && <section className="p-4">
      <div className="flex items-center justify-between"><h2 className="text-sm font-bold text-zinc-950">Description</h2><span className="text-[11px] text-zinc-400">{descriptionState === "pending" ? "Saving after inactivity…" : descriptionState === "saving" ? "Saving…" : descriptionState === "saved" ? "Saved" : descriptionState === "failed" ? "Save failed" : ""}</span></div>
      <textarea readOnly={readOnly} value={description} onChange={(event) => { if (!readOnly) { lastAttemptedDescriptionRef.current = null; setDescription(event.target.value); } }} maxLength={10_000} rows={5} className="mt-3 w-full resize-y rounded-xl border border-zinc-200 p-3 text-sm text-zinc-900 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" placeholder="Context, notes, or quality flags" />
      {descriptionState === "conflict" && <div className="mt-3"><SaveConflictPanel message="Your description draft is still visible and was not sent again." onReload={() => window.location.reload()} onDiscard={() => { setDescription(serverDescription); setConflictDraft(null); setDescriptionState("idle"); }} /></div>}
      {descriptionState === "failed" && <p role="alert" className="mt-3 text-xs text-rose-700">Description was not saved. Edit it again to retry.</p>}
      {conflictDraft && <p className="sr-only">Local draft preserved.</p>}
      <section className="mt-5 border-t border-zinc-100 pt-4"><h3 className="text-sm font-semibold">Text details</h3><div className="mt-2"><TextStatusFields selection={selection} details /></div></section>
      <AssetAssignmentPanel datasetId={datasetId} assetId={asset.id} />
      <WorkflowHistoryPanel datasetId={datasetId} assetId={asset.id} />
    </section>}
    {activeTab === "labels" && <section className="p-4">
      <h2 className="text-sm font-bold text-zinc-950">Labels</h2>
      <p className="mt-1 text-[11px] leading-4 text-zinc-500">Choose the active label here before using Entity or Relation. Enabling a relation allows it between the current entity labels, including unlabeled entities.</p>
      <fieldset disabled={readOnly} className="mt-3 min-w-0 space-y-2 disabled:opacity-50">
        <div className="flex min-w-0 gap-2">
          <input aria-label="New label name" value={newLabelName} onChange={(event) => setNewLabelName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createLabel(); } }} className="min-w-0 flex-1 rounded-lg border border-zinc-200 px-2 py-2 text-xs" placeholder="Custom label" />
          <input aria-label="Label color" type="color" value={newLabelColor} onChange={(event) => setNewLabelColor(event.target.value)} className="h-8.5 w-9 shrink-0 cursor-pointer rounded-lg border border-zinc-200 p-0.5" title="Choose label color" />
          <input aria-label="Label color code" value={newLabelColor} onChange={(event) => setNewLabelColor(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void createLabel(); } }} className="w-20 shrink-0 rounded-lg border border-zinc-200 px-2 py-2 font-mono text-xs uppercase" placeholder="#0EA5E9" maxLength={7} />
          <button type="button" onClick={() => void createLabel()} className="shrink-0 rounded-lg bg-zinc-900 px-3 text-xs font-semibold text-white">Add</button>
        </div>
        <div className="flex gap-2">
          <select aria-label="Label TEXT eligibility" value={newLabelEligibility} onChange={(event) => setNewLabelEligibility(event.target.value as TextEligibilityField)} className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-2 py-2 text-xs">
            {TEXT_ELIGIBILITY_CREATE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </fieldset>
      <div className="mt-3 space-y-2">{taxonomy.length === 0 ? <p className="text-[11px] text-zinc-400">No labels yet.</p> : taxonomy.map((label) => <div key={label.id} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2 py-2">
        <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
        <button type="button" disabled={readOnly || !(policy?.entityLabelIds.includes(label.id) || policy?.relationTypes.some((type) => type.relationLabelId === label.id))} aria-pressed={activeEntityLabelId === label.id || activeRelationLabelId === label.id} onClick={() => { if (policy?.entityLabelIds.includes(label.id)) setActiveEntityLabelId(label.id); else setActiveRelationLabelId(label.id); }} className="min-w-0 flex-1 truncate text-left text-xs font-medium text-zinc-800 aria-pressed:font-bold aria-pressed:text-sky-700 disabled:opacity-50">{label.name}{activeEntityLabelId === label.id || activeRelationLabelId === label.id ? " · Active" : ""}</button>
        {label.scope === "RELATION" && !policy?.relationTypes.some((type) => type.relationLabelId === label.id) && <button type="button" disabled={readOnly} onClick={() => void enableRelation(label.id)} className="text-[11px] text-sky-700 disabled:opacity-50">Enable relation</button>}
        <button type="button" disabled={readOnly} onClick={() => void deleteLabel(label.id)} className="shrink-0 text-[11px] font-semibold text-rose-700">Remove</button>
      </div>)}</div>
      {labelError && <p role="alert" className="mt-3 text-xs text-rose-700">{labelError}</p>}
    </section>}
    {activeTab === "annotations" && <section className="p-4">
      {selectedAnnotation && <TextAnnotationEditor key={`${selectedAnnotation.id}:${selectedAnnotation.revision}`} annotation={selectedAnnotation} annotations={annotations} labels={taxonomy} policy={policy} sourceText={sourceText} readOnly={readOnly} />}
      <div className="flex items-center justify-between"><h2 className="text-sm font-bold text-zinc-950">Spans</h2><span className="text-xs text-zinc-400">{spans.length}</span></div>
      {capabilityNotices.filter(([kind]) => kind === "span").map(([kind, , reason]) => <p key={kind} className="mt-1 text-[11px] leading-4 text-amber-700">{reason}</p>)}
      <div className="mt-3 space-y-1.5">{spans.length === 0 ? <p className="text-[11px] text-zinc-400">No spans yet. Use the Highlight Span tool to create one.</p> : spans.map((item) => {
        const active = activeRange !== null && item.geometry.kind === "text-span" && activeRange.startOffset === item.geometry.startOffset && activeRange.endOffset === item.geometry.endOffset;
        return <AnnotationRow key={item.id} label={labelFor(item.labelId)} detail={item.geometry.kind === "text-span" ? `[${item.geometry.startOffset}, ${item.geometry.endOffset})` : ""} active={active} onSelect={() => selectSpan(item)} onDelete={() => void deleteAnnotation(item)} readOnly={readOnly} deleting={deletingId === item.id} />;
      })}</div>

      <div className="mt-6 flex items-center justify-between border-t border-zinc-100 pt-4"><h2 className="text-sm font-bold text-zinc-950">Relations</h2><span className="text-xs text-zinc-400">{relations.length}</span></div>
      {capabilityNotices.filter(([kind]) => kind === "relation").map(([kind, , reason]) => <p key={kind} className="mt-1 text-[11px] leading-4 text-amber-700">{reason}</p>)}
      <div className="mt-3 space-y-1.5">{relations.length === 0 ? <p className="text-[11px] text-zinc-400">No relations yet. Use the Relation tool to link two entities.</p> : relations.map((item) => <AnnotationRow key={item.id} label={labelFor(item.labelId)} detail={item.fromAnnotationId && item.toAnnotationId ? `${item.fromAnnotationId.slice(-6)} → ${item.toAnnotationId.slice(-6)}` : item.status} active={selectedAnnotationId === item.id} onSelect={() => selectAnnotation(item.id)} onDelete={() => void deleteAnnotation(item)} readOnly={readOnly} deleting={deletingId === item.id} />)}</div>
      {deleteError && <p role="alert" className="mt-3 text-xs text-rose-700">{deleteError}</p>}

      <div className="mt-6 border-t border-zinc-100 pt-4"><h2 className="text-sm font-bold text-zinc-950">Classification</h2></div>
      {policy && policy.classificationGroups.length === 0 && <p className="mt-1 text-[11px] leading-4 text-amber-700">No classification taxonomy is configured for this dataset.</p>}
      {policy?.classificationGroups.map((group) => {
        const members = annotations.filter((item) => item.geometry.kind === "text-document" && group.memberLabelIds.includes(item.labelId ?? ""));
        const memberLabelIds = new Set(members.map((item) => item.labelId));
        return <div key={group.id} className="mt-3">
          <p className="text-[11px] font-semibold text-zinc-600">{group.name} · {group.cardinality === "SINGLE" ? "choose one" : "choose any"}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {group.memberLabelIds.map((labelId) => {
              const label = labelFor(labelId);
              const selected = memberLabelIds.has(labelId);
              return <button key={labelId} type="button" disabled={readOnly || classificationSavingGroupId === group.id} aria-pressed={selected} onClick={() => void toggleClassificationMember(group, labelId)} className={`rounded-full border px-2.5 py-1 text-[11px] font-medium disabled:opacity-50 ${selected ? "border-sky-500 bg-sky-50 text-sky-700" : "border-zinc-200 text-zinc-600"}`}>{label?.name ?? labelId}</button>;
            })}
          </div>
        </div>;
      })}
      {classificationError && <p role="alert" className="mt-3 text-xs text-rose-700">{classificationError}</p>}
    </section>}
    {activeTab === "assets" && <section className="p-4">
      <div className="flex items-center justify-between"><h2 className="text-sm font-bold text-zinc-950">Assets</h2><span className="text-xs text-zinc-400">Page {page}</span></div>
      <p className="mt-1 text-xs text-zinc-500">This workspace page is limited to {pageSize} assets.</p>
      <AssetBrowserFilters datasetId={datasetId} search={search} statuses={statuses} filterModality={filters.filterModality} beforeNavigate={flushBeforeNavigation} />
      <div className="mt-3" aria-label="Dataset progress"><div className="flex justify-between text-[11px] text-zinc-500"><span>Dataset progress</span><span>{completedAssets} / {totalAssets}</span></div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${totalAssets ? Math.round((completedAssets / totalAssets) * 100) : 0}%` }} /></div></div>
      <AssetNavigator datasetId={datasetId} assets={assets} page={page} pageSize={pageSize} totalAssets={totalAssets} search={search} statuses={statuses} selectedAssetId={selectedAssetId} filters={filters} onNavigate={guardNavigation} />
      <BulkActionBar datasetId={datasetId} labels={taxonomy} />
    </section>}
    </div>
  </aside>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-zinc-400">{label}</dt><dd className="max-w-[150px] truncate font-mono text-zinc-700">{value}</dd></div>;
}

function AnnotationRow({ label, detail, active = false, onSelect, onDelete, deleting = false, readOnly = false }: { label: DatasetLabel | null; detail: string; active?: boolean; onSelect?: () => void; onDelete: () => void; deleting?: boolean; readOnly?: boolean }) {
  const content: ReactNode = <>
    <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: label?.color ?? "#d4d4d8" }} />
    <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-800">{label?.name ?? "No label"}</span>
    <span className="shrink-0 font-mono text-[11px] text-zinc-400">{detail}</span>
  </>;
  return <div className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${active ? "border-sky-300 bg-sky-50" : "border-zinc-200"}`}>
    {onSelect ? <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">{content}</button> : <div className="flex min-w-0 flex-1 items-center gap-2">{content}</div>}
    <button type="button" disabled={deleting || readOnly} onClick={onDelete} className="shrink-0 text-[11px] font-semibold text-rose-700 disabled:opacity-50">{deleting ? "…" : "Delete"}</button>
  </div>;
}
