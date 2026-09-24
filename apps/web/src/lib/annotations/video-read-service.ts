import "server-only";

import { AnnotationType, Modality, type Prisma } from "@internal/db";
import type { RequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { resolveVideoAssetAccess } from "@/lib/annotations/video-authorization";
import { deriveInterpolationAt } from "@/lib/annotations/video-interpolation";
import { resolveVideoTimelineDurationMs } from "@/lib/annotations/video-time";
import { VIDEO_ANNOTATION_LIMITS } from "@/lib/annotations/video-limits";
import { toSafeVideoKeyframe, toSafeVideoTemporalLabel, toSafeVideoTrack } from "@/lib/annotations/video-projection";
import type { SafeVideoAnnotations } from "@/types/video-annotation";
import { videoReadQuerySchema } from "@/lib/validation/video-annotation";

export type VideoReadOutcome =
  | { ok: true; data: SafeVideoAnnotations }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "INVALID_WINDOW"; message: string };

function box(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (["x", "y", "width", "height"].every((key) => typeof candidate[key] === "number")) {
    return { kind: "BOUNDING_BOX" as const, x: candidate.x as number, y: candidate.y as number, width: candidate.width as number, height: candidate.height as number };
  }
  return null;
}

const annotationSelect = {
  id: true, assetId: true, labelId: true, type: true, geometry: true, properties: true, revision: true,
  timestampMs: true, trackId: true, isKeyframe: true, isInterpolated: true, startMs: true, endMs: true,
  createdAt: true, updatedAt: true,
} satisfies Prisma.AnnotationSelect;

const trackSelect = {
  id: true, videoAssetId: true, labelId: true, name: true, color: true, properties: true, status: true,
  revision: true, annotationType: true, interpolationMode: true, createdAt: true, updatedAt: true,
  label: { select: { id: true, name: true, color: true } },
} satisfies Prisma.VideoObjectTrackSelect;

type AnnotationRow = Prisma.AnnotationGetPayload<{ select: typeof annotationSelect }>;

/** `(timestampMs, id)` keyset cursor -- `id` (a cuid, globally unique) breaks ties deterministically when two keyframes share a timestamp, so paging never skips or repeats a row. Opaque to callers; only ever produced by `encodeCursor` below. */
function encodeCursor(row: { timestampMs: number; id: string }): string {
  return `${row.timestampMs}:${row.id}`;
}

function decodeCursor(raw: string): { timestampMs: number; id: string } | null {
  const separatorIndex = raw.indexOf(":");
  if (separatorIndex <= 0) return null;
  const timestampMs = Number(raw.slice(0, separatorIndex));
  const id = raw.slice(separatorIndex + 1);
  return Number.isInteger(timestampMs) && timestampMs >= 0 && id.length > 0 ? { timestampMs, id } : null;
}

/**
 * Windowed, cursor-paginated VIDEO annotation read. This is the *only*
 * mechanism that decides which tracks/keyframes/temporal labels are
 * relevant to a request -- there is no unconditional "first N tracks by
 * createdAt" fallback. `[fromMs, toMs]` decides *what's relevant*;
 * `cursor`/`nextCursor` (keyset, not offset -- see `encodeCursor`) page
 * through it. `VIDEO_ANNOTATION_LIMITS.keyframesPerPage` bounds one page's
 * response size, never how much of a window's true data a caller can
 * retrieve: an asset with 70,000 accumulated keyframes in one 30s window
 * (many AI runs stacked on the same asset) is fully reachable by following
 * `nextCursor`, not by raising that number.
 *
 * A track can be relevant to a window without any keyframe strictly inside
 * it: a track with a keyframe before `fromMs` *and* one after `toMs` is
 * mid-interpolation for the entire window and must still render. So
 * "relevant to this page" = has a keyframe on *this page*, OR straddles the
 * window (a boundary keyframe on both sides). Boundary rows/tracks are
 * recomputed identically on every page rather than only on the first, so any
 * page fetched in isolation is still a self-consistent, correctly
 * interpolatable slice -- a client merging pages by id absorbs the
 * resulting (intentional) repetition for free. The before-side lookup is
 * capped (`tracksPerWindowSafetyCap`, a genuine, if rare, safety limit); the
 * after-side is an exact `trackId IN (...)` lookup scoped to that page's own
 * candidates, so it can never itself be a truncation source.
 *
 * `totalTracksInWindow`/`totalKeyframesInWindow` are authoritative counts
 * for the *whole* window (a `count()`/`groupBy`, independent of paging),
 * deliberately excluding boundary-only tracks/rows -- they describe the
 * requested interval, not any one page's contribution to it.
 */
export async function readVideoAnnotations(actor: RequestActor, assetId: string, query: unknown = {}): Promise<VideoReadOutcome> {
  const parsed = videoReadQuerySchema.safeParse(query);
  if (!parsed.success) return { ok: false, reason: "INVALID_WINDOW", message: parsed.error.issues[0]?.message ?? "Invalid read window." };
  const cursorValue = parsed.data.cursor !== undefined ? decodeCursor(parsed.data.cursor) : null;
  if (parsed.data.cursor !== undefined && !cursorValue) return { ok: false, reason: "INVALID_WINDOW", message: "Malformed cursor." };
  const access = await resolveVideoAssetAccess(actor, assetId);
  if (!access) return { ok: false, reason: "NOT_FOUND" };
  const { asset } = access;

  const durationMs = resolveVideoTimelineDurationMs({ totalFrames: asset.videoAsset?.totalFrames ?? null, fps: asset.videoAsset?.fps ?? null, durationMs: asset.durationMs ?? null });
  const effectiveFromMs = parsed.data.fromMs ?? 0;
  const defaultSpanEnd = effectiveFromMs + VIDEO_ANNOTATION_LIMITS.defaultWindowMs;
  const effectiveToMs = parsed.data.toMs ?? (durationMs !== null ? Math.min(defaultSpanEnd, Math.max(durationMs, effectiveFromMs + 1)) : defaultSpanEnd);
  if (effectiveToMs <= effectiveFromMs) return { ok: false, reason: "INVALID_WINDOW", message: "Read window must be positive." };
  if (effectiveToMs - effectiveFromMs > VIDEO_ANNOTATION_LIMITS.maxWindowMs) return { ok: false, reason: "INVALID_WINDOW", message: `Read window cannot exceed ${VIDEO_ANNOTATION_LIMITS.maxWindowMs}ms.` };

  const videoAssetId = asset.videoAsset?.id ?? "";
  const baseWhere = { assetId, datasetId: asset.datasetId, modality: Modality.VIDEO } as const;
  const inWindowKeyframeWhere = { ...baseWhere, isKeyframe: true, trackId: { not: null }, timestampMs: { gte: effectiveFromMs, lte: effectiveToMs } } satisfies Prisma.AnnotationWhereInput;
  const cursorFilter: Prisma.AnnotationWhereInput = cursorValue
    ? { OR: [{ timestampMs: { gt: cursorValue.timestampMs } }, { timestampMs: cursorValue.timestampMs, id: { gt: cursorValue.id } }] }
    : {};

  const [pageRowsPlusOne, temporalLabelRows, beforeBoundaryRows, anyAfterToMsExists, totalKeyframesInWindow, distinctTracksInWindow] = await Promise.all([
    // Keyset pagination: `take: pageSize + 1` -- if the extra row comes
    // back, there is a next page; it is dropped before returning.
    db.annotation.findMany({
      where: { ...inWindowKeyframeWhere, ...cursorFilter },
      orderBy: [{ timestampMs: "asc" }, { id: "asc" }],
      take: VIDEO_ANNOTATION_LIMITS.keyframesPerPage + 1,
      select: annotationSelect,
    }),
    db.annotation.findMany({
      where: { ...baseWhere, trackId: null, startMs: { lte: effectiveToMs }, endMs: { gte: effectiveFromMs } },
      orderBy: [{ startMs: "asc" }, { id: "asc" }],
      take: VIDEO_ANNOTATION_LIMITS.temporalLabelsPerWindowSafetyCap,
      select: annotationSelect,
    }),
    // Nearest persisted keyframe *before* fromMs, one row per track --
    // `distinct: ["trackId"]` with `orderBy` starting on the same field maps
    // to Postgres `DISTINCT ON (trackId) ... ORDER BY trackId, timestampMs
    // DESC`, so the first row kept per track is the one closest to fromMs.
    // Capped -- an asset can have more than `tracksPerWindowSafetyCap`
    // distinct tracks with *some* activity before fromMs; see
    // `beforeBoundaryTruncated` below for what that means for correctness.
    db.annotation.findMany({
      where: { ...baseWhere, isKeyframe: true, trackId: { not: null }, timestampMs: { lt: effectiveFromMs } },
      orderBy: [{ trackId: "asc" }, { timestampMs: "desc" }, { id: "asc" }],
      distinct: ["trackId"],
      take: VIDEO_ANNOTATION_LIMITS.tracksPerWindowSafetyCap,
      select: annotationSelect,
    }),
    // Cheap existence check, not a count: lets `beforeBoundaryTruncated`
    // below tell "a capped before-side might have hidden a straddler" apart
    // from "nothing exists after toMs anywhere, so no straddler is possible
    // regardless of how the before-side was capped" (a window long after all
    // activity on an asset would otherwise flag itself as truncated purely
    // because *some other, unrelated* track has old pre-window history).
    db.annotation.findFirst({ where: { ...baseWhere, isKeyframe: true, trackId: { not: null }, timestampMs: { gt: effectiveToMs } }, select: { id: true } }),
    // Authoritative, pagination-independent totals for the requested
    // interval -- a client can compare these against what it has
    // accumulated across pages without re-deriving them itself.
    db.annotation.count({ where: inWindowKeyframeWhere }),
    db.annotation.groupBy({ by: ["trackId"], where: inWindowKeyframeWhere }),
  ]);

  const hasMore = pageRowsPlusOne.length > VIDEO_ANNOTATION_LIMITS.keyframesPerPage;
  const inWindowKeyframeRows = hasMore ? pageRowsPlusOne.slice(0, VIDEO_ANNOTATION_LIMITS.keyframesPerPage) : pageRowsPlusOne;
  const lastRow = inWindowKeyframeRows.at(-1);
  const nextCursor = hasMore && lastRow?.timestampMs !== null && lastRow?.timestampMs !== undefined ? encodeCursor({ timestampMs: lastRow.timestampMs, id: lastRow.id }) : null;

  const inWindowTrackIds = new Set(inWindowKeyframeRows.map((row) => row.trackId as string));
  const beforeByTrack = new Map(beforeBoundaryRows.map((row) => [row.trackId as string, row]));

  // Nearest keyframe *after* toMs, scoped to exactly the tracks that could
  // need it: this page's in-window tracks (right-edge interpolation
  // context) union the before-side's candidates (straddle detection). Unlike
  // the old design (a `distinct` scan across *every* track on the asset,
  // capped independently of what it was being asked about), this is an
  // exact `trackId IN (...)` lookup -- its result size is bounded by the
  // candidate list itself, so it can never truncate and never produces a
  // false "might have missed a straddler" alarm caused by unrelated tracks
  // elsewhere in a heavily-reused asset.
  const afterCandidateTrackIds = [...new Set([...inWindowTrackIds, ...beforeByTrack.keys()])];
  const afterBoundaryRows = afterCandidateTrackIds.length ? await db.annotation.findMany({
    where: { ...baseWhere, isKeyframe: true, trackId: { in: afterCandidateTrackIds }, timestampMs: { gt: effectiveToMs } },
    orderBy: [{ trackId: "asc" }, { timestampMs: "asc" }, { id: "asc" }],
    distinct: ["trackId"],
    select: annotationSelect,
  }) : [];
  const afterByTrack = new Map(afterBoundaryRows.map((row) => [row.trackId as string, row]));
  const straddlingTrackIds = [...beforeByTrack.keys()].filter((trackId) => afterByTrack.has(trackId));
  const relevantTrackIds = [...new Set([...inWindowTrackIds, ...straddlingTrackIds])];

  const boundaryRows: AnnotationRow[] = relevantTrackIds.flatMap((trackId) => {
    const before = beforeByTrack.get(trackId);
    const after = afterByTrack.get(trackId);
    return [...(before ? [before] : []), ...(after ? [after] : [])];
  });

  // `relevantTrackIds` is provably at most `keyframesPerPage` (one distinct
  // track per in-window row, worst case) plus `tracksPerWindowSafetyCap`
  // (straddling candidates) -- this bound is exact, not a guess, so the
  // track-object fetch below can never itself truncate. Reusing
  // `tracksPerWindowSafetyCap` here (as the old code did) was the actual bug
  // this fixes: a single page can legitimately reference far more distinct
  // tracks than that cap once `keyframesPerPage` (2,000) exceeds it (500).
  const tracksFetchCap = VIDEO_ANNOTATION_LIMITS.keyframesPerPage + VIDEO_ANNOTATION_LIMITS.tracksPerWindowSafetyCap;
  const tracks = relevantTrackIds.length ? await db.videoObjectTrack.findMany({
    where: { videoAssetId, id: { in: relevantTrackIds } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: tracksFetchCap,
    select: trackSelect,
  }) : [];

  const safeTracks = tracks.map((track) => toSafeVideoTrack(track));
  const safeKeyframes = [...inWindowKeyframeRows, ...boundaryRows].flatMap((annotation) => {
    const geometry = box(annotation.geometry);
    return annotation.trackId && annotation.isKeyframe && !annotation.isInterpolated && annotation.timestampMs !== null && annotation.type === AnnotationType.BOUNDING_BOX && geometry
      ? [toSafeVideoKeyframe({ ...annotation, trackId: annotation.trackId, type: "BOUNDING_BOX", geometry, timestampMs: annotation.timestampMs })]
      : [];
  });
  const safeTemporalLabels = temporalLabelRows.flatMap((annotation) => annotation.trackId === null && !annotation.isKeyframe && !annotation.isInterpolated && annotation.startMs !== null && annotation.endMs !== null && (annotation.type === AnnotationType.EVENT || annotation.type === AnnotationType.SCENE || annotation.type === AnnotationType.SHOT_BOUNDARY)
    ? [toSafeVideoTemporalLabel({ ...annotation, type: annotation.type, startMs: annotation.startMs, endMs: annotation.endMs })]
    : []);

  // One derived sample per relevant track at the window's own start -- lets
  // the timeline show/seek to an interpolated position exactly at fromMs
  // when no real keyframe sits there. Only meaningful on the first page:
  // page 1's own in-window rows are, by construction (ascending order),
  // always the timestamps nearest `fromMs` for a track that has one in this
  // window, so it never needs a later page's data. A later page recomputing
  // this from *its own* slice would get the wrong "nearest" keyframe, so
  // pages after the first return no interpolation sample at all -- a client
  // already has the correct one from page 1 by the time later pages arrive.
  const interpolation = cursorValue ? [] : safeTracks.flatMap((track) => {
    const trackKeyframes = safeKeyframes.filter((keyframe) => keyframe.trackId === track.id).map((keyframe) => ({ trackId: keyframe.trackId, timestampMs: keyframe.timestampMs, geometry: keyframe.geometry }));
    const value = deriveInterpolationAt(trackKeyframes, effectiveFromMs, track.interpolationMode);
    return value ? [value] : [];
  });

  // The before-side is the only boundary query left that can still be
  // capped (the after-side is now an exact, uncapped `trackId IN (...)`
  // lookup -- see above). A capped before-side only risks hiding a genuine
  // straddling track when something exists after toMs *at all*; if nothing
  // does, no amount of truncating beforeBoundary could have hidden a
  // straddler, and flagging truncated would be a false alarm on an
  // otherwise-complete (and often empty) result.
  const beforeBoundaryTruncated = beforeBoundaryRows.length >= VIDEO_ANNOTATION_LIMITS.tracksPerWindowSafetyCap && anyAfterToMsExists !== null;
  // Keyframes themselves are never silently truncated any more (`hasMore`
  // is the honest signal for that); what's left as a flat, non-paginated
  // safety cap is temporal labels and the before-boundary lookup.
  // `relevantTrackIds.length > tracks.length` is kept as a defensive check
  // only -- `tracksFetchCap` above makes it provably unreachable today.
  const truncated =
    hasMore ||
    temporalLabelRows.length >= VIDEO_ANNOTATION_LIMITS.temporalLabelsPerWindowSafetyCap ||
    beforeBoundaryTruncated ||
    relevantTrackIds.length > tracks.length;

  return {
    ok: true,
    data: {
      assetId,
      durationMs: asset.durationMs ?? null,
      fps: asset.videoAsset?.fps ?? null,
      tracks: safeTracks,
      keyframes: safeKeyframes,
      temporalLabels: safeTemporalLabels,
      interpolation,
      totalTracksInWindow: distinctTracksInWindow.length,
      totalKeyframesInWindow,
      truncated,
      effectiveFromMs,
      effectiveToMs,
      nextCursor,
      hasMore,
    },
  };
}

// Defensive only, mirroring `readVideoAnnotationsClient`'s own cap
// (apps/web/src/lib/workspace/video-annotation-client.ts) -- a real window's
// page count is bounded by its span and realistic keyframe density, nowhere
// near this.
const MAX_PAGES_PER_WINDOW = 500;

/**
 * Server-side counterpart to `readVideoAnnotationsClient`: fetches every
 * page of one `[fromMs, toMs]` window and merges them (deduped by id) so a
 * caller that needs a *complete* window server-side (currently just
 * `workspace-read.ts`'s initial-load path for a short-enough video) never
 * has to settle for `readVideoAnnotations`'s single, `keyframesPerPage`-
 * bounded page. Every underlying call stays a bounded, validated read; this
 * never asks the database for an unbounded result set in one query.
 */
export async function readVideoAnnotationsFullyPaged(actor: RequestActor, assetId: string, window: { fromMs: number; toMs: number }): Promise<VideoReadOutcome> {
  const tracks = new Map<string, SafeVideoAnnotations["tracks"][number]>();
  const keyframes = new Map<string, SafeVideoAnnotations["keyframes"][number]>();
  let cursor: string | undefined;
  let firstPage: SafeVideoAnnotations | null = null;
  let page: SafeVideoAnnotations | null = null;
  let pageCount = 0;
  for (;;) {
    if (pageCount >= MAX_PAGES_PER_WINDOW) throw new Error("Video annotation window exceeded the page-count safety limit -- this indicates a server-side pagination bug, not a real window size.");
    const outcome = await readVideoAnnotations(actor, assetId, { ...window, cursor });
    if (!outcome.ok) return outcome;
    page = outcome.data;
    firstPage ??= page;
    for (const track of page.tracks) tracks.set(track.id, track);
    for (const keyframe of page.keyframes) keyframes.set(keyframe.id, keyframe);
    cursor = page.nextCursor ?? undefined;
    pageCount++;
    if (!page.hasMore) break;
  }
  return { ok: true, data: { ...page, tracks: [...tracks.values()], keyframes: [...keyframes.values()], interpolation: firstPage.interpolation, nextCursor: null, hasMore: false } };
}
