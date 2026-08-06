"use client";

import type { SafeAnnotation } from "@/lib/annotations/safe-annotation";

export type AnnotationChangeSetRequest = {
  creates?: Array<{ id: string; type: "BOUNDING_BOX" | "POLYGON" | "CIRCLE" | "POINT" | "POLYLINE"; geometry: unknown; labelId?: string | null }>;
  updates?: Array<{ id: string; revision: number; geometry?: unknown; labelId?: string | null }>;
  deletes?: Array<{ id: string; revision: number }>;
};

export type AnnotationApiResult =
  | { ok: true; annotations: SafeAnnotation[] }
  | { ok: false; code: string; conflict: boolean };

/** Optional browser refresh adapter. Initial workspace reads stay server-side. */
export async function getAssetAnnotations(assetId: string): Promise<AnnotationApiResult> {
  const response = await fetch(`/api/assets/${assetId}/annotations`, { credentials: "same-origin", cache: "no-store" });
  const payload = await response.json().catch(() => null) as { data?: { annotations?: SafeAnnotation[] }; error?: { code?: string } } | null;
  if (!response.ok || !payload?.data?.annotations) {
    const code = payload?.error?.code ?? "INVALID_REQUEST";
    return { ok: false, code, conflict: code === "ANNOTATION_REVISION_CONFLICT" };
  }
  return { ok: true, annotations: payload.data.annotations };
}

export async function putAssetAnnotations(assetId: string, changeSet: AnnotationChangeSetRequest): Promise<AnnotationApiResult> {
  const response = await fetch(`/api/assets/${assetId}/annotations`, {
    method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(changeSet),
  });
  const payload = await response.json().catch(() => null) as { data?: { annotations?: SafeAnnotation[] }; error?: { code?: string } } | null;
  if (!response.ok || !payload?.data?.annotations) {
    const code = payload?.error?.code ?? "INVALID_REQUEST";
    return { ok: false, code, conflict: code === "ANNOTATION_REVISION_CONFLICT" };
  }
  return { ok: true, annotations: payload.data.annotations };
}
