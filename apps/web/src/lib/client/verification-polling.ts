"use client";

export type VerificationView = {
  id: string;
  status: "PENDING" | "VERIFYING" | "VERIFICATION_FAILED" | "PUBLISHED" | "REJECTED" | "STALE" | "CANCELED" | "EXPIRED";
  code?: string;
  reason?: string;
  retryable?: boolean;
  expiresAt: string;
  pollAfterMs?: number;
  asset?: unknown;
};

const TERMINAL = new Set(["PUBLISHED", "REJECTED", "STALE", "CANCELED", "EXPIRED"]);
export const isTerminalVerification = (status: string) => TERMINAL.has(status);

/**
 * Polls `GET /api/uploads/verifications/{id}` with capped backoff until the verification is terminal or its allowance (`expiresAt`) has clearly passed. A `202` from a completion route
 * means "NOT published": nothing may be shown as an Asset before this returns `PUBLISHED`. `VERIFICATION_FAILED` is an operational, retryable view (it keeps polling, more slowly).
 */
export async function pollVerification(verificationId: string, options: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number; maxBackoffMs?: number; graceMs?: number } = {}): Promise<VerificationView> {
  const request = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  let delay = 1_000;
  for (;;) {
    const response = await request(`/api/uploads/verifications/${encodeURIComponent(verificationId)}`, { credentials: "same-origin", cache: "no-store" });
    const payload = await response.json().catch(() => null) as { data?: VerificationView } | null;
    if (!response.ok || !payload?.data) throw new Error("The upload verification could not be read.");
    const view = payload.data;
    if (isTerminalVerification(view.status)) return view;
    if (now() > new Date(view.expiresAt).getTime() + (options.graceMs ?? 60_000)) return view;
    await sleep(Math.min(Math.max(view.pollAfterMs ?? delay, delay), options.maxBackoffMs ?? 8_000));
    delay = Math.min(Math.round(delay * 1.3), options.maxBackoffMs ?? 8_000);
  }
}
