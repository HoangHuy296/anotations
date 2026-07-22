import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { readAuthorizedJob } from "@/lib/jobs/authorization";
import {
  encodeSafeJobEventCursor,
  parseSafeJobEventCursor,
  safeJobEventLimitSchema,
  safeJobEventMessages,
  toSafeJobEvent,
} from "@/lib/jobs/safe-job-event";

export const dynamic = "force-dynamic";

const notFound = () => apiError(404, "JOB_NOT_FOUND", "The job was not found.");

/** Returns newest-first safe operational history; raw JobEvent.data never leaves the server. */
export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");

  const { jobId } = await context.params;
  const access = await readAuthorizedJob(actor, jobId);
  if (!access.ok) return access.status === 403
    ? apiError(403, "FORBIDDEN", "You do not have permission to read this job.")
    : notFound();

  const url = new URL(request.url);
  const limit = safeJobEventLimitSchema.safeParse(url.searchParams.get("limit") ?? undefined);
  const cursor = parseSafeJobEventCursor(url.searchParams.get("cursor"));
  if (!limit.success || (url.searchParams.has("cursor") && !cursor)) {
    return apiError(400, "INVALID_REQUEST", "The event cursor or limit is invalid.");
  }

  const events = await db.jobEvent.findMany({
    where: {
      jobId: access.job.id,
      // Omit unknown persisted event kinds before pagination so an internal
      // event cannot consume a browser page or influence cursor progress.
      message: { in: [...safeJobEventMessages] },
      ...(cursor ? {
        OR: [
          { createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
        ],
      } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit.data + 1,
    select: { id: true, createdAt: true, level: true, stage: true, message: true, data: true },
  });

  // Defense in depth: mapper still rejects any unexpected persisted value.
  // Fetching one extra row determines whether a stable next cursor exists.
  const scannedPage = events.slice(0, limit.data);
  const visible = scannedPage.flatMap((event) => {
    const safe = toSafeJobEvent(event);
    return safe ? [safe] : [];
  });
  const pageHasMore = events.length > limit.data;
  const last = scannedPage.at(-1);
  return apiSuccess({
    events: visible,
    nextCursor: pageHasMore && last
      ? encodeSafeJobEventCursor({ id: last.id, createdAt: last.createdAt.toISOString() })
      : null,
  });
}
