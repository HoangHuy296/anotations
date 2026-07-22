import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { UserRole } from "@internal/db";

import { DATASET_ROLE_PERMISSIONS, type DatasetPermission, requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { createFixture, hasIntegrationDatabase } from "./helpers";

const permissions: DatasetPermission[] = [
  "dataset.read", "dataset.update", "dataset.delete", "member.manage", "asset.upload", "asset.delete", "label.manage", "annotation.create", "annotation.updateOwn", "annotation.updateAny", "annotation.review", "repository.sync", "job.createExport", "job.cancel", "job.retry",
];

const roles = ["owner", "manager", "reviewer", "labeler"] as const;
const policyRole = { owner: "OWNER", manager: "MANAGER", reviewer: "REVIEWER", labeler: "LABELER" } as const;

test("mandatory dataset role matrix resolves allow=200, member denial=403, outsider=404", { skip: !hasIntegrationDatabase }, async () => {
  const fixture = await createFixture();
  let adminId: string | undefined;
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

    const admin = await db.user.create({
      data: {
        email: `admin-${Date.now()}-${randomBytes(5).toString("hex")}@phase009.test`,
        name: "phase009-admin",
        role: UserRole.ADMIN,
      },
      select: { id: true, email: true, name: true, role: true },
    });
    adminId = admin.id;
    const adminRetry = await requireDatasetPermission(
      { ...admin, name: admin.name ?? admin.email },
      fixture.datasetId,
      "job.retry",
    );
    assert.equal(adminRetry?.forbidden, false, "system admin job.retry without Dataset membership");
  } finally {
    if (adminId) await db.user.delete({ where: { id: adminId } });
    await fixture.cleanup();
  }
});
