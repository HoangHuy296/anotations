-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'ANNOTATOR', 'REVIEWER');

-- CreateEnum
CREATE TYPE "AnnotationType" AS ENUM ('BOUNDING_BOX', 'POLYGON', 'KEYPOINTS', 'SEGMENTATION_MASK', 'CLASSIFICATION');

-- CreateEnum
CREATE TYPE "AnnotationStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'REVIEW_PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ImageStatus" AS ENUM ('NOT_STARTED', 'AUTO_DETECTED', 'IN_PROGRESS', 'REVIEW_PENDING', 'MANUALLY_VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('JSON', 'CSV', 'COCO', 'YOLO', 'PASCAL_VOC');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AnnotationSource" AS ENUM ('MANUAL', 'AUTO_DETECTED', 'IMPORTED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'ANNOTATOR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiteaConnection" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "tokenEncrypted" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiteaConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" UUID NOT NULL,
    "giteaRepoId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "connectionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dataset" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "repositoryId" UUID NOT NULL,
    "branch" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageAsset" (
    "id" UUID NOT NULL,
    "datasetId" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sizeBytes" BIGINT NOT NULL,
    "status" "ImageStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "giteaSha" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImageAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Label" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "description" TEXT,
    "hotkey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Annotation" (
    "id" UUID NOT NULL,
    "imageId" UUID NOT NULL,
    "labelId" UUID NOT NULL,
    "type" "AnnotationType" NOT NULL DEFAULT 'BOUNDING_BOX',
    "coordinates" JSONB NOT NULL,
    "status" "AnnotationStatus" NOT NULL DEFAULT 'DRAFT',
    "confidence" DOUBLE PRECISION,
    "source" "AnnotationSource" NOT NULL DEFAULT 'MANUAL',
    "createdById" UUID NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Annotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiteaMetadata" (
    "id" UUID NOT NULL,
    "imageId" UUID NOT NULL,
    "raw" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiteaMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" UUID NOT NULL,
    "datasetId" UUID NOT NULL,
    "format" "ExportFormat" NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'PENDING',
    "filePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "GiteaConnection_createdById_idx" ON "GiteaConnection"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "GiteaConnection_createdById_name_key" ON "GiteaConnection"("createdById", "name");

-- CreateIndex
CREATE INDEX "Repository_connectionId_idx" ON "Repository"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_connectionId_giteaRepoId_key" ON "Repository"("connectionId", "giteaRepoId");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_connectionId_fullName_key" ON "Repository"("connectionId", "fullName");

-- CreateIndex
CREATE INDEX "Dataset_repositoryId_idx" ON "Dataset"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Dataset_repositoryId_branch_rootPath_key" ON "Dataset"("repositoryId", "branch", "rootPath");

-- CreateIndex
CREATE INDEX "ImageAsset_datasetId_status_idx" ON "ImageAsset"("datasetId", "status");

-- CreateIndex
CREATE INDEX "ImageAsset_giteaSha_idx" ON "ImageAsset"("giteaSha");

-- CreateIndex
CREATE UNIQUE INDEX "ImageAsset_datasetId_path_key" ON "ImageAsset"("datasetId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "Label_name_key" ON "Label"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Label_hotkey_key" ON "Label"("hotkey");

-- CreateIndex
CREATE INDEX "Annotation_imageId_status_idx" ON "Annotation"("imageId", "status");

-- CreateIndex
CREATE INDEX "Annotation_labelId_idx" ON "Annotation"("labelId");

-- CreateIndex
CREATE INDEX "Annotation_createdById_idx" ON "Annotation"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "GiteaMetadata_imageId_key" ON "GiteaMetadata"("imageId");

-- CreateIndex
CREATE INDEX "ExportJob_datasetId_createdAt_idx" ON "ExportJob"("datasetId", "createdAt");

-- CreateIndex
CREATE INDEX "ExportJob_status_idx" ON "ExportJob"("status");

-- AddForeignKey
ALTER TABLE "GiteaConnection" ADD CONSTRAINT "GiteaConnection_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "GiteaConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageAsset" ADD CONSTRAINT "ImageAsset_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "ImageAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiteaMetadata" ADD CONSTRAINT "GiteaMetadata_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "ImageAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
