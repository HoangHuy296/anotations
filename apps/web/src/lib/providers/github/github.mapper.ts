import "server-only";

import { toPreflightError } from "@/lib/providers/provider-errors";

export function mapGithubFailure(error: unknown, stage: "repository" | "ref" | "root") {
  return toPreflightError(error, stage, false);
}
