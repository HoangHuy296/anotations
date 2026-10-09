import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { readVerificationStatus } from "@/lib/media-verification/status";

export const dynamic = "force-dynamic";

const verificationIdSchema = z.string().uuid();

/** Poll one upload verification. HTTP 200 for every recorded state; a foreign or unknown id is 404 (never distinguishable). */
export async function GET(_request: Request, context: { params: Promise<{ verificationId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const { verificationId } = await context.params;
  const parsed = verificationIdSchema.safeParse(verificationId);
  if (!parsed.success) return apiError(404, "UPLOAD_VERIFICATION_NOT_FOUND", "The upload verification was not found.");
  const dto = await readVerificationStatus(actor, parsed.data);
  if (!dto) return apiError(404, "UPLOAD_VERIFICATION_NOT_FOUND", "The upload verification was not found.");
  return apiSuccess(dto);
}
