import "server-only";

import { UserRole } from "@internal/db";
import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { datasetDestination, readDatasetWorkflowStatus } from "@/lib/datasets/dataset-destination";
import { datasetIdSchema } from "@/lib/validation/dataset";

/** Fresh reads only: never cache lifecycle eligibility or initialize workspace data. */
export async function readVisualizationAccess(actor: RequestActor | null, datasetId: string) {
  if (!actor || !datasetIdSchema.safeParse(datasetId).success) return { kind: "not-found" } as const;
  const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
  if (!access || access.forbidden) return { kind: "not-found" } as const;
  // Repeat visibility constraints with the current metadata read, including revocation.
  const dataset = await db.dataset.findFirst({
    where: {
      id: datasetId, deletedAt: null, archivedAt: null,
      ...(actor.role === UserRole.ADMIN ? {} : { OR: [{ ownerId: actor.id }, { members: { some: { userId: actor.id } } }] }),
    },
    select: { id: true, name: true, metadata: true },
  });
  if (!dataset) return { kind: "not-found" } as const;
  const status = readDatasetWorkflowStatus(dataset.metadata);
  if (status !== "COMPLETED") return { kind: "redirect", destination: datasetDestination(dataset.id, status) } as const;
  return { kind: "ready", dataset: { id: dataset.id, name: dataset.name } } as const;
}
