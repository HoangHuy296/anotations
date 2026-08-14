/**
 * Shared, named tuning constants for the AI submit/poll pipeline. Kept in
 * one place so nothing in ai-submit.processor.ts, ai-poll.processor.ts, or
 * job-lock.ts hardcodes a scattered magic-number literal.
 */

/** Initial delay before the first re-poll after a PENDING/IN_PROGRESS result. */
export const POLL_BASE_DELAY_MS = 2_000;

/** Ceiling on the exponentially-backed-off delay between poll steps. */
export const POLL_MAX_DELAY_MS = 30_000;

/** Multiplier applied to the previous delay on every non-terminal poll result. */
export const POLL_BACKOFF_FACTOR = 2;

/** Poll-count budget: exceeding this many attempts trips the timeout path (FR-010). */
export const MAX_POLL_ATTEMPTS = 60;

/** Wall-clock budget since AiTask.createdAt: exceeding this trips the timeout path (FR-010). */
export const MAX_POLL_DURATION_MS = 15 * 60 * 1000;

/**
 * Extra time added on top of the computed poll delay when renewing the Job
 * lock after a non-terminal poll step, so the lease comfortably outlives the
 * gap until the next scanner-driven poll tick is due — never a race between
 * "lease about to expire" and "next tick hasn't fired yet".
 */
export const LOCK_RENEWAL_BUFFER_MS = 30_000;
