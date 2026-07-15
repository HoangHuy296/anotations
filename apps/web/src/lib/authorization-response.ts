import { apiError } from "@/lib/api-response";
export const authRequired = () => apiError(401, "AUTH_REQUIRED", "Authentication is required.");
export const forbidden = () => apiError(403, "FORBIDDEN", "You do not have permission for this action.");
export const hiddenNotFound = () => apiError(404, "GITEA_NOT_FOUND", "The requested resource was not found.");
