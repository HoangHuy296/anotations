import { apiError } from "@/lib/api-response";

/**
 * Compatibility tombstone for the retired image-content endpoint. Source
 * binaries are only available through authorized Asset view capabilities;
 * this route must never resolve repository or object-storage data.
 */
export async function GET() {
  return apiError(410, "IMAGE_CONTENT_DEPRECATED", "This endpoint is no longer available.");
}
