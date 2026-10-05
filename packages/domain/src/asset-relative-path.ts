/**
 * Canonical Asset.relativePath normalization contract (specs/027-coco-dataset-export
 * §4, §10). One function, used identically by every producer of a
 * relativePath value: folder import, repository import, plain upload, the
 * eventual Step A backfill script, and runtime conflict detection. This is
 * deliberately the *only* place NFKC/path-syntax normalization happens --
 * the Step B trigger (specs/027-coco-dataset-export §6) never re-implements
 * any of this; it only compares two already-normalized column values.
 *
 * Normalization is syntax-only. Case is preserved; identity is
 * case-sensitive (§4 correction -- an earlier draft proposed case-folding
 * and was rejected: a repository or folder may legitimately contain both
 * `Cat.jpg` and `cat.jpg`, and folding them would manufacture a collision
 * that does not exist in the source).
 *
 * Normative operation order (do not reorder -- later steps assume earlier
 * ones already ran):
 *   1. Unicode-normalize to NFKC.
 *   2. Replace every `\` with `/`.
 *   3. Strip leading and trailing `/` (no absolute path).
 *   4. Split on `/`.
 *   5. Reject (return null) if any segment is empty, `.`, or `..`. Empty
 *      segments are what a duplicate separator (`a//b`) produces after the
 *      split, so this is also how duplicate separators are handled:
 *      REJECTED, never silently collapsed. An explicit rejection beats
 *      guessing intent, and matches the existing `normalizeRepositoryPath`
 *      precedent (apps/worker/src/jobs/source-fingerprint.ts), extended here
 *      to every relativePath producer instead of only repository import.
 *   6. Reject if the result is empty (nothing left after stripping/splitting).
 *   7. Reject if the result exceeds 1024 characters (matches the existing
 *      `Dataset.sourceRootPath`/`rootPath` bound).
 *   8. Return the validated, joined string -- case exactly as given.
 *
 * This function performs no I/O and touches no database column; it is pure
 * and safe to unit-test in isolation (packages/domain/tests/asset-relative-path.test.ts).
 */
export function normalizeAssetRelativePath(rawPath: string): string | null {
  const nfkc = rawPath.normalize("NFKC").replaceAll("\\", "/");
  const trimmed = nfkc.replace(/^\/+|\/+$/g, "");
  if (trimmed.length === 0) return null;
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
  if (trimmed.length > 1024) return null;
  return trimmed;
}
