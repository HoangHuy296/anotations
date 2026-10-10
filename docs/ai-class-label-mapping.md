# AI predicted class vs Dataset label

**Rule.** The VIDEO workspace displays the exact class the AI Service detected, even when no Dataset Label defines it. A Label is annotation
configuration owned by the Dataset; `predictedClass` is a recognition result. Users never have to predefine labels, no Label row is created to display a
prediction, and the user's own label choice always wins.

## Concepts

| Concept | Where | Meaning |
| --- | --- | --- |
| `predictedClass` | `properties.predictedClass` on every AI keyframe (`Annotation`) and track (`VideoObjectTrack`) | What the AI Service returned. Never rewritten, also after manual edits. |
| Label link | `Annotation.labelId` / `VideoObjectTrack.labelId` | Optional reference to an existing Dataset Label. Set by a user, or by the writer only when a compatible Label already exists. |
| `displayLabel` | computed in the browser (`apps/web/src/lib/workspace/video-display-label.ts`) | The effective text/colour shown on the box, in the track selector and in the Tracks tab. |

No schema change, no new endpoint, no read-side database write.

## Display resolution (deterministic, no fuzzy matching)

1. A label the track explicitly carries (`track.label`): a user's choice, or a link the writer made to an existing label.
2. An existing compatible Dataset label whose canonical name equals the AI class (so a label defined later applies to older AI results).
3. The original AI class, exactly as returned (`properties.predictedClass`, track first, then the keyframe).
4. `unlabeled`, only when none of the above exists.

Canonical key = `trim()` + `toLocaleLowerCase("en-US")` (the existing `normalizeLabelName` rule). Compatible = label modality is null or the Dataset's own, scope
`OBJECT`. A same-name label of another modality or scope is never used or modified; the original class is still displayed. Blank, over-long,
control-character or `unknown` classes are not displayable classes.

## Persistence (`packages/domain/src/ai-label-resolution.ts`, worker writers)

- The VIDEO writer links a track and its keyframes to an existing compatible Label when the canonical key matches, otherwise `labelId` stays null. It never
  creates a Label. A malformed class rejects the whole result before any write. An incompatible same-key label is reported in the task output
  (`labelConflicts`).
- The IMAGE writer keeps its original contract (a detection is persisted only for a class that matches an existing compatible Label) with the same read-only
  match, the result fingerprint and the claim-first concurrency guard.
- Repeated AI tasks: an identical result (same model, class, provider track id and keyframe boxes) carries the same `properties.resultFingerprint` and is skipped
  even if a human has since relabeled or edited it; a new result is appended. A duplicate delivery of one Job writes nothing.
- Updating a track, keyframe or temporal label no longer overwrites stored `properties` (Zod 4 re-applied the create default), so provenance survives edits.

## Legacy data

Existing AI rows with `properties.predictedClass` and no label simply render their class; no repair is needed. Rows without a recorded class remain
`unlabeled`. The JSON export carries `labelId` (null when unassigned) and the sanitized `properties`, so the original class is exported with every annotation.
