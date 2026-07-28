import { z } from "zod";

const repositorySegment = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/, "Repository identifiers contain unsupported characters.");

const refSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\u0000-\u001f]+$/, "Revision contains unsupported characters.");

function isCanonicalGithubRepositoryUrl(value: string, owner: string, name: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "github.com"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname.replace(/^\/+|\/+$/g, "") === `${owner}/${name}`;
  } catch {
    return false;
  }
}

/**
 * The only public durable request for a new repository-backed Dataset. A PAT
 * is accepted solely for the current server request; it is never retained in
 * a hash, Job input, response, queue payload, or Dataset metadata.
 */
export const repositoryImportRequestSchema = z
  .object({
    provider: z.enum(["GITHUB", "GITEA"]),
    repository: z
      .object({
        owner: repositorySegment,
        name: repositorySegment,
        // Repository identity stays browser-visible and canonical. It is not
        // a provider transport endpoint: GitHub API routing is server-only.
        repoUrl: z.string().trim().url().max(2048).optional(),
        ref: refSchema,
        rootPath: z.string().max(1024).optional(),
        expectedVisibility: z.enum(["PUBLIC", "PRIVATE"]),
      })
      .strict(),
    credentialMode: z.enum(["PUBLIC", "EXISTING_SOURCE_CONNECTION", "ONE_TIME_PAT"]),
    sourceConnectionId: z.string().trim().min(1).max(128).optional(),
    serverUrl: z.string().trim().url().max(2048).optional(),
    personalAccessToken: z.string().min(1).max(4096).optional(),
    saveAsSourceConnection: z.boolean().optional(),
    connectionName: z.string().trim().min(1).max(80).optional(),
    datasetName: z.string().trim().min(1).max(160),
    idempotencyKey: z.string().trim().min(16).max(160),
  })
  .strict()
  .superRefine((value, context) => {
    const hasCredentialFields = Boolean(
      value.sourceConnectionId || value.personalAccessToken || value.saveAsSourceConnection || value.connectionName,
    );

    if (value.provider === "GITHUB") {
      if (value.credentialMode !== "PUBLIC" || value.serverUrl || hasCredentialFields) {
        context.addIssue({ code: "custom", path: ["credentialMode"], message: "GitHub imports support public repositories only." });
      }
      if (!value.repository.repoUrl || !isCanonicalGithubRepositoryUrl(value.repository.repoUrl, value.repository.owner, value.repository.name)) {
        context.addIssue({ code: "custom", path: ["repository", "repoUrl"], message: "Use the canonical https://github.com/owner/repository URL." });
      }
      return;
    }

    if (value.credentialMode === "PUBLIC") {
      if (!value.serverUrl) context.addIssue({ code: "custom", path: ["serverUrl"], message: "A Gitea server URL is required." });
      if (hasCredentialFields) context.addIssue({ code: "custom", path: ["credentialMode"], message: "Public import cannot include credentials." });
    }
    if (value.credentialMode === "EXISTING_SOURCE_CONNECTION") {
      if (!value.sourceConnectionId) context.addIssue({ code: "custom", path: ["sourceConnectionId"], message: "Select an active source connection." });
      if (value.serverUrl || value.personalAccessToken || value.saveAsSourceConnection || value.connectionName) {
        context.addIssue({ code: "custom", path: ["credentialMode"], message: "An existing connection supplies its own credentials." });
      }
    }
    if (value.credentialMode === "ONE_TIME_PAT") {
      if (!value.serverUrl) context.addIssue({ code: "custom", path: ["serverUrl"], message: "A Gitea server URL is required." });
      if (!value.personalAccessToken) context.addIssue({ code: "custom", path: ["personalAccessToken"], message: "A personal access token is required." });
      if (value.sourceConnectionId) context.addIssue({ code: "custom", path: ["sourceConnectionId"], message: "Choose one credential mode." });
      if (value.saveAsSourceConnection === true && !value.connectionName) {
        context.addIssue({ code: "custom", path: ["connectionName"], message: "Name the source connection before saving it." });
      }
    }
  });

export type RepositoryImportRequest = z.infer<typeof repositoryImportRequestSchema>;
