import { apiError } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * Retired legacy repository-byte endpoint.
 *
 * Repository imports are mirrored by the private worker into MinIO before an
 * Asset becomes viewable. Browser clients must use the authorized Asset
 * view-capability route instead: `/api/assets/[assetId]/view-url`. Keeping
 * this endpoint as a safe 410 prevents a fallback that could fetch binary
 * bytes from a provider or local cache through the Next.js process.
 */
export async function GET() {
  return apiError(
    410,
    "IMAGE_CONTENT_DEPRECATED",
    "Use the authorized asset view URL instead.",
  );
}
