import { analyzeConfirmedClasses } from "@annotationplatform/domain/confirmed-classes";
import { labelNameSchema, normalizeLabelName } from "@/lib/validation/label-name";

/**
 * Pure, browser-safe state/identity/payload model of the two Dataset creation forms (repository import and local-folder import).
 * No React, no I/O, no randomness: callers inject key generation. The forms consume this module, so tests exercise production logic.
 *
 * Taxonomy equivalence is the server's: the sorted set of `normalizeLabelName` outputs (domain `analyzeConfirmedClasses`),
 * so order, casing and surrounding whitespace never matter and no Unicode normalization is applied.
 */
export type CreationModality = "IMAGE" | "VIDEO" | "AUDIO" | "TEXT";
export type ConfirmedClassList = readonly string[];

/**
 * `idempotencyKey` is the repository flow's retained key (null = none yet) and `keyIdentity` the normalized taxonomy identity it was minted for.
 * The local-folder flow mints a fresh key per submit instead and never uses these two fields.
 */
export type CreationFormState = {
  readonly modality: CreationModality | "";
  readonly confirmedClasses: ConfirmedClassList;
  readonly idempotencyKey: string | null;
  readonly keyIdentity: string | null;
};
export const initialCreationFormState: CreationFormState = { modality: "", confirmedClasses: [], idempotencyKey: null, keyIdentity: null };

/** Normalized taxonomy identity, or null when the list is not a valid taxonomy (duplicates / too many). */
export function taxonomyIdentity(classes: ConfirmedClassList): string | null {
  const analysis = analyzeConfirmedClasses(classes, normalizeLabelName);
  return analysis.ok ? JSON.stringify(analysis.sortedNormalized) : null;
}

/** A different modality clears the confirmed classes and starts a new creation identity; re-selecting the same modality changes nothing. */
export function changeModality(state: CreationFormState, next: CreationModality): CreationFormState {
  if (state.modality === next) return state;
  return { modality: next, confirmedClasses: [], idempotencyKey: null, keyIdentity: null };
}

/**
 * The displayed list always follows the user. The retained key is NOT touched here: whether it is still valid is decided against the
 * normalized taxonomy identity at the moment a key is needed (see ensureIdempotencyKey), so reordering, casing, whitespace and
 * remove-then-re-add to the same final set keep the key, while a genuinely different taxonomy gets a new one.
 */
export function changeConfirmedClasses(state: CreationFormState, next: ConfirmedClassList): CreationFormState {
  return { ...state, confirmedClasses: next };
}

/**
 * Returns the retained key while its taxonomy identity still equals the current one; otherwise mints a new key with the injected
 * generator. A list that is not a valid taxonomy never retains a key.
 */
export function ensureIdempotencyKey(state: CreationFormState, generate: () => string): { state: CreationFormState; key: string } {
  const identity = taxonomyIdentity(state.confirmedClasses);
  if (state.idempotencyKey !== null && identity !== null && state.keyIdentity === identity) return { state, key: state.idempotencyKey };
  const key = generate();
  return { state: { ...state, idempotencyKey: key, keyIdentity: identity }, key };
}

export type ConfirmedClassesIssue = "TOO_MANY" | "DUPLICATE" | "INVALID_NAME";
export type ConfirmedClassesCheck = { ok: true; classes: string[] } | { ok: false; issue: ConfirmedClassesIssue };

/** Mirrors the request schema (0..100, the Label name rule, no normalized duplicates) so an invalid state never becomes a request. */
export function checkConfirmedClasses(classes: ConfirmedClassList): ConfirmedClassesCheck {
  const analysis = analyzeConfirmedClasses(classes, normalizeLabelName);
  if (!analysis.ok) return { ok: false, issue: analysis.issue };
  if (!classes.every((name) => labelNameSchema.safeParse(name).success)) return { ok: false, issue: "INVALID_NAME" };
  return { ok: true, classes: [...classes] };
}

export const confirmedClassesMessage = (issue: ConfirmedClassesIssue): string =>
  issue === "TOO_MANY" ? "At most 100 classes can be confirmed." : issue === "DUPLICATE" ? "Class names must be unique (case-insensitive)." : "Each class name must be 2 to 50 characters.";

/** `confirmedClasses` is present only when non-empty; an empty list is omitted so no-class requests are byte-identical to before. */
export const confirmedClassesField = (classes: ConfirmedClassList): { confirmedClasses?: string[] } => (classes.length > 0 ? { confirmedClasses: [...classes] } : {});

const withoutClasses = (payload: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(payload).filter(([name]) => name !== "confirmedClasses"));

export type StartBuild<T> = { ok: true; body: T } | { ok: false; issue: ConfirmedClassesIssue };

/** Repository start request: translated base payload + the retained key + classes (omitted when empty). Invalid classes build nothing. */
export function buildRepositoryStartPayload(base: Record<string, unknown>, state: CreationFormState, key: string): StartBuild<Record<string, unknown>> {
  const checked = checkConfirmedClasses(state.confirmedClasses);
  if (!checked.ok) return { ok: false, issue: checked.issue };
  return { ok: true, body: { ...withoutClasses(base), idempotencyKey: key, ...confirmedClassesField(checked.classes) } };
}

/** The read-only preview request never carries classes, whatever the caller passed in. */
export function buildPreviewPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return withoutClasses(payload);
}

type FolderItems = unknown[];
/**
 * Local-folder request body. New Dataset: name + modality + classes (when non-empty). Append: only the key and items; classes can never
 * be sent. The key is supplied by the caller per submit (the folder flow does not retain one).
 */
export function buildFolderStartBody(args: { appendMode: boolean; name: string; modality: CreationModality | ""; classes: ConfirmedClassList; idempotencyKey: string; items: FolderItems }): StartBuild<Record<string, unknown>> {
  if (args.appendMode) return { ok: true, body: { idempotencyKey: args.idempotencyKey, items: args.items } };
  const checked = checkConfirmedClasses(args.classes);
  if (!checked.ok) return { ok: false, issue: checked.issue };
  return { ok: true, body: { name: args.name.trim(), modality: args.modality, ...confirmedClassesField(checked.classes), idempotencyKey: args.idempotencyKey, items: args.items } };
}
