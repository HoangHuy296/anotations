import type { TextSourceReadOutcome } from "@/lib/annotations/text-source-read-service";
import type { TextSourcePrepareRequestOutcome } from "@/lib/annotations/text-source-prepare-service";

/**
 * The HTTP-status-selection logic for `GET /api/assets/{assetId}/text` and
 * `POST /api/assets/{assetId}/text/prepare` — the only genuinely route-
 * specific logic in either route (everything else is a direct pass-through
 * of the T028/T038 service outcome). Extracted into pure functions so it is
 * directly unit-testable: this Next.js version's Route Handlers call
 * `cookies()` via `getRequestActor()`, which throws "called outside a
 * request scope" when invoked outside a real server request (confirmed with
 * a throwaway smoke test), so the exported route functions themselves
 * cannot be exercised in this repo's `node --test` environment.
 */

export function mapTextSourceReadOutcomeToHttp(outcome: TextSourceReadOutcome): { status: number } {
  return outcome.ok ? { status: 200 } : { status: 404 };
}

export function mapTextSourcePrepareOutcomeToHttp(outcome: TextSourcePrepareRequestOutcome): { status: number; ready: boolean } {
  if (!outcome.ok) return { status: outcome.reason === "SOURCE_UNAVAILABLE" ? 409 : 404, ready: false };
  const ready = outcome.job.status === "COMPLETED";
  return { status: ready ? 200 : 202, ready };
}
