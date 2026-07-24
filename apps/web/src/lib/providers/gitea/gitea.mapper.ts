import "server-only";

import { toPreflightError } from "@/lib/providers/provider-errors";

export function mapGiteaFailure(error: unknown, stage: "repository" | "ref" | "root", hasCredential: boolean) {
  return toPreflightError(error, stage, hasCredential);
}
