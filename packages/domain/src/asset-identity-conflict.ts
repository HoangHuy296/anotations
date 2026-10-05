/**
 * The stable, narrow application marker for the Asset.relativePath uniqueness
 * guard (specs/027-coco-dataset-export §6, §11c). Proven by spike, not
 * assumed: a Postgres constraint trigger raising the standard
 * `unique_violation` SQLSTATE surfaces through a typed Prisma
 * `create()`/`update()` call as `PrismaClientKnownRequestError` with
 * `code: "P2002"` and `meta.target === null` -- `target` is `null` precisely
 * because the violated constraint (the trigger) is not one Prisma knows from
 * `schema.prisma` introspection. Every *real*, schema-declared `@unique`/
 * `@@unique` violation on the same model instead gets a populated `target`
 * array (proven against both a single-column and a composite unique in the
 * spike), so this check never misclassifies an unrelated conflict.
 *
 * NOT used yet: no real write path calls this today (specs/027 §10 Step C is
 * not wired into asset-upload.ts / complete-local-folder-item.ts /
 * repository-asset-upsert.ts until the real Asset.relativePath column and
 * Step B trigger exist -- wiring it earlier would reference a database
 * object that does not exist yet). Kept here, tested in isolation, ready for
 * that wiring.
 */

type PrismaLikeError = {
  code?: unknown;
  meta?: { modelName?: unknown; target?: unknown } | null;
};

export function isAssetRelativePathConflict(error: unknown, modelName = "Asset"): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as PrismaLikeError;
  if (candidate.code !== "P2002") return false;
  if (!candidate.meta || typeof candidate.meta !== "object") return false;
  if (candidate.meta.modelName !== modelName) return false;
  return candidate.meta.target === null || candidate.meta.target === undefined;
}
