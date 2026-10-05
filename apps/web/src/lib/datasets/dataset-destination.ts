/** Only the explicit dataset lifecycle value selects visualization. */
export function datasetDestination(datasetId: string, workflowStatus: unknown): string {
  return workflowStatus === "COMPLETED"
    ? `/datasets/visualize/${datasetId}`
    : `/workspace/${datasetId}`;
}

export function readDatasetWorkflowStatus(metadata: unknown): "IN_PROGRESS" | "COMPLETED" | "REVIEWED" {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const status = (metadata as Record<string, unknown>).workflowStatus;
    if (status === "COMPLETED" || status === "REVIEWED") return status;
  }
  return "IN_PROGRESS";
}

/** Drop arbitrary metadata before crossing a response or component boundary. */
export function projectDatasetWorkflowStatus<T extends { metadata: unknown }>(dataset: T) {
  const { metadata, ...safe } = dataset;
  return { ...safe, workflowStatus: readDatasetWorkflowStatus(metadata) };
}
