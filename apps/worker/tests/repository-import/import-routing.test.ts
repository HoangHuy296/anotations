import assert from "node:assert/strict";
import test from "node:test";

import { processImportDataset } from "../../src/jobs/import-dataset.js";

test("local-folder PreparedImport jobs retain the receipt-only worker path", async () => {
  const db = {
    preparedImport: { findUnique: async () => ({ id: "prepared", status: "PREPARING" }) },
  };
  const result = await processImportDataset(db as never, "job", "lock");
  assert.deepEqual(result, { kind: "local-receipt" });
});

test("ordinary IMPORT_DATASET rows are not treated as repository work", async () => {
  const db = {
    preparedImport: { findUnique: async () => null },
    job: { findUnique: async () => ({ id: "job", datasetId: "dataset", createdById: "owner", input: {}, sourceConnectionId: null, dataset: { sourceMode: "UPLOAD" } }) },
  };
  const result = await processImportDataset(db as never, "job", "lock");
  assert.deepEqual(result, { kind: "not-applicable" });
});
