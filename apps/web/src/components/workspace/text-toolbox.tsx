"use client";

import { Cursor, Hand, HighlighterIcon, LinkIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { useTextAnnotationStore } from "@/stores/text-annotation-store";
import { UNAVAILABLE_TEXT_ENGINE_CAPABILITIES } from "@/lib/workspace/text-engine-capabilities";

/**
 * Text Engine toolbox (T062, redone 2026-09-23 per explicit user sign-off,
 * superseding the same-day 2026-09-21 revert recorded in tasks.md). Drives
 * `useTextAnnotationStore`'s own `tool` field -- the same store
 * `text-engine.tsx`'s mouseup/click handlers already read -- instead of the
 * unrelated IMAGE annotation store the previous version used. Only tools the
 * store/engine actually implement are offered (`TextReaderTool`): Select,
 * Scroll, Highlight Span, Relation. Span/Relation are additionally gated on
 * the server-derived capabilities carried by the current reader snapshot
 * (readiness + policy + permissions + workflow state), with the server's own
 * reason surfaced as the disabled button's tooltip -- never a bare disabled
 * control.
 */
export function TextToolbox() {
  const tool = useTextAnnotationStore((store) => store.tool);
  const setTool = useTextAnnotationStore((store) => store.setTool);
  const capabilities = useTextAnnotationStore((store) => store.reader?.workspace.capabilities ?? UNAVAILABLE_TEXT_ENGINE_CAPABILITIES);

  return (
    <div className="mt-3 grid grid-cols-2 gap-1.5">
      <ToolButton active={tool === "select"} label="Select" onClick={() => setTool("select")}><Cursor size={17} weight="bold" /></ToolButton>
      <ToolButton active={tool === "scroll"} label="Scroll" onClick={() => setTool("scroll")}><Hand size={17} /></ToolButton>
      <ToolButton active={tool === "highlightspan"} label="Highlight Span" disabled={!capabilities.span} title={capabilities.reasons.span ?? undefined} onClick={() => setTool("highlightspan")}><HighlighterIcon size={15} /></ToolButton>
      <ToolButton active={tool === "relation"} label="Relation" disabled={!capabilities.relation} title={capabilities.reasons.relation ?? undefined} onClick={() => setTool("relation")}><LinkIcon size={15} /></ToolButton>
    </div>
  );
}

function ToolButton({ active, label, onClick, children, disabled = false, title }: { active: boolean; label: string; onClick: () => void; children: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`group relative grid min-h-12 place-items-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${active ? "border-sky-500 bg-sky-50 text-sky-700" : "border-zinc-200 text-zinc-500 hover:bg-zinc-50"}`}
    >
      {children}
      <span aria-hidden="true" className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">{label}</span>
    </button>
  );
}
