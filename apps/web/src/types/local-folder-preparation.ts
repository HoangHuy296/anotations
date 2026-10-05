/** Public preparation identity. Persistence/replay evidence is deliberately internal. */
export interface LocalFolderPreparationDto {
  id: string;
  datasetId: string;
  jobId: string;
  expectedItemCount: number;
  deadlineAt: string;
  items: Array<{ id: string }>;
}
