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

const sourceImportRepositorySchema = z.object({
  owner: z.string().trim().min(1).max(160),
  repo: z.string().trim().min(1).max(160),
  ref: z.string().trim().min(1).max(255),
  rootPath: z.string().max(4096).optional(),
  expectedVisibility: z.enum(["PUBLIC", "PRIVATE"]),
}).strict();

const sourceImportBaseSchema = z.object({
  provider: z.literal(RepoProvider.GITEA),
  datasetName: z.string().trim().min(1).max(160),
  repository: sourceImportRepositorySchema,
  credentialMode: z.enum(["PUBLIC", "EXISTING_SOURCE_CONNECTION", "ONE_TIME_PAT"]),
  sourceConnectionId: z.string().trim().min(1).max(128).optional(),
  serverUrl: z.string().trim().url().max(2048).optional(),
  token: z.string().min(1).max(4096).optional(),
  saveAsSourceConnection: z.boolean().optional(),
  sourceConnectionName: z.string().trim().min(1).max(80).optional(),
}).strict();

/**
 * Browser DTO for read-only source import preflight. Credentials are accepted
 * only for the duration of this HTTP request and are never returned.
 */
export const sourceImportPreflightSchema = sourceImportBaseSchema.superRefine((value, context) => {
  if (value.credentialMode === "PUBLIC") {
    if (!value.serverUrl) context.addIssue({ code: "custom", path: ["serverUrl"], message: "A Gitea server URL is required for public import." });
    if (value.sourceConnectionId || value.token || value.saveAsSourceConnection || value.sourceConnectionName) context.addIssue({ code: "custom", path: ["credentialMode"], message: "Public import cannot include credentials." });
  }
  if (value.credentialMode === "EXISTING_SOURCE_CONNECTION") {
    if (!value.sourceConnectionId) context.addIssue({ code: "custom", path: ["sourceConnectionId"], message: "Select an active source connection." });
    if (value.serverUrl || value.token || value.saveAsSourceConnection || value.sourceConnectionName) context.addIssue({ code: "custom", path: ["credentialMode"], message: "An existing connection supplies its own credentials." });
  }
  if (value.credentialMode === "ONE_TIME_PAT") {
    if (!value.serverUrl) context.addIssue({ code: "custom", path: ["serverUrl"], message: "A Gitea server URL is required." });
    if (!value.token) context.addIssue({ code: "custom", path: ["token"], message: "A personal access token is required." });
    if (value.sourceConnectionId) context.addIssue({ code: "custom", path: ["sourceConnectionId"], message: "Choose one credential mode." });
    if (value.saveAsSourceConnection && !value.sourceConnectionName) context.addIssue({ code: "custom", path: ["sourceConnectionName"], message: "Name the source connection before saving it." });
  }
});

/** Start Import deliberately uses the same strict DTO and re-validates it. */
export const sourceImportStartSchema = sourceImportPreflightSchema;
export type SourceImportRequest = z.infer<typeof sourceImportPreflightSchema>;
