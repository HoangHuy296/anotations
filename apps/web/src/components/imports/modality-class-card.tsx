"use client";

import { Image as ImageIcon, SpeakerHigh, TextAa, VideoCamera, X } from "@phosphor-icons/react";
import { useId, useState, type ComponentType, type KeyboardEvent } from "react";

import { addConfirmedClass, removeConfirmedClass, type ConfirmedClassDraft } from "@/lib/imports/confirmed-classes";
import {
  activeDescendant,
  buildClassOptions,
  initialComboboxState,
  isExpanded,
  nextComboboxState,
  optionId,
  type ClassOption,
  type ComboboxEvent,
  type ComboboxState,
} from "@/lib/imports/class-combobox-state";
import { creationModalities, maintainedRecommendedClasses, recommendedClassNames, type CreationModality, type RecommendedClassSource } from "@/lib/imports/recommended-classes";

const modalityMeta: Record<CreationModality, { label: string; hint: string; Icon: ComponentType<{ size?: number; weight?: "duotone"; "aria-hidden"?: boolean | "true" }> }> = {
  IMAGE: { label: "Image", hint: "Photos and frames", Icon: ImageIcon },
  VIDEO: { label: "Video", hint: "Clips and recordings", Icon: VideoCamera },
  AUDIO: { label: "Audio", hint: "Sound and speech", Icon: SpeakerHigh },
  TEXT: { label: "Text", hint: "Documents and transcripts", Icon: TextAa },
};

type ModalityCardProps = {
  /** "" until the user chooses; creation never infers a modality. */
  value: CreationModality | "";
  onChange: (modality: CreationModality) => void;
  disabled?: boolean;
  /** Append mode: the authorized parent Dataset's modality, shown as fixed and never editable. */
  fixed?: CreationModality;
};

/** Dataset modality choice. Radios submit `modality` natively; each card shows a visible label next to its icon. */
export function ModalityCard({ value, onChange, disabled, fixed }: ModalityCardProps) {
  if (fixed) {
    const { label, Icon } = modalityMeta[fixed];
    return <div data-modality-fixed={fixed} className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/60"><p className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Dataset modality</p><p className="mt-2 flex items-center gap-2 text-sm font-bold text-zinc-950 dark:text-zinc-50"><Icon aria-hidden size={18} weight="duotone" />{label}<span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Fixed for this Dataset</span></p></div>;
  }
  return <fieldset disabled={disabled}>
    <legend className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Dataset modality</legend>
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      {creationModalities.map((modality) => {
        const { label, hint, Icon } = modalityMeta[modality];
        return <label key={modality} className="flex cursor-pointer items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 has-[:checked]:border-zinc-950 has-[:checked]:ring-1 has-[:checked]:ring-zinc-950 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-sky-500 dark:border-zinc-700 dark:bg-zinc-800 dark:has-[:checked]:border-white dark:has-[:checked]:ring-white">
          <input type="radio" name="modality" value={modality} required checked={value === modality} onChange={() => onChange(modality)} className="sr-only" />
          <Icon aria-hidden size={22} weight="duotone" />
          <span><span className="block text-sm font-bold text-zinc-950 dark:text-zinc-50">{label}</span><span className="block text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">{hint}</span></span>
        </label>;
      })}
    </div>
    <p className="mt-2 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">The modality is fixed once the Dataset is created. The server checks every file&rsquo;s content against it.</p>
  </fieldset>;
}

type ClassEntryViewProps = {
  idPrefix: string;
  modality: CreationModality | "";
  source: RecommendedClassSource;
  classes: ConfirmedClassDraft;
  state: ComboboxState;
  options: readonly ClassOption[];
  error: string | null;
  disabled?: boolean;
  onEvent: (event: ComboboxEvent) => void;
  onSelect: (name: string) => void;
  onRemove: (name: string) => void;
};

/** Presentational, so every combobox state is renderable and testable. */
export function ClassEntryView({ idPrefix, modality, source, classes, state, options, error, disabled, onEvent, onSelect, onRemove }: ClassEntryViewProps) {
  const expanded = isExpanded(state, options);
  const listboxId = `${idPrefix}-listbox`;
  const inputId = `${idPrefix}-input`;
  const errorId = `${idPrefix}-error`;
  const statusText = error ? "" : state.open && state.query.trim() && options.length === 0 ? "No matching classes." : expanded ? `${options.length} option${options.length === 1 ? "" : "s"} available.` : "";
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === "Escape") {
      // Enter must never submit the surrounding form; Escape only closes the popup.
      event.preventDefault();
      onEvent({ type: event.key });
    }
  };
  return <div>
    <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Recommended classes</p>
    {source.status === "none"
      ? <p data-recommendations="none" className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">No recommended classes available{modality ? ` for ${modalityMeta[modality].label}` : ""}. Add classes manually below.</p>
      : <p data-recommendations="maintained" className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">Suggestions from {source.provenance} appear as you type.</p>}
    <ul aria-label="Confirmed classes" className="mt-3 flex flex-wrap gap-2">
      {classes.map((name) => <li key={name} className="flex items-center gap-1 rounded-full border border-zinc-300 bg-zinc-50 py-0.5 pl-3 pr-1 text-xs font-semibold text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
        <span>{name}</span>
        <button type="button" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => onRemove(name)} className="grid size-6 place-items-center rounded-full text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-sky-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-50"><X aria-hidden size={12} weight="bold" /></button>
      </li>)}
    </ul>
    <div className="relative mt-3">
      <label htmlFor={inputId} className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300">Add a class</label>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listboxId : undefined}
        aria-activedescendant={activeDescendant(idPrefix, state, options)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        autoComplete="off"
        disabled={disabled}
        value={state.query}
        onChange={(event) => onEvent({ type: "change", query: event.currentTarget.value })}
        onKeyDown={onKeyDown}
        onBlur={() => onEvent({ type: "blur" })}
        placeholder="Type a class name, then press Enter"
        className="mt-1 h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
      />
      {expanded && <ul id={listboxId} role="listbox" aria-label="Class suggestions" className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
        {options.map((option, index) => <li
          key={`${option.kind}:${option.name}`}
          id={optionId(idPrefix, index)}
          role="option"
          aria-selected={state.activeIndex === index}
          // Keep DOM focus in the input while choosing with the pointer.
          onMouseDown={(event) => { event.preventDefault(); onSelect(option.name); }}
          className={`cursor-pointer rounded-lg px-3 py-2 text-sm ${state.activeIndex === index ? "bg-sky-100 text-sky-950 dark:bg-sky-900 dark:text-sky-50" : "text-zinc-800 dark:text-zinc-200"}`}
        >{option.kind === "custom" ? `Add “${option.name}”` : option.name}</li>)}
      </ul>}
      {error && <p id={errorId} role="alert" className="mt-1 text-xs text-rose-700 dark:text-rose-400">{error}</p>}
      <p role="status" className="sr-only">{statusText}</p>
    </div>
  </div>;
}

type ClassEntryProps = {
  modality: CreationModality | "";
  classes: ConfirmedClassDraft;
  onChange: (classes: ConfirmedClassDraft) => void;
  disabled?: boolean;
  /** Defaults to the maintained-source boundary, which currently returns no recommendations. */
  source?: RecommendedClassSource;
};

/** Manual class entry with a maintained-recommendation hook. No autofocus on mount. */
export function ClassEntry({ modality, classes, onChange, disabled, source }: ClassEntryProps) {
  const idPrefix = useId().replace(/:/g, "");
  const resolved = source ?? maintainedRecommendedClasses(modality);
  const [state, setState] = useState<ComboboxState>(initialComboboxState);
  const [error, setError] = useState<string | null>(null);
  const options = buildClassOptions(state.query, recommendedClassNames(resolved), classes);

  function add(name: string) {
    const result = addConfirmedClass(classes, name);
    if (!result.ok) { setError(result.message); return; }
    setError(null);
    setState(initialComboboxState);
    onChange(result.classes);
  }
  function onEvent(event: ComboboxEvent) {
    if (event.type === "change") setError(null);
    const next = nextComboboxState(state, event, options);
    setState(next.state);
    if (next.action) add(next.action.name);
  }
  return <ClassEntryView idPrefix={idPrefix} modality={modality} source={resolved} classes={classes} state={state} options={options} error={error} disabled={disabled} onEvent={onEvent} onSelect={add} onRemove={(name) => onChange(removeConfirmedClass(classes, name))} />;
}
