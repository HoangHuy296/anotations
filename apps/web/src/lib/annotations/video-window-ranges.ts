/**
 * Framework-free interval bookkeeping for `VideoEngine`'s windowed
 * annotation loading -- tracks which `[fromMs, toMs]` spans of the timeline
 * have already been fetched from `readVideoAnnotationsClient`, so scrubbing
 * back into an already-loaded span never re-requests it, and playback
 * approaching an unloaded edge knows exactly which new span to ask for.
 */

export type TimeRange = { fromMs: number; toMs: number };

/**
 * True when `ms` sits at least `marginMs` inside some covered range -- the
 * margin is what lets a caller refetch *before* actually running out of
 * loaded data, not after. An edge that already touches the true start (0) or
 * end (`durationMs`) of the timeline is exempt from its own margin
 * requirement -- there is nothing earlier/later to preload, so treating "the
 * range starts at 0" as "not covered near 0 until 8s of margin exists" would
 * force a redundant refetch of data already in hand.
 */
export function isCovered(ranges: readonly TimeRange[], ms: number, marginMs = 0, durationMs: number | null = null): boolean {
  return ranges.some((range) => {
    if (ms < range.fromMs || ms > range.toMs) return false;
    const atStart = range.fromMs <= 0;
    const atEnd = durationMs !== null && range.toMs >= durationMs;
    return (atStart || ms - range.fromMs >= marginMs) && (atEnd || range.toMs - ms >= marginMs);
  });
}

/** Inserts `next`, merging with any overlapping or touching ranges. Ranges stay sorted and non-overlapping. */
export function mergeRange(ranges: readonly TimeRange[], next: TimeRange): TimeRange[] {
  const sorted = [...ranges, next].sort((a, b) => a.fromMs - b.fromMs);
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, range.toMs);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * The window to request so that `ms` ends up covered with `marginMs` of
 * preload on both sides, clamped to `[0, durationMs]` when the duration is
 * known. Does not consult already-loaded ranges -- callers check `isCovered`
 * first and only call this when a fetch is actually needed.
 */
export function windowAround(ms: number, spanMs: number, marginMs: number, durationMs: number | null): TimeRange {
  const fromMs = Math.max(0, ms - marginMs);
  const toMsRaw = ms + spanMs + marginMs;
  const toMs = durationMs !== null && durationMs > 0 ? Math.min(toMsRaw, durationMs) : toMsRaw;
  return { fromMs, toMs: Math.max(toMs, fromMs + 1) };
}

/** 0 when `ms` is inside `range`, otherwise the gap to its nearest edge -- used to rank loaded windows for cache eviction (farthest from the playhead goes first). */
export function distanceFromRange(ms: number, range: TimeRange): number {
  if (ms < range.fromMs) return range.fromMs - ms;
  if (ms > range.toMs) return ms - range.toMs;
  return 0;
}
