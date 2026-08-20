import { NextResponse } from "next/server";

import { UserRole } from "@internal/db";
import { probeProvider } from "@annotationplatform/domain";

import { getRequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { getWebProviders } from "@/lib/providers";
import { createWebQueue } from "@/lib/queue/bullmq-client";
import { getWebReadiness } from "@/lib/readiness";

export const dynamic = "force-dynamic";

/**
 * 021-production-hardening-garbage-collection, User Story 6.
 *
 * `status`/HTTP-code contract is preserved exactly for existing callers
 * (container health/liveness probes) — see contracts/health-observability.md.
 * The `checks`/`jobs` detail is additive and gated behind the existing
 * `UserRole.ADMIN` elevated role (the same boundary `requireDatasetPermission`
 * already uses for platform-wide actions), so an unauthenticated or
 * non-admin caller still gets only `{ status }`.
 *
 * Known limitation (documented, not silently dropped): a `cleanup` section
 * ("last orphan scan", "last JobEvent retention sweep") is not included.
 * Those scheduled passes run in a separate process (`apps/worker`) and log
 * only to stdout (`logStorageEvent`/`logMaintenanceEvent`) — nothing
 * persists a queryable "last ran at" timestamp today. Adding one would mean
 * a new table purely for this, which is a real migration decision, not
 * something to add silently while extending this route — left for a
 * follow-up if wanted.
 */
export async function GET() {
  const status = await getWebReadiness();
  const actor = await getRequestActor();

  if (!actor || actor.role !== UserRole.ADMIN) {
    return NextResponse.json({ status }, { status: status === "ready" ? 200 : 503 });
  }

  const { minio, config } = getWebProviders();
  const webQueue = createWebQueue();

  try {
    const [postgresCheck, minioCheck, redisCheck] = await Promise.all([
      probeProvider("postgres", async () => { await db.$queryRaw`SELECT 1`; }),
      probeProvider("minio", async () => { await minio.bucketExists(config.MINIO_BUCKET); }),
      probeProvider("redis", async () => { await webQueue.queue.waitUntilReady(); }),
    ]);

    const now = new Date();
    const [active, failed, retrying, stale, deadLettered, queueCounts] = await Promise.all([
      db.job.count({ where: { status: { in: ["RUNNING", "QUEUED", "RETRYING", "CANCELING"] } } }),
      db.job.count({ where: { status: "FAILED" } }),
      db.job.count({ where: { status: "RETRYING" } }),
      db.job.count({ where: { status: "RUNNING", lockedUntil: { not: null, lt: now } } }),
      // attempts >= maxAttempts is a column-to-column comparison Prisma's
      // query builder can't express — raw SQL is the established exception
      // this codebase already uses for exactly this class of query.
      db.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) AS count FROM "Job" WHERE status = 'FAILED' AND attempts >= "maxAttempts"`,
      webQueue.queue.getJobCounts().catch(() => null),
    ]);

    const overallReady = status === "ready" && postgresCheck.ready && minioCheck.ready && redisCheck.ready;
    return NextResponse.json({
      status: overallReady ? "ready" : "not_ready",
      checks: {
        postgres: { ready: postgresCheck.ready },
        redis: { ready: redisCheck.ready },
        minio: { ready: minioCheck.ready },
      },
      jobs: {
        queueBacklog: queueCounts ? (queueCounts.waiting ?? 0) + (queueCounts.delayed ?? 0) : null,
        active,
        failed,
        stale,
        retrying,
        deadLettered: Number(deadLettered[0]?.count ?? 0),
      },
    }, { status: overallReady ? 200 : 503 });
  } finally {
    await webQueue.close().catch(() => undefined);
  }
}
