import { RepoProvider } from "@internal/db";
import { z } from "zod";

import { datasetIdSchema } from "@/lib/validation/dataset";

export const sourceConnectionCreateSchema = z.object({
  provider: z.literal(RepoProvider.GITEA),
  name: z.string().trim().min(1).max(80).optional(),
  baseUrl: z.string().trim().min(1).max(2048),
  token: z.string().min(1).max(4096),
}).strict();

export const sourceConnectionIdSchema = z.string().cuid();

export const sourceImportSafetySchema = z.object({
  rootPath: z.string().max(4096),
  itemCount: z.number().int().nonnegative(),
  declaredBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().optional(),
}).strict();

/**
 * Public request DTO for the narrow source-backed Job creation boundary.
 * It deliberately accepts a repository identity, never a provider URL or any
 * credential. The server reads the actual connection and its address itself.
 */
export const createSourceImportJobSchema = z.object({
  datasetId: datasetIdSchema,
  sourceConnectionId: sourceConnectionIdSchema.nullable(),
  repository: z.object({
    provider: z.literal(RepoProvider.GITEA),
    owner: z.string().trim().min(1).max(160),
    repo: z.string().trim().min(1).max(160),
    branch: z.string().trim().min(1).max(255),
    rootPath: z.string().max(4096),
    visibility: z.enum(["PUBLIC", "PRIVATE"]),
  }).strict(),
  manifest: z.object({
    itemCount: z.number().int().nonnegative(),
    declaredBytes: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative().optional(),
  }).strict(),
  retryOfJobId: z.union([z.string().cuid(), z.string().uuid()]).optional(),
}).strict().superRefine((value, context) => {
  if (value.repository.visibility === "PRIVATE" && !value.sourceConnectionId) {
    context.addIssue({
      code: "custom",
      path: ["sourceConnectionId"],
      message: "A private source requires a source connection.",
    });
  }
  if (value.repository.visibility === "PUBLIC" && value.sourceConnectionId !== null) {
    context.addIssue({
      code: "custom",
      path: ["sourceConnectionId"],
      message: "A public source must not select a credentialed connection.",
    });
  }
});
