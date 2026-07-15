import { UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { createFixture, type AuthOwnershipFixture } from "../auth-ownership/helpers";

export async function createDatasetMetadataFixture() {
  const fixture = await createFixture();
  const admin = await db.user.create({ data: { email: `admin-${Date.now()}-${Math.random()}@phase005.test`, role: UserRole.ADMIN }, select: { id: true, email: true, name: true, role: true } });
  const manager = await db.user.create({ data: { email: `manager-${Date.now()}-${Math.random()}@phase005.test`, role: UserRole.MANAGER }, select: { id: true, email: true, name: true, role: true } });
  return {
    fixture,
    admin: { ...admin, name: admin.name ?? admin.email },
    manager: { ...manager, name: manager.name ?? manager.email },
    cleanup: async () => { await fixture.cleanup(); await db.user.deleteMany({ where: { id: { in: [admin.id, manager.id] } } }); },
  };
}

export type DatasetMetadataFixture = Awaited<ReturnType<typeof createDatasetMetadataFixture>> & { fixture: AuthOwnershipFixture };
