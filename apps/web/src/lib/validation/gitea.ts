import { Modality } from "@internal/db";
import { normalizeSourceRootPath } from "@/lib/source-access-policy";
import { z } from "zod";

const repositorySegment = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[A-Za-z0-9_.-]+$/,
    "Repository owner and name may contain letters, numbers, dots, underscores, and hyphens.",
  );

export const repositoryParamsSchema = z.object({
  owner: repositorySegment,
  repo: repositorySegment,
});

export const repositoryListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

export const treeQuerySchema = z.object({
  ref: z.string().trim().min(1).max(255).default("main"),
  path: z.string().trim().max(1024).default(""),
});

export const importPreviewSchema = z.object({
  sourceConnectionId: z.string().cuid(),
  owner: repositorySegment,
  repo: repositorySegment,
  branch: z.string().trim().min(1).max(255),
  rootPath: z.string().trim().max(1024).default(""),
  name: z.string().trim().min(2).max(80),
  // This is the operator's expectation, not a source of truth. The provider
  // response remains authoritative and is checked again before persistence.
  expectedVisibility: z.enum(["PUBLIC", "PRIVATE"]).optional(),
  // UI/default only. Asset modality is determined per candidate and never
  // inferred from Dataset.primaryModality.
  primaryModality: z.union([z.literal(Modality.IMAGE), z.null()]).optional().default(null),
  mode: z.enum(["preview", "persist"]).default("preview"),
});

export const sourceConnectionQuerySchema = z.object({
  sourceConnectionId: z.string().cuid(),
});

export function normalizeRepositoryPath(path: string) {
  const result = normalizeSourceRootPath(path);
  return result.ok ? result.value : null;
}
