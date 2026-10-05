# Feature Specification: Multi-Format Bulk & Dataset Export

**Feature Directory**: `specs/028-multi-format-export`
**Created**: 2026-09-28
**Status**: Spec frozen for implementation. Build order: shared capability/dispatcher layer → YOLO → VOC → LabelMe → CVAT → OpenImages. MOT and Text (image/audio) remain conditional/deferred per §2/§3 until their own gates clear. Builds directly on `specs/027-coco-dataset-export` (reuses its eligibility rules, deterministic-ID scheme, `relativePath` identity, and skip-reason accounting).

## 0. Scope

Two user-facing surfaces, both format-parameterized versions of existing capability:
1. **Export Selected** (the bulk-selection panel from Phase 026): after selecting Assets, choosing "Export Selected" offers a format picker, categorized by modality.
2. **`/exports`** (Dataset Export, Phase 012/027): the flat "Format: JSON" line becomes a dropdown, categorized the same way.

Both surfaces derive their offered formats from the **one shared capability matrix** (§4) — never a second, independently-maintained list.

**Bounding-box only, unchanged from the prior draft**: every interoperable image format is bbox-only, exactly like COCO. An eligible-otherwise annotation with unsupported geometry is skipped and counted (`unsupported_geometry_type`), never silently dropped.

## 1. Architecture — one dispatcher, one module per format, all reusing COCO's foundations

```
apps/worker/src/jobs/
  export-format-capability.ts     -- NEW, first: the one shared matrix (§4) — API validation,
                                       worker dispatch, and UI all import this, nothing else
  export-format-registry.ts       -- format -> serializer dispatch table, driven by the matrix
  image-export-eligibility.ts     -- NEW, first: eligibility/skip-reason/ordering logic extracted
                                       out of coco-export-serializer.ts, shared by every image format
  coco-export-serializer.ts       -- existing (027), refactored to use image-export-eligibility.ts
  yolo-export-serializer.ts       -- new (build order: 1st)
  voc-export-serializer.ts        -- new (2nd)
  labelme-export-serializer.ts    -- new (3rd)
  cvat-export-serializer.ts       -- new (4th)
  openimages-export-serializer.ts -- new (5th)
  mot-export-serializer.ts        -- CONDITIONAL, see §3 -- not started until its own gate clears
```

Every image-format serializer reuses, unchanged, the extracted `image-export-eligibility.ts`: the exact eligibility predicate (027 §2), the same named skip reasons counted identically across every format, the same deterministic ordering (images by `(relativePath-or-filename, id)`, categories by `(normalizedName, id)`, annotations by `(image_id, createdAt, id)`), and `relativePath` as the canonical per-image identity (same deferred-until-BACKFILL caveat as COCO — see 027 §13a). Adding a future format means one new serializer module against this shared machinery, never a change to `Asset`/`Annotation`/the eligibility rule itself.

## 2. Decision: OpenImages `ImageID` is platform-controlled and deterministic, never a storage/signed URL or raw `Asset.id`

Per instruction. `ImageID` = the same deterministic per-export ordinal already used for COCO's `images[].id` (assets sorted by `(relativePath-or-filename, id)`, numbered from 1), formatted as a stable string (e.g. `img_000001`). This value is **portable and reconstructible from the artifact alone** — never a MinIO key, never a presigned URL, never `Asset.id` exposed as the join key. A companion `images.csv` (`ImageID,relativePath,Width,Height`) ships alongside `annotations.csv` in the same archive, so `relativePath` remains the human-portable filename/path identity wherever the format needs one, exactly as instructed — Open Images' own real dataset does the same thing (a separate image-list file), so this isn't a deviation from the standard, just filling in what the standard leaves external.

## 3. Decision: MOT is conditional on canonical FPS — audited, not assumed

**Audit performed, not inferred.** `VideoAsset.fps Float?` is a real, already-written canonical field — `apps/worker/src/jobs/video-metadata.ts` parses it from ffprobe's `avg_frame_rate` during the existing `EXTRACT_VIDEO_METADATA` job (guarded: only stored when finite, `>0`, `<=1000`; otherwise left `null`). **This is a genuine platform-canonical FPS source — it is not invented, and MOT is not blanket-blocked by "no such field exists."**

**Coverage, checked against the live DB, not assumed:**
```sql
SELECT count(*) AS total, count(fps) AS with_fps FROM "VideoAsset";
-- total: 11, with_fps: 3  (27%)
```
8 of 11 existing `VideoAsset` rows have `fps IS NULL` today — either `EXTRACT_VIDEO_METADATA` hasn't run for them, or ffprobe couldn't determine a valid rate.

**Resolution, matching the pattern already established for COCO's `width`/`height` gate:** MOT is **per-video conditional, not per-format blocked**. A `VideoObjectTrack`'s keyframes are MOT-eligible only when their owning `VideoAsset.fps IS NOT NULL`; a video lacking it is skipped and counted under a new named reason (`missing_fps`), never defaulted to 25/30fps. **Implementation of `mot-export-serializer.ts` itself is deferred** (not in the build order above) until this eligibility rule and its skip-accounting are explicitly reviewed on their own — flagged now, not started this round, per instruction to report the gap rather than assume a resolution unilaterally. If you'd prefer the stricter reading — MOT fully deferred as a format until FPS coverage is materially better than 27% — say so and I'll drop it from the matrix entirely instead of shipping a per-video-conditional version.

## 4. Decision: Text (image/audio) stays deferred — no new lossy format invented

Withdrawn from this phase's format list entirely (not aliased to JSON, not implemented): a portable per-image/per-audio "Text" interchange format has no existing standard to anchor it, and Text annotations on the TEXT modality already carry span/entity/relation/classification semantics that a lossy line-oriented dump would flatten. Per instruction, that stays on the existing lossless native JSON manifest, and a new *portable* Text interchange format needs its own explicit contract in a later, separate spec — not invented here to fill a UI category.

## 5. The shared format-capability matrix (single source of truth)

```ts
// apps/worker (or packages/domain, shared with apps/web) -- exact module TBD at implementation time
export type ExportFormat = "JSON" | "COCO" | "YOLO" | "VOC" | "LABELME" | "CVAT" | "OPENIMAGES" | "MOT";

export type FormatCapability = {
  /** Modalities this format can ever apply to. */
  modalities: Array<"IMAGE" | "VIDEO" | "AUDIO" | "TEXT">;
  /** Whether a real serializer exists yet -- gates actual availability
   *  independent of modality compatibility. Flips to true as each format
   *  ships; nothing else needs to change for it to become selectable. */
  implemented: boolean;
  /** Set only for a format that is compatibility-defined but not yet
   *  buildable for a stated, auditable reason (MOT today). */
  deferralReason?: string;
  /** COCO only, currently -- whether a captured real AIOZ /format sample
   *  was used to cross-check this serializer's output (027 §0/§11c). Every
   *  other format is UNVERIFIED against AIOZ by definition (§6) until a
   *  real sample is provided and checked. */
  aiozVerified: boolean;
};

export const EXPORT_FORMAT_CAPABILITY: Record<ExportFormat, FormatCapability> = {
  JSON:       { modalities: ["IMAGE", "VIDEO", "AUDIO", "TEXT"], implemented: true,  aiozVerified: false },
  COCO:       { modalities: ["IMAGE"],                           implemented: true,  aiozVerified: true  },
  YOLO:       { modalities: ["IMAGE"],                           implemented: false, aiozVerified: false },
  VOC:        { modalities: ["IMAGE"],                           implemented: false, aiozVerified: false },
  LABELME:    { modalities: ["IMAGE"],                           implemented: false, aiozVerified: false },
  CVAT:       { modalities: ["IMAGE"],                           implemented: false, aiozVerified: false },
  OPENIMAGES: { modalities: ["IMAGE"],                           implemented: false, aiozVerified: false },
  MOT:        { modalities: ["VIDEO"],                           implemented: false, aiozVerified: false,
                deferralReason: "canonical VideoAsset.fps exists but is only populated for 3/11 (27%) of current videos -- see §3" },
};
```

**Every consumer derives compatibility from this one object, never a second list:**
- **API validation** (`exportRequestSchema`/`BULK_EXPORT_SELECTED`'s input schema): a request is valid only if `EXPORT_FORMAT_CAPABILITY[format].implemented` and the target's modality (or every modality present, for a mixed-modality target) is in `.modalities`. Server-side, authoritative — this is the actual enforcement point, not the UI.
- **Worker dispatch** (`export-format-registry.ts`): keyed off the same `ExportFormat` union; a format reaching the worker without a registered serializer is a programming error (should be impossible given API validation), not a silent no-op.
- **`/exports` UI and Export Selected's format picker**: both render only formats where `implemented: true` and the modality matches, grouped by modality for display. Neither hard-codes its own format list.
- **Mixed-modality target (a Dataset or an Export-Selected set spanning more than one modality)**: per instruction, an incompatible modality is never silently dropped from the export. If the requested format doesn't cover every modality actually present in the target, **the request is rejected outright** (400, naming which modality is unsupported) — never a partial export that quietly excludes some assets. A user exporting a mixed Dataset must pick a format valid for the modality they actually want (or `JSON`, which covers all four).

## 6. Per-format wire shape (unchanged from the prior draft, condensed)

| Format | Shape | Files | AIOZ status |
|---|---|---|---|
| **YOLO** | One `.txt` per image: `<class_index> <x_center> <y_center> <width> <height>` per line, normalized 0–1; one `classes.txt` (index order) | multi-file (zip) | **UNVERIFIED** — independent public standard only (§7) |
| **VOC** | One Pascal-VOC XML per image (`<annotation><size>...<object><bndbox>...`), pixel-space integer bounds | multi-file (zip) | **UNVERIFIED** |
| **LabelMe** | One JSON per image (`{shapes:[{label, points:[[xmin,ymin],[xmax,ymax]], shape_type:"rectangle"}], imageHeight, imageWidth}`), pixel-space | multi-file (zip) | **UNVERIFIED** |
| **CVAT** | One `annotations.xml` (CVAT "for images 1.1" schema: `<annotations><meta>...<image id name width height><box label xtl ytl xbr ybr/>`) | single file | **UNVERIFIED** |
| **OpenImages** | `annotations.csv` (`ImageID,LabelName,XMin,XMax,YMin,YMax,...`, normalized 0–1) + `images.csv` (§2) + `classes.csv` | multi-file (zip) | **UNVERIFIED** |
| **MOT** | MOTChallenge CSV (`frame,id,bb_left,bb_top,bb_width,bb_height,conf,-1,-1,-1`) | conditional, see §3 | **UNVERIFIED**, and not started |

## 7. AIOZ compatibility status — explicit per instruction

**COCO is the only format with a captured, real AIOZ `/format` example** (the original message of this engagement). Every format in this spec is implemented against its own independently documented public standard and is **explicitly UNVERIFIED against AIOZ** — this is stated as a permanent field in the capability matrix (`aiozVerified: false`), not a footnote that can be forgotten. If a real captured AIOZ sample for any of these formatters becomes available, it will be cross-checked before that format's `aiozVerified` flips to `true` — never assumed compatible from the format name alone.

## 8. Multi-file export artifacts (new capability, needed by YOLO/VOC/LabelMe/OpenImages)

COCO/JSON/CVAT/MOT are single-file artifacts. YOLO/VOC/LabelMe/OpenImages produce one file per image (or a small fixed set of companion files) — a Dataset with 500 images means 500+ files. Needs a ZIP archive as the stored artifact (`exports/{datasetId}/{jobId}/{format}.zip`), built by the worker, downloaded as one signed URL exactly like today — never per-file presigned URLs. A shared "zip-and-upload" helper is added to the export job processors, used by any multi-file format's dispatch entry.

## 9. Job wiring (unchanged — reuse existing job types, per instruction)

`EXPORT_DATASET` and `BULK_EXPORT_SELECTED` both gain the widened `ExportFormat` enum (§5) on their existing input schemas — no new job type. Queue payloads stay `{ jobId }` only. Canonical PostgreSQL `Annotation`/`Asset`/`Label` remain the sole data source for every format; no provider call, no per-format job. Existing authorization, idempotency-key structure (now including `format` the same way 027 already added it for JSON/COCO), and artifact/download flow are reused unchanged; only the artifact's file shape (single file vs. zip) varies by format.

## 10. Build order (frozen)

1. **Shared layer first**: `export-format-capability.ts` (§5) + `image-export-eligibility.ts` (§1's extraction from `coco-export-serializer.ts`, with COCO's own tests re-run to confirm the refactor changes no behavior).
2. **YOLO** — simplest, no XML/CSV schema to match, good proof of the multi-file/zip path.
3. **VOC**.
4. **LabelMe**.
5. **CVAT**.
6. **OpenImages** — now unblocked by §2's `ImageID` decision.
7. **UI** (Export Selected picker + `/exports` dropdown) — built once the shared capability matrix and ≥1 real format per modality exist, consuming the matrix directly (§5), not a hand-maintained UI list.
8. **MOT** — conditional, per §3; not started until its per-video eligibility/skip-accounting design is explicitly reviewed.
9. **Text (image/audio)** — deferred indefinitely per §4; needs its own future spec, not part of this phase's build order at all.

Each shipped format gets its own test coverage matching COCO's rigor (eligibility/skip-reason coverage, deterministic-ordering proof, a real-DB integration test), reviewed one format per turn.
