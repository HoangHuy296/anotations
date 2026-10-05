export class VisualizationClientError extends Error {
  constructor(public status: number, public code: string) { super("Visualization data could not be loaded."); }
}
/** Only same-origin GET reads. No source API, mutation methods, or persistent cache. */
export async function visualizationFetch(path: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(path, { method: "GET", credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new VisualizationClientError(response.status, body?.error?.code ?? "UNAVAILABLE");
  }
  return response;
}

/** Clear visible records/media before changing routes after a failed guard. */
export function handleVisualizationAccessError(error: unknown, datasetId: string, clear: () => void, replace: (path: string) => void): boolean {
  if (!(error instanceof VisualizationClientError) || !(error.code === "DATASET_NOT_COMPLETED" || error.status === 401 || error.status === 403 || error.code === "DATASET_NOT_FOUND")) return false;
  clear();
  replace(error.code === "DATASET_NOT_COMPLETED" ? `/workspace/${datasetId}` : "/datasets");
  return true;
}
