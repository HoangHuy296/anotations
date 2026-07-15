import { randomBytes } from "node:crypto";

import { AnnotationType, DatasetMemberRole, Modality, RepoAuthType, RepoProvider, SourceConnectionStatus, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { encryptSourceToken } from "@/lib/source-connection-crypto";

export const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

export type TestActor = { id: string; email: string; name: string; role: UserRole };
export type AuthOwnershipFixture = {
  actors: Record<"owner" | "manager" | "reviewer" | "labeler" | "outsider", TestActor>;
  datasetId: string;
  otherDatasetId: string;
  assetId: string;
  otherAssetId: string;
  assetVersionId: string;
  otherAssetVersionId: string;
  labelId: string;
  otherLabelId: string;
  annotationId: string;
  sourceConnectionId: string;
  otherSourceConnectionId: string;
  cleanup: () => Promise<void>;
};

function unique(value: string) {
  return `${value}-${Date.now()}-${randomBytes(5).toString("hex")}`;
}

async function createActor(label: string): Promise<TestActor> {
  const marker = unique(label);
  const user = await db.user.create({
    data: { email: `${marker}@phase004.test`, name: marker, role: UserRole.LABELER },
    select: { id: true, email: true, name: true, role: true },
  });
  return { ...user, name: user.name ?? user.email };
}

export async function createFixture(): Promise<AuthOwnershipFixture> {
  // A process-local generated key is only used for disposable fixture ciphertext.
  process.env.SOURCE_CONNECTION_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  const owner = await createActor("owner");
  const manager = await createActor("manager");
  const reviewer = await createActor("reviewer");
  const labeler = await createActor("labeler");
  const outsider = await createActor("outsider");
  const actors = { owner, manager, reviewer, labeler, outsider };
  const dataset = await db.dataset.create({ data: { ownerId: owner.id, name: unique("dataset") }, select: { id: true } });
  const otherDataset = await db.dataset.create({ data: { ownerId: outsider.id, name: unique("other-dataset") }, select: { id: true } });
  await db.datasetMember.createMany({ data: [
    { datasetId: dataset.id, userId: manager.id, role: DatasetMemberRole.MANAGER },
    { datasetId: dataset.id, userId: reviewer.id, role: DatasetMemberRole.REVIEWER },
    { datasetId: dataset.id, userId: labeler.id, role: DatasetMemberRole.LABELER },
  ] });
  const asset = await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.IMAGE, filename: "asset.png", mimeType: "image/png", sourceFingerprint: unique("asset") }, select: { id: true } });
  const otherAsset = await db.asset.create({ data: { datasetId: otherDataset.id, modality: Modality.IMAGE, filename: "other.png", mimeType: "image/png", sourceFingerprint: unique("other-asset") }, select: { id: true } });
  const assetVersion = await db.assetVersion.create({ data: { datasetId: dataset.id, assetId: asset.id, versionNumber: 1, modality: Modality.IMAGE, sourceMode: "UPLOAD", filename: "asset.png", mimeType: "image/png", sourceFingerprint: unique("asset-version") }, select: { id: true } });
  const otherAssetVersion = await db.assetVersion.create({ data: { datasetId: otherDataset.id, assetId: otherAsset.id, versionNumber: 1, modality: Modality.IMAGE, sourceMode: "UPLOAD", filename: "other.png", mimeType: "image/png", sourceFingerprint: unique("other-asset-version") }, select: { id: true } });
  const label = await db.label.create({ data: { datasetId: dataset.id, name: "Car", normalizedName: unique("car"), color: "#111111" }, select: { id: true } });
  const otherLabel = await db.label.create({ data: { datasetId: otherDataset.id, name: "Person", normalizedName: unique("person"), color: "#222222" }, select: { id: true } });
  const annotation = await db.annotation.create({ data: { datasetId: dataset.id, assetId: asset.id, assetVersionId: assetVersion.id, labelId: label.id, createdById: labeler.id, modality: Modality.IMAGE, type: AnnotationType.BOUNDING_BOX, geometry: { x: 1, y: 1, width: 2, height: 2 } }, select: { id: true } });
  const sourceConnection = await db.sourceConnection.create({ data: { userId: owner.id, provider: RepoProvider.GITEA, authType: RepoAuthType.TOKEN, baseUrl: "http://gitea.test", status: SourceConnectionStatus.ACTIVE, tokenEncrypted: encryptSourceToken("fixture-token") }, select: { id: true } });
  const otherSourceConnection = await db.sourceConnection.create({ data: { userId: outsider.id, provider: RepoProvider.GITEA, authType: RepoAuthType.TOKEN, baseUrl: "http://gitea.test", status: SourceConnectionStatus.ACTIVE, tokenEncrypted: encryptSourceToken("other-fixture-token") }, select: { id: true } });
  return {
    actors, datasetId: dataset.id, otherDatasetId: otherDataset.id, assetId: asset.id, otherAssetId: otherAsset.id, assetVersionId: assetVersion.id, otherAssetVersionId: otherAssetVersion.id, labelId: label.id, otherLabelId: otherLabel.id, annotationId: annotation.id, sourceConnectionId: sourceConnection.id, otherSourceConnectionId: otherSourceConnection.id,
    cleanup: async () => {
      const userIds = Object.values(actors).map((actor) => actor.id);
      await db.annotation.deleteMany({ where: { OR: [{ createdById: { in: userIds } }, { datasetId: { in: [dataset.id, otherDataset.id] } }] } });
      await db.dataset.deleteMany({ where: { id: { in: [dataset.id, otherDataset.id] } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    },
  };
}
