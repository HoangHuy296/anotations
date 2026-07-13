import "server-only";

import {
  AssetStatus,
  DatasetSourceMode,
  Modality,
  RepoProvider,
  RepoVisibility,
  UserRole,
} from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { getGiteaConnectionDescriptor } from "@/lib/gitea";
import type {
  GiteaImageCandidate,
  GiteaRepositorySummary,
} from "@/types/gitea";

type PersistDatasetImportInput = {
  actor: RequestActor;
  repository: GiteaRepositorySummary;
  dataset: {
    name: string;
    branch: string;
    rootPath: string;
  };
  images: GiteaImageCandidate[];
};

function sourceFingerprint(branch: string, image: GiteaImageCandidate) {
  return `gitea:${branch}:${image.path}:${image.sha}`;
}

export async function persistDatasetImport(input: PersistDatasetImportInput) {
  const connectionDescriptor = getGiteaConnectionDescriptor();

  return db.$transaction(
    async (transaction) => {
      // Prisma's custom-output client currently omits model delegates from the
      // interactive transaction type, although the runtime transaction exposes
      // the same delegates as the root client.
      const client = transaction as unknown as typeof db;
      const user = await client.user.upsert({
        where: { email: input.actor.email },
        update: {
          name: input.actor.name,
          role: input.actor.role,
        },
        create: {
          email: input.actor.email,
          name: input.actor.name,
          role:
            input.actor.role === UserRole.ADMIN
              ? UserRole.ADMIN
              : UserRole.LABELER,
        },
        select: { id: true },
      });

      const repository = await client.externalRepository.upsert({
        where: {
          provider_baseUrl_fullName: {
            provider: RepoProvider.GITEA,
            baseUrl: connectionDescriptor.baseUrl,
            fullName: input.repository.fullName,
          },
        },
        update: {
          owner: input.repository.owner,
          repo: input.repository.name,
          externalRepoId: String(input.repository.id),
          defaultBranch: input.repository.defaultBranch,
          visibility: input.repository.private
            ? RepoVisibility.PRIVATE
            : RepoVisibility.PUBLIC,
        },
        create: {
          provider: RepoProvider.GITEA,
          baseUrl: connectionDescriptor.baseUrl,
          owner: input.repository.owner,
          repo: input.repository.name,
          fullName: input.repository.fullName,
          externalRepoId: String(input.repository.id),
          defaultBranch: input.repository.defaultBranch,
          visibility: input.repository.private
            ? RepoVisibility.PRIVATE
            : RepoVisibility.PUBLIC,
          createdById: user.id,
        },
        select: { id: true },
      });

      const existingDataset = await client.dataset.findFirst({
        where: {
          ownerId: user.id,
          externalRepositoryId: repository.id,
          sourceBranch: input.dataset.branch,
          sourceRootPath: input.dataset.rootPath,
          deletedAt: null,
        },
        select: { id: true },
      });

      const dataset = existingDataset
        ? await client.dataset.update({
            where: { id: existingDataset.id },
            data: { name: input.dataset.name },
            select: { id: true, name: true },
          })
        : await client.dataset.create({
            data: {
              ownerId: user.id,
              name: input.dataset.name,
              sourceMode: DatasetSourceMode.EXTERNAL_REF,
              externalRepositoryId: repository.id,
              sourceBranch: input.dataset.branch,
              sourceRootPath: input.dataset.rootPath,
            },
            select: { id: true, name: true },
          });

      for (let offset = 0; offset < input.images.length; offset += 100) {
        const batch = input.images.slice(offset, offset + 100);
        await Promise.all(
          batch.map((image) =>
            client.asset.upsert({
              where: {
                datasetId_sourceFingerprint: {
                  datasetId: dataset.id,
                  sourceFingerprint: sourceFingerprint(input.dataset.branch, image),
                },
              },
              update: {
                filename: image.filename,
                mimeType: image.mimeType,
                sizeBytes: BigInt(image.size ?? 0),
                sourcePath: image.path,
                sourceFileSha: image.sha,
                imageAsset: { upsert: { create: {}, update: {} } },
              },
              create: {
                datasetId: dataset.id,
                modality: Modality.IMAGE,
                filename: image.filename,
                mimeType: image.mimeType,
                sizeBytes: BigInt(image.size ?? 0),
                sourceMode: DatasetSourceMode.EXTERNAL_REF,
                externalRepositoryId: repository.id,
                sourceProvider: RepoProvider.GITEA,
                sourceBranch: input.dataset.branch,
                sourcePath: image.path,
                sourceFileSha: image.sha,
                sourceFingerprint: sourceFingerprint(input.dataset.branch, image),
                status: AssetStatus.NEW,
                imageAsset: { create: {} },
              },
            }),
          ),
        );
      }

      return {
        datasetId: dataset.id,
        datasetName: dataset.name,
        importedImages: input.images.length,
      };
    },
    {
      maxWait: 5_000,
      timeout: 30_000,
    },
  );
}
