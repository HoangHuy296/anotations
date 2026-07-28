import "server-only";

import {
  AssetStatus,
  DatasetSourceMode,
  Modality,
  RepoProvider,
  RepoVisibility,
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
  sourceConnectionId: string;
  sourceConnectionBaseUrl: string;
  repository: GiteaRepositorySummary;
  dataset: {
    name: string;
    branch: string;
    rootPath: string;
    primaryModality: Modality | null;
  };
  images: GiteaImageCandidate[];
};

function sourceFingerprint(branch: string, image: GiteaImageCandidate) {
  return `gitea:${branch}:${image.path}:${image.sha}`;
}

export async function persistDatasetImport(input: PersistDatasetImportInput) {
  const connectionDescriptor = getGiteaConnectionDescriptor(input.sourceConnectionBaseUrl);

  return db.$transaction(
    async (transaction) => {
      const client = transaction as unknown as typeof db;
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
          createdById: input.actor.id,
        },
        select: { id: true },
      });

      const existingDataset = await client.dataset.findFirst({
        where: {
          ownerId: input.actor.id,
          externalRepositoryId: repository.id,
          sourceRef: input.dataset.branch,
          sourceRootPath: input.dataset.rootPath,
          deletedAt: null,
        },
        select: { id: true },
      });

      const dataset = existingDataset
        ? await client.dataset.update({
            where: { id: existingDataset.id },
            data: { name: input.dataset.name, sourceConnectionId: input.sourceConnectionId },
            select: { id: true, name: true },
          })
        : await client.dataset.create({
            data: {
              ownerId: input.actor.id,
              name: input.dataset.name,
              primaryModality: input.dataset.primaryModality,
              sourceMode: DatasetSourceMode.EXTERNAL_REF,
              externalRepositoryId: repository.id,
              sourceConnectionId: input.sourceConnectionId,
              sourceRef: input.dataset.branch,
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
                // This scanner only produces image candidates. Future
                // modality-aware import workers must detect each candidate
                // independently and create the matching metadata child row.
                modality: Modality.IMAGE,
                filename: image.filename,
                mimeType: image.mimeType,
                sizeBytes: BigInt(image.size ?? 0),
                sourceMode: DatasetSourceMode.EXTERNAL_REF,
                externalRepositoryId: repository.id,
                sourceProvider: RepoProvider.GITEA,
                sourceRef: input.dataset.branch,
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
