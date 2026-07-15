import assert from "node:assert/strict";
import test from "node:test";

import { DATASET_ROLE_PERMISSIONS, type DatasetPermission, requireDatasetPermission } from "@/lib/authorization";
import { createFixture, hasIntegrationDatabase } from "./helpers";

const permissions: DatasetPermission[] = [
  "dataset.read", "dataset.update", "dataset.delete", "member.manage", "asset.upload", "asset.delete", "label.manage", "annotation.create", "annotation.updateOwn", "annotation.updateAny", "annotation.review", "repository.sync", "job.createExport", "job.cancel",
];

const roles = ["owner", "manager", "reviewer", "labeler"] as const;
const policyRole = { owner: "OWNER", manager: "MANAGER", reviewer: "REVIEWER", labeler: "LABELER" } as const;

test("mandatory dataset role matrix resolves allow=200, member denial=403, outsider=404", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createFixture();
  try {
    for (const permission of permissions) {
      for (const role of roles) {
        const result = await requireDatasetPermission(fixture.actors[role], fixture.datasetId, permission);
        const allowed = DATASET_ROLE_PERMISSIONS[policyRole[role]].includes("*") || DATASET_ROLE_PERMISSIONS[policyRole[role]].includes(permission);
        assert.equal(result ? (result.forbidden ? 403 : 200) : 404, allowed ? 200 : 403, `${role} ${permission}`);
      }
      const outsider = await requireDatasetPermission(fixture.actors.outsider, fixture.datasetId, permission);
      assert.equal(outsider, null, `outsider ${permission}`);
    }
  } finally { await fixture.cleanup(); }
});
