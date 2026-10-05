import "server-only";
import { currentPreview, artifactBytes } from "@/lib/visualization/snapshot-read";
import { getWebProviders } from "@/lib/providers";
import { findAsset, supportedImageMimeTypes } from "@/lib/visualization/asset-read";
import { VisualizationReadError } from "@/lib/visualization/dataset-read";

export async function readVisualizationMedia(datasetId: string, assetId: string, variant: "THUMBNAIL" | "PREVIEW" = "PREVIEW") {
  const asset = await findAsset(datasetId, assetId);
  if (!asset) throw new VisualizationReadError(404, "ASSET_NOT_IN_DATASET", "Asset not found in this dataset.");
  try {
    const preview = await currentPreview(datasetId, assetId, variant);
    if (preview) {
      const bytes = await artifactBytes(preview, 5 * 1024 * 1024);
      const stillCurrent = await currentPreview(datasetId, assetId, variant);
      if (stillCurrent?.id === preview.id) return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/webp", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Visualization-Preview": "ready" } });
    }
  } catch { /* A failed derived object never prevents the original-media fallback. */ }
  if (asset.modality !== "IMAGE" || !supportedImageMimeTypes.includes(asset.mimeType)) throw new VisualizationReadError(415, "UNSUPPORTED_MEDIA", "This media format is not supported by the image viewer.");
  if (asset.storageProvider !== "MINIO" || !asset.storageBucket || !asset.storageKey) throw new VisualizationReadError(409, "ASSET_UNAVAILABLE", "Image media is unavailable.");
  try {
    const { minio } = getWebProviders();
    const object = await minio.statObject(asset.storageBucket, asset.storageKey);
    if (object.size > 25 * 1024 * 1024) throw new Error("Image exceeds viewer limit");
    const stream = await minio.getObject(asset.storageBucket, asset.storageKey);
    const iterator = stream[Symbol.asyncIterator]();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await iterator.next();
          if (chunk.done) { controller.close(); return; }
          const value = new Uint8Array(chunk.value);
          bytes += value.byteLength;
          if (bytes > 25 * 1024 * 1024) throw new Error("Image exceeds viewer limit");
          controller.enqueue(value);
        } catch { stream.destroy(); controller.error(new Error("Image media is unavailable.")); }
      },
      cancel() { stream.destroy(); },
    });
    return new Response(body, { headers: {
      "Content-Type": asset.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-origin",
    } });
  } catch {
    throw new VisualizationReadError(409, "ASSET_UNAVAILABLE", "Image media is unavailable.");
  }
}
