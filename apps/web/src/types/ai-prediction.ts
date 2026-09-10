export type AiPredictionPreview = {
  index: number;
  assetId: string;
  labelKey: string;
  confidence: number;
  geometry: { x: number; y: number; width: number; height: number };
  saved: boolean;
};
export type AiPredictionResults = { taskId: string | null; predictions: AiPredictionPreview[] };
