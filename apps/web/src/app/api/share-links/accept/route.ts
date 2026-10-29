import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { enqueueMembershipDispatches } from "@/lib/collaboration/dataset-membership-service";
import { acceptShareLink, ShareLinkError } from "@/lib/collaboration/share-link-service";
import { shareLinkAcceptSchema } from "@/lib/validation/collaboration";

export const dynamic = "force-dynamic";

/** Joins the signed-in user to the link's dataset. Unknown/expired/revoked links all return the same 400. */
export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const parsed = shareLinkAcceptSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "SHARE_LINK_INVALID", "This share link is not valid.");
  try {
    const joined = await acceptShareLink(actor, parsed.data.token);
    await enqueueMembershipDispatches(joined);
    return apiSuccess({ datasetId: joined.datasetId, alreadyMember: joined.alreadyMember });
  } catch (error) {
    if (error instanceof ShareLinkError) return apiError(400, "SHARE_LINK_INVALID", "This share link is not valid.");
    throw error;
  }
}
