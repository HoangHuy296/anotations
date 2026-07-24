import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * The legacy endpoint previously persisted a Dataset and assets directly.
 * Repository imports must now use read-only preflight followed by the durable
 * source-backed Job boundary.
 */
export async function POST() {
  return apiError(410, "GITEA_IMPORT_DEPRECATED", "Use the source import preflight and source import Job endpoints.");
}
