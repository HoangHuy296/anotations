import { randomUUID } from "node:crypto";

/** Test-only safe fixture data; it deliberately has no credential or URL. */
export function buildRepositoryJobInput(overrides: Record<string, unknown> = {}) {
  return {
    source: {
      repository: { provider: "GITEA", owner: "fixture", repo: "images", ref: "main", rootPath: null, visibility: "PUBLIC" },
      manifest: { itemCount: 1, declaredBytes: 12 },
      sourceConnectionId: null,
    },
    ...overrides,
  };
}

export function isolatedMirrorPrefix(datasetId = randomUUID()) {
  return `repository-imports/${datasetId}/`;
}
