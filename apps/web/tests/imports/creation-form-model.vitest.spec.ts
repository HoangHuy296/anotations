import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import { describe, expect, it } from "vitest";

import {
  buildFolderStartBody, buildPreviewPayload, buildRepositoryStartPayload, changeConfirmedClasses, changeModality, checkConfirmedClasses, confirmedClassesField,
  confirmedClassesMessage, ensureIdempotencyKey, initialCreationFormState, taxonomyIdentity, type CreationFormState,
} from "@/lib/imports/creation-form-model";
import { addConfirmedClass, removeConfirmedClass } from "@/lib/imports/confirmed-classes";

/** Deterministic key generator: no randomness anywhere in these assertions. */
const generator = () => { let n = 0; return () => `key-${++n}`; };
const stateWith = (classes: readonly string[], modality: CreationFormState["modality"] = "IMAGE"): CreationFormState => ({ ...initialCreationFormState, modality, confirmedClasses: classes });
const manyClasses = (count: number) => Array.from({ length: count }, (_, index) => `class ${String(index).padStart(3, "0")}`);

describe("taxonomy identity matches the server: sorted normalized names", () => {
  it("is order, casing and whitespace insensitive, and distinguishes real differences", () => {
    expect(taxonomyIdentity(["Car", "Person"])).toBe(taxonomyIdentity(["person", " car "]));
    expect(taxonomyIdentity(["Car", "Person"])).toBe('["car","person"]');
    expect(taxonomyIdentity([])).toBe("[]");
    expect(taxonomyIdentity(["Car"])).not.toBe(taxonomyIdentity(["Cars"]));
    expect(taxonomyIdentity(["Car", "Ca r"])).toBe('["ca r","car"]');
  });
  it("applies no Unicode normalization", () => {
    expect(taxonomyIdentity(["é"])).not.toBe(taxonomyIdentity(["é"]));
  });
  it("is null for a list that is not a valid taxonomy (duplicates, more than 100)", () => {
    expect(taxonomyIdentity(["Car", "car"])).toBeNull();
    expect(taxonomyIdentity(manyClasses(101))).toBeNull();
    expect(taxonomyIdentity(manyClasses(100))).not.toBeNull();
  });
});

describe("repository key lifecycle: the key changes only when the normalized taxonomy identity changes", () => {
  const mint = (classes: readonly string[]) => { const generate = generator(); const first = ensureIdempotencyKey(stateWith(classes), generate); return { generate, state: first.state, key: first.key }; };

  it("mints a key once, then retains it for the same list", () => {
    const { generate, state, key } = mint(["Car", "Person"]);
    expect(key).toBe("key-1");
    expect(ensureIdempotencyKey(state, generate).key).toBe("key-1");
  });
  it("keeps the key for order-only changes", () => {
    const { generate, state } = mint(["Car", "Person"]);
    expect(ensureIdempotencyKey(changeConfirmedClasses(state, ["Person", "Car"]), generate).key).toBe("key-1");
  });
  it("keeps the key for casing-only changes", () => {
    const { generate, state } = mint(["Car", "Person"]);
    expect(ensureIdempotencyKey(changeConfirmedClasses(state, ["car", "PERSON"]), generate).key).toBe("key-1");
  });
  it("keeps the key for whitespace-equivalent changes (and the combined example from the contract)", () => {
    const { generate, state } = mint(["Car", "Person"]);
    expect(ensureIdempotencyKey(changeConfirmedClasses(state, [" Car ", "Person "]), generate).key).toBe("key-1");
    expect(ensureIdempotencyKey(changeConfirmedClasses(state, ["person", " car "]), generate).key).toBe("key-1");
  });
  it("keeps the key when a class is removed and re-added to the same final normalized set", () => {
    const { generate, state } = mint(["Car", "Person"]);
    const removed = changeConfirmedClasses(state, removeConfirmedClass(state.confirmedClasses, "car"));
    expect(removed.confirmedClasses).toEqual(["Person"]); // the displayed list follows the user
    const readded = addConfirmedClass(removed.confirmedClasses, "CAR");
    expect(readded.ok).toBe(true);
    const final = changeConfirmedClasses(removed, readded.ok ? readded.classes : []);
    expect(taxonomyIdentity(final.confirmedClasses)).toBe(taxonomyIdentity(["Car", "Person"]));
    expect(ensureIdempotencyKey(final, generate).key).toBe("key-1");
  });
  it("rotates the key for an actual add, an actual remove, a replacement and clearing", () => {
    for (const next of [["Car", "Person", "Bus"], ["Car"], ["Car", "Truck"], []]) {
      const { generate, state } = mint(["Car", "Person"]);
      const rotated = ensureIdempotencyKey(changeConfirmedClasses(state, next), generate);
      expect(rotated.key).toBe("key-2");
      expect(rotated.state.keyIdentity).toBe(taxonomyIdentity(next));
    }
  });
  it("a key minted for the intermediate set is not resurrected: only the identity the key was minted for is retained", () => {
    const { generate, state } = mint(["Car", "Person"]);
    const removed = ensureIdempotencyKey(changeConfirmedClasses(state, ["Person"]), generate);
    expect(removed.key).toBe("key-2");
    const back = ensureIdempotencyKey(changeConfirmedClasses(removed.state, ["Car", "Person"]), generate);
    expect(back.key).toBe("key-3");
  });
  it("empty -> equivalent empty keeps the key, and a first class rotates it", () => {
    const { generate, state } = mint([]);
    expect(ensureIdempotencyKey(changeConfirmedClasses(state, []), generate).key).toBe("key-1");
    expect(ensureIdempotencyKey(changeConfirmedClasses(state, ["Car"]), generate).key).toBe("key-2");
  });
  it("an invalid (duplicate) list never retains a key", () => {
    const generate = generator();
    const first = ensureIdempotencyKey(stateWith(["Car", "car"]), generate);
    expect(first.state.keyIdentity).toBeNull();
    expect(ensureIdempotencyKey(first.state, generate).key).toBe("key-2");
  });
  it("changeConfirmedClasses itself never touches the key, so the caller's other rotation rules stay in charge", () => {
    const { state } = mint(["Car"]);
    const changed = changeConfirmedClasses(state, ["Car", "Bus"]);
    expect(changed.idempotencyKey).toBe(state.idempotencyKey); expect(changed.keyIdentity).toBe(state.keyIdentity);
    expect(changed.confirmedClasses).toEqual(["Car", "Bus"]);
  });
});

describe("modality change", () => {
  it("clears the confirmed classes and the retained key before any later payload is built", () => {
    const generate = generator();
    const minted = ensureIdempotencyKey(stateWith(["Car", "Person"], "IMAGE"), generate);
    const changed = changeModality(minted.state, "VIDEO");
    expect(changed).toEqual({ modality: "VIDEO", confirmedClasses: [], idempotencyKey: null, keyIdentity: null });
    const next = ensureIdempotencyKey(changed, generate);
    expect(next.key).toBe("key-2");
    const repository = buildRepositoryStartPayload({ datasetName: "d" }, next.state, next.key);
    expect(repository).toEqual({ ok: true, body: { datasetName: "d", idempotencyKey: "key-2" } });
    const folder = buildFolderStartBody({ appendMode: false, name: "n", modality: changed.modality, classes: changed.confirmedClasses, idempotencyKey: "f1", items: [] });
    expect(folder.ok && "confirmedClasses" in folder.body).toBe(false);
  });
  it("re-selecting the current modality changes nothing; every other modality clears the classes", () => {
    const state = stateWith(["Car"], "IMAGE");
    expect(changeModality(state, "IMAGE")).toBe(state);
    expect(changeModality(initialCreationFormState, "TEXT")).toEqual({ modality: "TEXT", confirmedClasses: [], idempotencyKey: null, keyIdentity: null });
    for (const next of ["VIDEO", "AUDIO", "TEXT"] as const) expect(changeModality(state, next).confirmedClasses).toEqual([]);
  });
});

describe("repository start payload", () => {
  const base = { provider: "GITEA", modality: "IMAGE", datasetName: "d", repository: { owner: "o", name: "r", ref: "main" } };
  it("includes confirmedClasses when non-empty (one and several; entry order and typed spelling kept) and the key", () => {
    expect(buildRepositoryStartPayload(base, stateWith(["Car"]), "K9")).toEqual({ ok: true, body: { ...base, idempotencyKey: "K9", confirmedClasses: ["Car"] } });
    expect(buildRepositoryStartPayload(base, stateWith(["Car", "person", "Traffic Sign"]), "K9")).toEqual({ ok: true, body: { ...base, idempotencyKey: "K9", confirmedClasses: ["Car", "person", "Traffic Sign"] } });
  });
  it("omits confirmedClasses when empty, so a no-class request is byte-identical to before", () => {
    const built = buildRepositoryStartPayload(base, stateWith([]), "K9");
    expect(built).toEqual({ ok: true, body: { ...base, idempotencyKey: "K9" } });
    expect(JSON.stringify(built.ok ? built.body : null)).not.toContain("confirmedClasses");
  });
  it("never lets a stale confirmedClasses on the base override the state, and does not mutate its input", () => {
    const stale = { ...base, confirmedClasses: ["Old"] };
    const snapshot = JSON.stringify(stale);
    const built = buildRepositoryStartPayload(stale, stateWith([]), "K");
    expect(built.ok && built.body).not.toHaveProperty("confirmedClasses");
    expect(JSON.stringify(stale)).toBe(snapshot);
  });
  it("invalid confirmed-class state builds no request at all", () => {
    const cases: Array<[readonly string[], "DUPLICATE" | "TOO_MANY" | "INVALID_NAME"]> = [[["Car", "car"], "DUPLICATE"], [manyClasses(101), "TOO_MANY"], [["a"], "INVALID_NAME"], [["x".repeat(51)], "INVALID_NAME"], [[""], "INVALID_NAME"]];
    for (const [classes, issue] of cases) {
      expect(buildRepositoryStartPayload(base, stateWith(classes), "K")).toEqual({ ok: false, issue });
      expect(confirmedClassesMessage(issue)).toMatch(/\S/);
    }
  });
  it("accepts the boundaries 1, 24, 25 and 100 classes", () => {
    for (const count of [1, 24, 25, 100]) {
      const built = buildRepositoryStartPayload(base, stateWith(manyClasses(count)), "K");
      expect(built.ok).toBe(true);
      expect(built.ok ? (built.body.confirmedClasses as string[]).length : -1).toBe(count);
    }
  });
});

describe("preview payload", () => {
  it("never carries confirmedClasses, whatever is passed in, and leaves everything else alone", () => {
    const payload = { provider: "GITEA", modality: "IMAGE", confirmedClasses: ["Car"], datasetName: "d" };
    expect(buildPreviewPayload(payload)).toEqual({ provider: "GITEA", modality: "IMAGE", datasetName: "d" });
    expect(payload.confirmedClasses).toEqual(["Car"]);
    expect(buildPreviewPayload({ a: 1 })).toEqual({ a: 1 });
  });
});

describe("local-folder start / append body", () => {
  const items = [{ logicalPath: "a.txt", contentType: "text/plain", sizeBytes: 1, fingerprint: "f" }];
  it("new Dataset: name (trimmed), modality, classes when non-empty, the per-submit key and items", () => {
    expect(buildFolderStartBody({ appendMode: false, name: "  Street  ", modality: "IMAGE", classes: ["Car", "person"], idempotencyKey: "S1", items })).toEqual({ ok: true, body: { name: "Street", modality: "IMAGE", confirmedClasses: ["Car", "person"], idempotencyKey: "S1", items } });
  });
  it("new Dataset without classes omits the field (same keys as the pre-T015 body)", () => {
    const built = buildFolderStartBody({ appendMode: false, name: "n", modality: "TEXT", classes: [], idempotencyKey: "S1", items });
    expect(built).toEqual({ ok: true, body: { name: "n", modality: "TEXT", idempotencyKey: "S1", items } });
    expect(Object.keys(built.ok ? built.body : {})).toEqual(["name", "modality", "idempotencyKey", "items"]);
  });
  it("append never carries a name, modality or classes, even when classes are present in state", () => {
    expect(buildFolderStartBody({ appendMode: true, name: "ignored", modality: "IMAGE", classes: ["Car"], idempotencyKey: "S2", items })).toEqual({ ok: true, body: { idempotencyKey: "S2", items } });
  });
  it("invalid classes build no request for a new Dataset, but never block an append", () => {
    expect(buildFolderStartBody({ appendMode: false, name: "n", modality: "IMAGE", classes: ["Car", "car"], idempotencyKey: "S", items })).toEqual({ ok: false, issue: "DUPLICATE" });
    expect(buildFolderStartBody({ appendMode: true, name: "n", modality: "IMAGE", classes: ["Car", "car"], idempotencyKey: "S", items }).ok).toBe(true);
  });
  it("keeps its per-submit key semantics: the caller's key is used verbatim, the model retains nothing for the folder flow", () => {
    const a = buildFolderStartBody({ appendMode: false, name: "n", modality: "IMAGE", classes: ["Car"], idempotencyKey: "first", items });
    const b = buildFolderStartBody({ appendMode: false, name: "n", modality: "IMAGE", classes: ["Car"], idempotencyKey: "second", items });
    expect(a.ok && a.body.idempotencyKey).toBe("first"); expect(b.ok && b.body.idempotencyKey).toBe("second");
  });
});

describe("shared helpers", () => {
  it("confirmedClassesField is empty for [] and a defensive copy otherwise", () => {
    expect(confirmedClassesField([])).toEqual({});
    const source = ["Car"]; const field = confirmedClassesField(source);
    expect(field).toEqual({ confirmedClasses: ["Car"] }); expect(field.confirmedClasses).not.toBe(source);
  });
  it("checkConfirmedClasses returns a copy and reports the first applicable issue", () => {
    expect(checkConfirmedClasses([])).toEqual({ ok: true, classes: [] });
    const source = ["Car"]; const checked = checkConfirmedClasses(source);
    expect(checked.ok ? checked.classes : null).toEqual(["Car"]); expect(checked.ok ? checked.classes : null).not.toBe(source);
    expect(checkConfirmedClasses(["Car", "car"])).toEqual({ ok: false, issue: "DUPLICATE" });
  });
});
