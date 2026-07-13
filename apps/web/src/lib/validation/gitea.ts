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
  owner: repositorySegment,
  repo: repositorySegment,
  branch: z.string().trim().min(1).max(255),
  rootPath: z.string().trim().max(1024).default(""),
  name: z.string().trim().min(2).max(80),
  mode: z.enum(["preview", "persist"]).default("preview"),
});

export function normalizeRepositoryPath(path: string) {
  if (path.includes("\0") || path.startsWith("/") || path.startsWith("\\")) {
    return null;
  }

  const segments = path
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean);

  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }

  return segments.join("/");
}
