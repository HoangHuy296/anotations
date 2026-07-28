import { createHash } from "node:crypto";

/**
 * A source fingerprint identifies the logical file, independently of its
 * current bytes. Revision/blob identity is retained separately on Asset, so a
 * retry of the same logical file cannot create a second Asset.
 */
export function buildSourceFingerprint(input: {
  provider: "GITHUB" | "GITEA";
  owner: string;
  repository: string;
  path: string;
}) {
  return digest(["fieldframe-source-v1", input.provider, input.owner, input.repository, normalizeRepositoryPath(input.path)]);
}

/** A mirror key is revision-aware but credential-free and scoped to one Dataset. */
export function buildMirrorObjectKey(input: {
  datasetId: string;
  sourceFingerprint: string;
  revision: string;
  providerFileIdentity: string;
}) {
  return `repository-imports/${input.datasetId}/${digest(["fieldframe-mirror-v1", input.sourceFingerprint, input.revision, input.providerFileIdentity])}`;
}

export function normalizeRepositoryPath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Invalid repository path.");
  }
  return normalized;
}

function digest(parts: string[]) {
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");
}
