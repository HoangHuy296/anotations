import { Database, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { AssetStatus } from "@internal/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";

import { AnnotationCanvas } from "@/components/workspace/annotation-canvas";
import { DatasetSidebar } from "@/components/workspace/dataset-sidebar";
import { PropertiesPanel } from "@/components/workspace/properties-panel";
import { WorkspaceHeader } from "@/components/workspace/workspace-header";
import { db, isDatabaseConfigured } from "@/lib/db";
import { imageStatusOptions } from "@/lib/image-status";

export const metadata: Metadata = {
  title: "Annotation Workspace",
};

type WorkspaceSearchParams = {
  q?: string | string[];
  status?: string | string[];
  image?: string | string[];
};

type WorkspaceAsset = {
  id: string;
  filename: string;
  path: string;
  width: number | null;
  height: number | null;
  sizeBytes: bigint | null;
  giteaSha: string;
  status: AssetStatus;
  _count: { annotations: number };
};

type WorkspaceData = {
  dataset: {
    name: string;
    sourceRootPath: string | null;
    sourceBranch: string | null;
    externalRepository: { fullName: string } | null;
  } | null;
  images: WorkspaceAsset[];
  totalImages: number;
  completedImages: number;
};

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ datasetId: string }>;
  searchParams: Promise<WorkspaceSearchParams>;
}) {
  await connection();
  const { datasetId } = await params;
  const query = await searchParams;

  if (!z.string().cuid().safeParse(datasetId).success) {
    notFound();
  }

  if (!isDatabaseConfigured()) {
    return <WorkspaceSetupState />;
  }

  const search = firstValue(query.q)?.trim().slice(0, 100) ?? "";
  const requestedStatus = firstValue(query.status);
  const status =
    requestedStatus &&
    imageStatusOptions.includes(requestedStatus as AssetStatus)
      ? (requestedStatus as AssetStatus)
      : "ALL";
  const requestedImageId = firstValue(query.image) ?? null;

  let data: WorkspaceData;
  try {
    data = await loadWorkspace(datasetId, search, status);
  } catch (error: unknown) {
    console.error("Workspace data could not be loaded.", error);
    return <WorkspaceSetupState unavailable />;
  }

  if (!data.dataset) {
    notFound();
  }

  const selectedImageId =
    data.images.find((image) => image.id === requestedImageId)?.id ??
    data.images[0]?.id ??
    null;
  const selectedRecord =
    data.images.find((image) => image.id === selectedImageId) ?? null;
  const selectedImage = selectedRecord
    ? {
        ...selectedRecord,
        annotationCount: selectedRecord._count.annotations,
      }
    : null;

  return (
    <div className="flex min-h-[100dvh] flex-col bg-zinc-100">
      <WorkspaceHeader
        datasetName={data.dataset.name}
        branch={data.dataset.sourceBranch ?? "local"}
        repositoryFullName={data.dataset.externalRepository?.fullName ?? "Local dataset"}
        rootPath={data.dataset.sourceRootPath ?? ""}
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)_280px] lg:grid-rows-[calc(100dvh-64px)]">
        <DatasetSidebar
          datasetId={datasetId}
          images={data.images}
          totalImages={data.totalImages}
          completedImages={data.completedImages}
          selectedImageId={selectedImageId}
          search={search}
          status={status}
        />
        <AnnotationCanvas image={selectedImage} />
        <PropertiesPanel image={selectedImage} />
      </div>
    </div>
  );
}

async function loadWorkspace(
  datasetId: string,
  search: string,
  status: AssetStatus | "ALL",
) {
  const imageWhere = {
    datasetId,
    modality: "IMAGE" as const,
    ...(search
      ? {
          filename: {
            contains: search,
            mode: "insensitive" as const,
          },
        }
      : {}),
    ...(status === "ALL" ? {} : { status }),
  };

  const [dataset, images, totalImages, completedImages] = await Promise.all([
    db.dataset.findUnique({
      where: { id: datasetId },
      select: {
        name: true,
        sourceRootPath: true,
        sourceBranch: true,
        externalRepository: {
          select: { fullName: true },
        },
      },
    }),
    db.asset.findMany({
      where: imageWhere,
      orderBy: [{ sourcePath: "asc" }],
      take: 250,
      select: {
        id: true,
        filename: true,
        sourcePath: true,
        width: true,
        height: true,
        sizeBytes: true,
        sourceFileSha: true,
        status: true,
        _count: {
          select: { annotations: true },
        },
      },
    }),
    db.asset.count({ where: { datasetId, modality: "IMAGE" } }),
    db.asset.count({
      where: {
        datasetId,
        modality: "IMAGE",
        status: { not: AssetStatus.NEW },
      },
    }),
  ]);

  return {
    dataset,
    images: images.map((image: {
      id: string;
      filename: string;
      sourcePath: string | null;
      width: number | null;
      height: number | null;
      sizeBytes: bigint | null;
      sourceFileSha: string | null;
      status: AssetStatus;
      _count: { annotations: number };
    }) => ({
      ...image,
      path: image.sourcePath ?? image.filename,
      giteaSha: image.sourceFileSha ?? "unavailable",
    })),
    totalImages,
    completedImages,
  } satisfies WorkspaceData;
}

function WorkspaceSetupState({ unavailable = false }: { unavailable?: boolean }) {
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-zinc-50 px-4 py-10">
      <div className="max-w-md rounded-2xl border border-zinc-200 bg-white p-7 text-center">
        {unavailable ? (
          <WarningCircle
            aria-hidden="true"
            className="mx-auto text-rose-600"
            size={30}
            weight="duotone"
          />
        ) : (
          <Database
            aria-hidden="true"
            className="mx-auto text-sky-600"
            size={30}
            weight="duotone"
          />
        )}
        <h1 className="mt-4 text-xl font-bold text-zinc-950">
          {unavailable ? "Database unavailable" : "Database setup required"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-zinc-500">
          Add DATABASE_URL to `.env.local`, apply migrations, and import a
          dataset before opening the annotation workspace.
        </p>
      </div>
    </main>
  );
}
