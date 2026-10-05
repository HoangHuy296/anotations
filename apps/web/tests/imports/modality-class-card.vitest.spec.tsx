import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ImportForm } from "@/components/imports/import-form";
import { LocalFolderImportForm } from "@/components/imports/local-folder-import-form";
import { ClassEntry, ClassEntryView, ModalityCard } from "@/components/imports/modality-class-card";
import { buildClassOptions, type ComboboxState } from "@/lib/imports/class-combobox-state";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, back: () => undefined, prefetch: () => undefined }) }));

const noop = () => undefined;
const inputs = (html: string) => [...html.matchAll(/<input[^>]*>/g)].map(match => match[0]);
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}(?:="([^"]*)")?(?=[\\s/>])`))?.[1] ?? (new RegExp(`\\s${name}(?=[\\s/>])`).test(tag) ? "" : null);
const view = (state: ComboboxState, classes: readonly string[] = [], recommended: readonly string[] = [], error: string | null = null, source: Parameters<typeof ClassEntryView>[0]["source"] = { status: "none" }) =>
  renderToStaticMarkup(<ClassEntryView idPrefix="t" modality="IMAGE" source={source} classes={classes} state={state} options={buildClassOptions(state.query, recommended, classes)} error={error} onEvent={noop} onSelect={noop} onRemove={noop} />);

describe("ModalityCard", () => {
  it("renders four required radios named modality with visible labels and aria-hidden icons, none preselected", () => {
    const html = renderToStaticMarkup(<ModalityCard value="" onChange={noop} />);
    expect(html).toContain("<legend");
    const radios = inputs(html);
    expect(radios.map(tag => attr(tag, "value"))).toEqual(["IMAGE", "VIDEO", "AUDIO", "TEXT"]);
    for (const tag of radios) { expect(attr(tag, "type")).toBe("radio"); expect(attr(tag, "name")).toBe("modality"); expect(attr(tag, "required")).not.toBeNull(); expect(attr(tag, "checked")).toBeNull(); }
    for (const label of ["Image", "Video", "Audio", "Text"]) expect(html).toContain(`>${label}<`);
    expect(html.match(/aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain("<select");
  });
  it("marks only the chosen modality as checked", () => {
    const html = renderToStaticMarkup(<ModalityCard value="VIDEO" onChange={noop} />);
    const checked = inputs(html).filter(tag => attr(tag, "checked") !== null);
    expect(checked.map(tag => attr(tag, "value"))).toEqual(["VIDEO"]);
  });
  it("shows the parent modality as fixed and read-only in append mode, with no radios", () => {
    const html = renderToStaticMarkup(<ModalityCard value="AUDIO" fixed="AUDIO" onChange={noop} />);
    expect(html).toContain('data-modality-fixed="AUDIO"');
    expect(html).toContain("Fixed for this Dataset");
    expect(html).not.toContain('type="radio"');
  });
  it("disables the whole group while busy", () => {
    expect(renderToStaticMarkup(<ModalityCard value="" disabled onChange={noop} />)).toMatch(/<fieldset[^>]*disabled/);
  });
});

describe("ClassEntry combobox ARIA", () => {
  it("collapsed: labeled combobox, aria-expanded=false, no controls/activedescendant/autofocus, no listbox", () => {
    const html = view({ query: "", open: false, activeIndex: -1 });
    expect(html).toContain('<label for="t-input"');
    expect(html).toMatch(/<input[^>]*id="t-input"/);
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("aria-controls");
    expect(html).not.toContain("aria-activedescendant");
    expect(html).not.toContain("autofocus");
    expect(html).not.toContain('role="listbox"');
  });
  it("expanded: aria-controls matches the listbox id, options have ids/roles/aria-selected, focus stays in the input via aria-activedescendant", () => {
    const html = view({ query: "tr", open: true, activeIndex: 0 });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="t-listbox"');
    expect(html).toContain('<ul id="t-listbox" role="listbox"');
    expect(html).toContain('id="t-option-0" role="option" aria-selected="true"');
    expect(html).toContain('aria-activedescendant="t-option-0"');
    expect(html).toContain("Add “tr”");
  });
  it("expanded without an active option has no activedescendant and aria-selected=false", () => {
    const html = view({ query: "tr", open: true, activeIndex: -1 });
    expect(html).not.toContain("aria-activedescendant");
    expect(html).toContain('aria-selected="false"');
  });
  it("open with no options (duplicate text) stays collapsed and announces no matches via a status region, never an empty listbox", () => {
    const html = view({ query: "car", open: true, activeIndex: -1 }, ["car"]);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="listbox"');
    expect(html).toContain('<p role="status" class="sr-only">No matching classes.</p>');
  });
  it("validation errors are announced with role=alert and linked by aria-describedby; the combobox is aria-invalid", () => {
    const html = view({ query: "a", open: false, activeIndex: -1 }, [], [], "Name must contain at least 2 characters.");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="t-error"');
    expect(html).toContain('<p id="t-error" role="alert"');
  });
});

describe("ClassEntry badges, removal and empty recommendations", () => {
  it("shows the honest empty recommendation state and no suggested badges when no maintained source exists", () => {
    const html = view({ query: "", open: false, activeIndex: -1 });
    expect(html).toContain('data-recommendations="none"');
    expect(html).toContain("No recommended classes available for Image. Add classes manually below.");
    expect(html).not.toContain("<li");
  });
  it("renders confirmed classes as non-interactive labels with separate icon-only buttons named Remove <class>", () => {
    const html = view({ query: "", open: false, activeIndex: -1 }, ["Car", "Bus"]);
    expect(html).toContain('<ul aria-label="Confirmed classes"');
    expect(html).toContain("<span>Car</span>");
    expect(html).toContain('aria-label="Remove Car"');
    expect(html).toContain('aria-label="Remove Bus"');
    // The badge text is not a button and the button has no text content, only an aria-hidden icon.
    expect(html).not.toMatch(/<button[^>]*>[^<]*[A-Za-z][^<]*<\/button>/);
    expect(html).toMatch(/<button type="button" aria-label="Remove Car"[^>]*><svg[^>]*aria-hidden="true"/);
  });
  it("a maintained source states its provenance and feeds options without changing the confirmed list shape", () => {
    const source = { status: "maintained", provenance: "approved-defaults-v1", classes: ["car", "cat"] } as const;
    const html = view({ query: "ca", open: true, activeIndex: 0 }, [], ["car", "cat"], null, source);
    expect(html).toContain("Suggestions from approved-defaults-v1");
    expect(html).toContain(">car</li>");
    expect(html).toContain(">cat</li>");
  });
  it("the stateful ClassEntry renders closed with no active popup on first render", () => {
    const html = renderToStaticMarkup(<ClassEntry modality="TEXT" classes={[]} onChange={noop} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("No recommended classes available for Text.");
    expect(html).not.toContain("autofocus");
  });
});

describe("form integration (STRUCTURE only: static markup and wiring; interactive behavior is verified on the pure model in creation-form-model.vitest.spec.ts)", () => {
  const read = (file: string) => readFileSync(path.resolve(process.cwd(), "src/components/imports", file), "utf8");
  const classEntryMarkers = (html: string) => ({ combobox: /role="combobox"/.test(html), addLabel: html.includes(">Add a class<"), confirmedList: html.includes('aria-label="Confirmed classes"') });

  it("ClassEntry is mounted in the repository creation form, next to the intact modality card (four radios named modality, no select)", () => {
    const html = renderToStaticMarkup(<ImportForm connections={[]} />);
    expect(classEntryMarkers(html)).toEqual({ combobox: true, addLabel: true, confirmedList: true });
    const radios = inputs(html).filter(tag => attr(tag, "name") === "modality");
    expect(radios.map(tag => attr(tag, "value"))).toEqual(["IMAGE", "VIDEO", "AUDIO", "TEXT"]);
    expect(radios.every(tag => attr(tag, "checked") === null)).toBe(true);
    expect(html).not.toContain('<select name="modality"');
  });
  it("ClassEntry is mounted in the local-folder creation form (new Dataset), next to the intact modality card", () => {
    const html = renderToStaticMarkup(<LocalFolderImportForm />);
    expect(classEntryMarkers(html)).toEqual({ combobox: true, addLabel: true, confirmedList: true });
    expect(inputs(html).filter(tag => attr(tag, "name") === "modality").map(tag => attr(tag, "value"))).toEqual(["IMAGE", "VIDEO", "AUDIO", "TEXT"]);
  });
  it("append mode renders no ClassEntry and shows the parent's modality as fixed and read-only (no radios)", () => {
    const html = renderToStaticMarkup(<LocalFolderImportForm datasetId="d1" datasetName="Existing" datasetModality="VIDEO" />);
    expect(classEntryMarkers(html)).toEqual({ combobox: false, addLabel: false, confirmedList: false });
    expect(html).toContain('data-modality-fixed="VIDEO"');
    expect(inputs(html).filter(tag => attr(tag, "name") === "modality")).toEqual([]); // no radios: the parent's modality is read-only
  });
  it("both forms still use the modality card instead of a select, and the repository payload still reads the native modality field", () => {
    const repo = read("import-form.tsx"), local = read("local-folder-import-form.tsx");
    for (const source of [repo, local]) { expect(source).toContain("<ModalityCard"); expect(source).not.toMatch(/name="modality"[^>]*<option|<select[^>]*name="modality"/); }
    expect(repo).toContain('modality: value(form, "modality")');
    expect(local).toContain("fixed={datasetModality}");
  });
  it("WIRING: both forms consume the production model instead of re-implementing it", () => {
    const repo = read("import-form.tsx"), local = read("local-folder-import-form.tsx");
    for (const source of [repo, local]) { expect(source).toContain('from "@/lib/imports/creation-form-model"'); expect(source).not.toMatch(/analyzeConfirmedClasses|normalizeLabelName|toLocaleLowerCase/); }
    expect(repo).toContain("buildRepositoryStartPayload(");
    expect(repo.match(/buildPreviewPayload\(/g)?.length).toBe(3);
    expect(repo).toContain("changeModality(formState(), next)");
    expect(repo).toContain("changeConfirmedClasses(formState(), next)");
    expect(repo).toContain("ensureIdempotencyKey(formState(), randomUUIDAuto)");
    expect(local).toContain("buildFolderStartBody({ appendMode,");
    expect(local).toContain("changeModality(");
    expect(local).toContain("randomUUIDAuto() + randomUUIDAuto()");
  });
  it("WIRING: the repository form's other legitimate key resets are kept, now clearing the key and its taxonomy identity together", () => {
    const repo = read("import-form.tsx");
    expect(repo).toContain("const resetImportKey = () => { importIdempotencyKeyRef.current = null; importKeyIdentityRef.current = null; };");
    expect(repo.match(/resetImportKey\(\);/g)?.length).toBe(3);
    expect(repo).not.toMatch(/importIdempotencyKeyRef\.current = null;\n/);
  });
});
