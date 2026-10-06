/** Shared by the maintenance rehearsal's seed, object-mutation and check steps: the deterministic object bytes for every fixture Asset. */
import { createHash } from "node:crypto";

export type FixtureAsset = { modality?: "IMAGE" | "VIDEO" | "AUDIO" | "TEXT"; upload?: boolean; size?: number | null; recordedSize?: number | null; etag?: "real" | "wrong"; bucket?: "foreign" };
export type FixtureDataset = { id: string; assets?: FixtureAsset[]; primary?: string };

export const PRIMARY_BUCKET_SUFFIX = "";
/** Content of an object. `orig` is what was seeded; `other` has the SAME length but different bytes (so a stat shows the same size and a different ETag). */
export function objectBytes(assetId: string, size: number, variant: "orig" | "other" = "orig"): Buffer {
  const digest = createHash("sha256").update(`${variant}:${assetId}`).digest();
  return Buffer.from(Array.from({ length: size }, (_, index) => digest[index % digest.length]));
}
export const objectKey = (assetId: string) => `mn/${assetId}`;
export const assetIdOf = (datasetId: string, index: number) => `${datasetId}-a${index}`;

// Dataset ids sort in this order (ascending id): the apply order. The mutation targets sit mid-order on purpose.
export const DATASETS: FixtureDataset[] = [
  // Eligible; no recorded ETag (the applicable historical case: nothing to compare beyond existence and size)
  { id: "mn-a-image", assets: [{}, {}] }, { id: "mn-b-video", assets: [{ modality: "VIDEO" }] }, { id: "mn-c-audio", assets: [{ modality: "AUDIO" }] }, { id: "mn-d-text", assets: [{ modality: "TEXT" }] },
  // Eligible; a real recorded ETag that must match
  { id: "mn-e-etag-match", assets: [{ etag: "real" }] },
  // Eligible now, mutated in storage between approval and execution
  { id: "mn-m-mutate-size", assets: [{}] }, { id: "mn-n-mutate-etag", assets: [{ etag: "real" }] }, { id: "mn-o-mutate-missing", assets: [{}] },
  // Eligible but NOT approved: must stay untouched
  { id: "mn-p-unapproved", assets: [{}] },
  // Eligible, after the mutation targets (NOT_ATTEMPTED while the run is stopped); legacy primaryModality disagrees with the Asset
  { id: "mn-q-last", assets: [{}] }, { id: "mn-y-primary", primary: "IMAGE", assets: [{ modality: "AUDIO" }] },
  // Rejected by T029 with a real storage observation
  { id: "mn-r-missing", assets: [{ upload: false }] }, { id: "mn-s-size-mismatch", assets: [{ recordedSize: 99 }] }, { id: "mn-t-etag-mismatch", assets: [{ etag: "wrong" }] },
  // Rejected before any storage read
  { id: "mn-u-bucket-foreign", assets: [{ bucket: "foreign", upload: false }] }, { id: "mn-v-size-unrecorded", assets: [{ recordedSize: null }] }, { id: "mn-w-empty" }, { id: "mn-x-mixed", assets: [{}, { modality: "AUDIO" }] },
];
export const EXPECTED_CANDIDATES = ["mn-a-image", "mn-b-video", "mn-c-audio", "mn-d-text", "mn-e-etag-match", "mn-m-mutate-size", "mn-n-mutate-etag", "mn-o-mutate-missing", "mn-p-unapproved", "mn-q-last", "mn-y-primary"];
export const APPROVED = EXPECTED_CANDIDATES.filter(id => id !== "mn-p-unapproved");
export const EXPECTED_REJECTED: Record<string, string> = {
  "mn-r-missing": "OBJECT_MISSING", "mn-s-size-mismatch": "SIZE_MISMATCH", "mn-t-etag-mismatch": "ETAG_MISMATCH", "mn-u-bucket-foreign": "BUCKET_NOT_APPROVED",
  "mn-v-size-unrecorded": "SIZE_UNRECORDED", "mn-w-empty": "EMPTY_DATASET", "mn-x-mixed": "MIXED_MODALITY",
};
