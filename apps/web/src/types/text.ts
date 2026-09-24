import type { SafeTextAnnotation } from "@annotationplatform/domain/text-annotation-contract";
import type { WorkspaceSelection } from "@/types/workspace";

/**
 * UI-only TEXT types. These build on the shared T005 canonical shapes
 * (`SafeTextAnnotation`) rather than redefining them — this file holds only
 * client selection/search/pending-command state that has no server-side
 * counterpart.
 */

export type TextSelectionRange = { startOffset: number; endOffset: number };

export type TextSearchMatch = { startOffset: number; endOffset: number };

export type TextSearchState = {
  query: string;
  matches: TextSearchMatch[];
  activeMatchIndex: number | null;
};

export type TextPendingCommandStatus = "pending" | "saving" | "saved" | "failed" | "conflict";

/** A local semantic command not yet confirmed by the server. `kind` values are defined by the stories that introduce each command (US2/US3/US4). */
export type TextPendingCommand = {
  operationId: string;
  kind: string;
  submittedAt: number;
  status: TextPendingCommandStatus;
};

/**
 * The TEXT reader's own interaction mode -- "select" reads/selects text (the
 * default); "scroll" disables text selection so a drag pans/reads without
 * accidentally selecting; "highlightspan" turns a text selection into a
 * `createSpan` command on mouse-up (`text-engine.tsx`); "relation" turns two
 * consecutive clicks on existing spans into a `createRelation` command
 * (`useTextAnnotationStore`'s `pendingRelationFromId` tracks the first
 * click).
 */
export type TextReaderTool = "select" | "scroll" | "highlightspan" | "relation";

/**
 * A point-in-time snapshot of the reader's own load state, published by
 * `TextEngine` so other UI (status fields, toolbox) can reflect it without
 * re-deriving it themselves. Flat, not a discriminated union: `sourceLength`
 * and `readiness` are always present (`null`/best-effort outside "ready")
 * so a consumer never has to narrow on `status` before reading them.
 */
export type TextReaderSnapshot = {
  workspace: Extract<WorkspaceSelection, { engine: "TEXT" }>;
  status: "loading" | "denied" | "unready" | "ready";
  sourceLength: number | null;
  /** Reader text used only to derive display excerpts from canonical offsets. */
  sourceText?: string;
  readiness: string;
};

/** The asset-scoped saved state a fresh selection initializes the store with. */
export type TextAssetSnapshot = {
  assetId: string;
  datasetId: string;
  sourceIdentity: string;
  /** The verified grapheme-boundary offsets supplied by the server (T028) — the browser never recomputes these. */
  boundaryOffsets: readonly number[];
  savedAnnotations: SafeTextAnnotation[];
  assetRevision: number;
};
