import "server-only";

import { db } from "@/lib/db";

/** Only this user's usable saved connections; never project credentials or URLs. */
export async function getGiteaConnectionCount(userId: string): Promise<number | null> {
  try {
    return await db.sourceConnection.count({
      where: {
        userId, provider: "GITEA", status: "ACTIVE", revokedAt: null,
        tokenEncrypted: { not: null },
        OR: [{ tokenExpiresAt: null }, { tokenExpiresAt: { gt: new Date() } }],
      },
    });
  } catch {
    return null;
  }
}
