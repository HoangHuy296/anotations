# AI class to Dataset label mapping

**Rule.** AI classes are mapped automatically to Dataset labels; the user decides the final label. A class missing from the Dataset's labels is never a reason
for an AI result to stay `unlabeled`, and never a reason to re-run inference.

Implementation: `packages/domain/src/ai-label-resolution.ts` (one contract), used by the VIDEO writer (`apps/worker/src/jobs/ai-video-prediction-writer.ts`),
the IMAGE writer (`apps/worker/src/jobs/ai-prediction-writer.ts`) and the reconcile operation (`apps/web/src/lib/ai/ai-label-reconcile.ts`).

## Data model (unchanged)

No new model or column. Identity is the existing `Label.normalizedName`, unique per Dataset across modalities. The provider's `labelKey` is the class name;
its canonical key is `trim()` + `toLocaleLowerCase("en-US")`, the same normalization `normalizeLabelName` applies everywhere. There is no fuzzy or alias
matching (`traffic light` and `traffic-light` stay distinct). The original class is recorded on every AI annotation and track as
`properties.predictedClass` (plus `providerTrackId`, `aiTaskId`, `modelKey`, `resultFingerprint`).

## Resolution, per distinct class in a result

1. Canonicalize. Blank, over-long (> 256) or control-character classes reject the whole result before any write (`AI_LABEL_CLASS_INVALID`). The literal class
   `unknown` stays unlabeled by definition.
2. A Dataset label with that key whose modality is `null` or the Dataset's own modality, and whose scope is `OBJECT`, is reused unchanged (name, colour, settings).
3. A label under that key with another modality or scope is a **conflict**: never reused, never modified. The class is reported in the task output
   (`labelConflicts`) and its annotations keep their boxes but stay unlabeled. An IMAGE-only label never becomes a VIDEO label because the key matches.
4. Otherwise a Dataset-scoped label is created with the Dataset's modality and a deterministic colour, using `createMany(skipDuplicates)` so concurrent tasks and
   retries cannot create a duplicate or abort the transaction.

Global/default label templates are never read or written. Default labels (`ensureDefaultImageLabels`) exist for IMAGE and VIDEO datasets only and carry the
Dataset's own modality; TEXT and AUDIO datasets never receive them.

## Idempotency and manual edits

- A duplicate delivery of one Job writes nothing (the completion claim in the same transaction).
- A repeated AI task over the same asset with an identical result (same model, class, provider track id and keyframe boxes) is recognised through
  `properties.resultFingerprint` and skipped. A row a human has since relabeled, moved or edited still counts as "already persisted", so it is never
  overwritten or duplicated. A genuinely new result is appended.
- The writers never update or delete an existing annotation, track or label.

## Reconciling existing unlabeled AI annotations

`POST /api/datasets/{datasetId}/ai-label-reconcile` (permission `label.manage`; IMAGE and VIDEO datasets; body `{ "dryRun": true | false }`, default dry run).
It resolves the recorded `predictedClass` through the same contract and links tracks and keyframes. It only considers AI-sourced rows that are still unlabeled at
revision 1 (tracks too), on non-frozen assets, and every write re-checks that predicate, so a concurrent edit wins. Rows without recorded class metadata are
counted (`skipped.noOriginalClass`) and left alone; it never guesses, never reruns inference, never deletes or moves a box.
