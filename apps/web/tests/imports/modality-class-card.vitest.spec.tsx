import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ClassEntry, ClassEntryView, ModalityCard } from "@/components/imports/modality-class-card";
import { buildClassOptions, type ComboboxState } from "@/lib/imports/class-combobox-state";

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

describe("form integration", () => {
  const read = (file: string) => readFileSync(path.resolve(process.cwd(), "src/components/imports", file), "utf8");
  it("both creation forms use the modality card instead of a select, and the repository payload still reads the native modality field", () => {
    const repo = read("import-form.tsx"); const local = read("local-folder-import-form.tsx");
    for (const source of [repo, local]) { expect(source).toContain("<ModalityCard"); expect(source).not.toMatch(/name="modality"[^>]*<option|<select[^>]*name="modality"/); }
    expect(repo).toContain('modality: value(form, "modality")');
    expect(local).toContain("{ name: name.trim(), modality }");
  });
  it("changing the draft modality resets the repository preview and idempotency key", () => {
    expect(read("import-form.tsx")).toMatch(/onChange=\{\(next\) => \{ setModality\(next\); setPreview\(null\); importIdempotencyKeyRef\.current = null; \}\}/);
  });
  it("append mode shows the parent's modality as fixed and does not send a modality", () => {
    const local = read("local-folder-import-form.tsx");
    expect(local).toContain("fixed={datasetModality}");
    expect(local).toContain("...(appendMode ? {} : { name: name.trim(), modality })");
  });
  it("confirmed classes are not mounted in either form or sent in any request until the server contract is approved", () => {
    for (const file of ["import-form.tsx", "local-folder-import-form.tsx"]) { const source = read(file); expect(source).not.toContain("<ClassEntry"); expect(source).not.toMatch(/confirmedClasses|classes:/); }
  });
});
