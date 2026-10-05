import { z } from "zod";

export const datasetModalities = ["IMAGE", "VIDEO", "AUDIO", "TEXT"] as const;
export const datasetModalitySchema = z.enum(datasetModalities);
export type DatasetModality = z.infer<typeof datasetModalitySchema>;
export const datasetModalityStateSchema = z.union([
  z.object({ modality: datasetModalitySchema, modalityResolution: z.literal("RESOLVED") }).strict(),
  z.object({ modality: z.null(), modalityResolution: z.enum(["EMPTY_UNRESOLVED", "MIXED_UNRESOLVED", "SINGLE_UNRESOLVED"]) }).strict(),
]);
export type DatasetModalityState = z.infer<typeof datasetModalityStateSchema>;
export const datasetModalityResolutionInputSchema = z.object({ modality: datasetModalitySchema }).strict();
export const datasetModalityReceiptSchema = z.object({
  id: z.string().min(1),
  modality: datasetModalitySchema,
  modalityResolution: z.literal("RESOLVED"),
  resolvedAt: z.iso.datetime(),
}).strict();
export type DatasetModalityReceipt = z.infer<typeof datasetModalityReceiptSchema>;

/** All belonging Assets describe unresolved history; they never select an engine. */
export function projectDatasetModality(modality: DatasetModality | null, belongingModalities: readonly DatasetModality[]): DatasetModalityState {
  if (modality !== null) return { modality, modalityResolution: "RESOLVED" };
  const count = new Set(belongingModalities).size;
  return { modality: null, modalityResolution: count === 0 ? "EMPTY_UNRESOLVED" : count === 1 ? "SINGLE_UNRESOLVED" : "MIXED_UNRESOLVED" };
}
export class DatasetModalityError extends Error {
  constructor(readonly code: "DATASET_MODALITY_UNRESOLVED" | "ASSET_MODALITY_MISMATCH" | "DATASET_MODALITY_IMMUTABLE") { super(code); }
}
export function assertAssetModality(datasetModality: DatasetModality | null, assetModality: DatasetModality): void {
  if (datasetModality === null) throw new DatasetModalityError("DATASET_MODALITY_UNRESOLVED");
  if (assetModality !== datasetModality) throw new DatasetModalityError("ASSET_MODALITY_MISMATCH");
}
export function datasetWorkspaceEngine(state: DatasetModalityState): DatasetModality | null {
  return state.modality; // Pure contract only: G2 does not wire workspace routing.
}
/** Authority only. Read projections must also check EMPTY_UNRESOLVED eligibility. */
export function canResolveEmptyDataset(actor: { id: string; role: string }, ownerId: string): boolean {
  return actor.id === ownerId || actor.role === "ADMIN";
}
// Prisma 6.19.3 classic engine emits some deadlocks as UnknownRequestError:
// the nested PostgresError is Rust diagnostic text, NOT a JS cause object.
// Pin the observed wrapper/version and parse the entire final diagnostic. Never
// retry merely because arbitrary SQL/user text contains a SQLSTATE or "deadlock".
const rustString = '"(?:[^"\\\\\\r\\n]|\\\\(?:["\\\\nrt0]|u\\{[0-9a-fA-F]+\\}))*"';
const rustOptionalString = `(?:None|Some\\(${rustString}\\))`;
const postgresConflictDiagnostic = new RegExp(
  '^ConnectorError\\(ConnectorError \\{ user_facing_error: None, kind: QueryError\\(PostgresError \\{ code: "(40P01)", message: ("deadlock detected"), severity: "ERROR", detail: ' +
  rustOptionalString + ', column: None, hint: ' + rustOptionalString +
  ' \\}\\), transient: false \\}\\)$',
);
export function isModalityTransactionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "P2034") return true;
  if (!(error instanceof Error) || !("clientVersion" in error) || error.clientVersion !== "6.19.3") return false;
  // Empirically verified by the isolated SELECT FOR UPDATE serialization test.
  if (error.name === "PrismaClientKnownRequestError" && "code" in error && error.code === "P2010" && "meta" in error) {
    const meta = error.meta;
    return Boolean(meta && typeof meta === "object" && "code" in meta && (meta.code === "40P01" || meta.code === "40001"));
  }
  if (error.name !== "PrismaClientUnknownRequestError" || "code" in error || "cause" in error || "meta" in error) return false;
  const marker = "Error occurred during query execution:\n";
  const start = error.message.indexOf(marker);
  if (start < 0 || start !== error.message.lastIndexOf(marker)) return false;
  const match = postgresConflictDiagnostic.exec(error.message.slice(start + marker.length));
  return Boolean(match);
}
/** Only retry complete serializable transactions; never retry permission/integrity faults. */
export async function retryModalityTransaction<T>(operation: () => Promise<T>, maxAttempts = 3): Promise<T> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new RangeError("Invalid transaction retry bound");
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!isModalityTransactionConflict(error) || attempt + 1 >= maxAttempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}
