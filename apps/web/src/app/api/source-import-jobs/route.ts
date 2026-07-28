import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * Phase 015 keeps a single public durable Dataset creation boundary:
 * `POST /api/datasets/from-repository`. This retired endpoint must not retain
 * a second adapter for Dataset/Job creation.
 */
export async function POST() {
  return apiError(
    410,
    "SOURCE_IMPORT_JOBS_DEPRECATED",
    "Use /api/datasets/from-repository for repository Dataset imports.",
  );
}
