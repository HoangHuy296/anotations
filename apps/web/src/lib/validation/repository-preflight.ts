import { z } from "zod";

const repositorySegment = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/, "Repository identifiers contain unsupported characters.");

const refSchema = z.string().trim().min(1).max(255).regex(/^[^\u0000-\u001f]+$/, "Revision contains unsupported characters.");

export const repositoryPreflightSchema = z
  .object({
    provider: z.enum(["GITHUB", "GITEA"]),
    repository: z.object({
      owner: repositorySegment,
      name: repositorySegment,
      baseUrl: z.string().trim().url().max(2048).optional(),
    }).strict(),
    ref: refSchema.optional(),
    rootPath: z.string().max(1024).optional(),
    // Deliberately not a cuid schema: malformed IDs receive the same concealed
    // outcome as an unknown or foreign connection rather than an ID oracle.
    sourceConnectionId: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.provider === "GITHUB" && value.repository.baseUrl) {
      context.addIssue({ code: "custom", path: ["repository", "baseUrl"], message: "GitHub endpoint selection is server controlled." });
    }
    if (value.provider === "GITHUB" && value.sourceConnectionId) {
      context.addIssue({ code: "custom", path: ["sourceConnectionId"], message: "GitHub credentials are not supported." });
    }
    if (value.provider === "GITEA" && !value.repository.baseUrl && !value.sourceConnectionId) {
      context.addIssue({ code: "custom", path: ["repository", "baseUrl"], message: "A Gitea address or existing connection is required." });
    }
  });

export type RepositoryPreflightRequest = z.infer<typeof repositoryPreflightSchema>;
