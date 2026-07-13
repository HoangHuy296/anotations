-- WARNING: This migration destructively replaces the legacy image-only schema.
-- Existing rows in the legacy tables are dropped. Back up production data before applying.
-- It is intentionally intended for the development database only.

DROP TABLE IF EXISTS "ExportJob" CASCADE;
DROP TABLE IF EXISTS "GiteaMetadata" CASCADE;
DROP TABLE IF EXISTS "Annotation" CASCADE;
DROP TABLE IF EXISTS "Label" CASCADE;
DROP TABLE IF EXISTS "ImageAsset" CASCADE;
DROP TABLE IF EXISTS "Dataset" CASCADE;
DROP TABLE IF EXISTS "Repository" CASCADE;
DROP TABLE IF EXISTS "GiteaConnection" CASCADE;
DROP TABLE IF EXISTS "User" CASCADE;

DROP TYPE IF EXISTS "ExportStatus" CASCADE;
DROP TYPE IF EXISTS "ExportFormat" CASCADE;
DROP TYPE IF EXISTS "ImageStatus" CASCADE;
DROP TYPE IF EXISTS "AnnotationSource" CASCADE;
DROP TYPE IF EXISTS "AnnotationStatus" CASCADE;
DROP TYPE IF EXISTS "AnnotationType" CASCADE;
DROP TYPE IF EXISTS "UserRole" CASCADE;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MANAGER', 'LABELER', 'REVIEWER');

-- CreateEnum
CREATE TYPE "DatasetMemberRole" AS ENUM ('OWNER', 'MANAGER', 'LABELER', 'REVIEWER');

-- CreateEnum
CREATE TYPE "Modality" AS ENUM ('IMAGE', 'VIDEO', 'TEXT', 'AUDIO');

-- CreateEnum
CREATE TYPE "DatasetType" AS ENUM ('IMAGE_LABELING', 'VIDEO_LABELING', 'TEXT_LABELING', 'AUDIO_LABELING', 'MULTI_MODAL');

-- CreateEnum
CREATE TYPE "DatasetSourceMode" AS ENUM ('UPLOAD', 'MIRROR_TO_MINIO', 'EXTERNAL_REF', 'HYBRID_CACHE');

-- CreateEnum
CREATE TYPE "RepoProvider" AS ENUM ('GITHUB', 'GITEA', 'GITLAB', 'HUGGING_FACE', 'GENERIC_GIT');

-- CreateEnum
CREATE TYPE "RepoVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "RepoAuthType" AS ENUM ('NONE', 'TOKEN', 'OAUTH', 'APP');

-- CreateEnum
CREATE TYPE "SourceConnectionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('NEW', 'PROCESSING', 'READY', 'IN_PROGRESS', 'COMPLETED', 'NEEDS_REVIEW', 'REVIEWED', 'REJECTED', 'SKIPPED', 'ARCHIVED', 'FAILED');

-- CreateEnum
CREATE TYPE "AssetSyncStatus" AS ENUM ('SYNCED', 'ADDED_UPSTREAM', 'MODIFIED_UPSTREAM', 'DELETED_UPSTREAM', 'RENAMED_UPSTREAM', 'CONFLICT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CacheStatus" AS ENUM ('NOT_CACHED', 'CACHING', 'CACHED', 'STALE', 'FAILED', 'MIRRORED');

-- CreateEnum
CREATE TYPE "AnnotationStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'COMPLETED', 'SUBMITTED', 'REVIEWED', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AnnotationSource" AS ENUM ('MANUAL', 'IMPORTED', 'AI', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AnnotationType" AS ENUM ('BOUNDING_BOX', 'ROTATED_BOUNDING_BOX', 'POLYGON', 'CIRCLE', 'POINT', 'POLYLINE', 'SEGMENTATION_MASK', 'KEYPOINT', 'IMAGE_CLASSIFICATION', 'VIDEO_CLASSIFICATION', 'OBJECT_TRACK', 'ACTION', 'EVENT', 'SCENE', 'SHOT_BOUNDARY', 'NAMED_ENTITY_RECOGNITION', 'POS_TAG', 'TEXT_RELATION', 'TEXT_CLASSIFICATION', 'SENTIMENT', 'INTENT', 'TRANSCRIPT', 'AUDIO_CLASSIFICATION', 'SPEAKER_DIARIZATION', 'SPEAKER_IDENTIFICATION', 'NATURAL_LANGUAGE_UTTERANCE', 'ACOUSTIC_EVENT');

-- CreateEnum
CREATE TYPE "LabelScope" AS ENUM ('OBJECT', 'SEGMENTATION', 'KEYPOINT', 'CLASSIFICATION', 'ACTION', 'EVENT', 'SCENE', 'ENTITY', 'POS', 'RELATION', 'SENTIMENT', 'INTENT', 'TRANSCRIPT', 'SPEAKER', 'ACOUSTIC_EVENT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "StorageProvider" AS ENUM ('MINIO', 'S3', 'R2', 'SUPABASE', 'LOCAL', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('CLONE_REPOSITORY', 'IMPORT_DATASET', 'SYNC_REPOSITORY', 'EXPORT_DATASET', 'GENERATE_THUMBNAILS', 'EXTRACT_VIDEO_METADATA', 'EXTRACT_VIDEO_FRAMES', 'GENERATE_AUDIO_WAVEFORM', 'AUTO_TRANSCRIBE_AUDIO', 'AUTO_LABEL_DATASET', 'AI_PREANNOTATE_ASSET', 'AI_PREANNOTATE_DATASET', 'AI_TASK_SYNC');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELING', 'CANCELED');

-- CreateEnum
CREATE TYPE "JobStage" AS ENUM ('WAITING', 'VALIDATING_INPUT', 'PREPARING_WORKSPACE', 'CLONING_REPOSITORY', 'CHECKING_OUT_REVISION', 'SCANNING_FILES', 'FILTERING_FILES', 'PARSING_IMPORT_FILE', 'VALIDATING_IMPORT_ROWS', 'MAPPING_LABELS', 'UPLOADING_OBJECTS', 'WRITING_ASSETS', 'WRITING_ANNOTATIONS', 'WRITING_METADATA', 'EXTRACTING_METADATA', 'GENERATING_THUMBNAILS', 'EXTRACTING_FRAMES', 'GENERATING_WAVEFORM', 'CREATING_AI_TASK', 'WAITING_AI_RESULT', 'FETCHING_AI_RESULT', 'VALIDATING_AI_RESULT', 'WRITING_AI_SUGGESTIONS', 'EXPORTING_DATASET', 'WRITING_EXPORT_FILE', 'CLEANING_UP', 'FINISHED');

-- CreateEnum
CREATE TYPE "JobPriority" AS ENUM ('BACKGROUND', 'LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "JobTrigger" AS ENUM ('USER', 'SYSTEM', 'RETRY', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "JobEventLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "AiTaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "AiTaskType" AS ENUM ('PREANNOTATE_ASSET', 'PREANNOTATE_DATASET', 'TRANSCRIBE_AUDIO', 'DETECT_OBJECTS', 'SEGMENT_IMAGE', 'CLASSIFY_TEXT', 'CLASSIFY_AUDIO', 'CUSTOM');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'LABELER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "canceledById" TEXT,
    "type" "JobType" NOT NULL,
    "modality" "Modality",
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" "JobStage" NOT NULL DEFAULT 'WAITING',
    "queueName" TEXT,
    "queueJobId" TEXT,
    "enqueuedAt" TIMESTAMP(3),
    "dequeuedAt" TIMESTAMP(3),
    "priority" "JobPriority" NOT NULL DEFAULT 'NORMAL',
    "priorityValue" INTEGER NOT NULL DEFAULT 50,
    "trigger" "JobTrigger" NOT NULL DEFAULT 'USER',
    "provider" "RepoProvider",
    "sourceConnectionId" TEXT,
    "externalRepositoryId" TEXT,
    "input" JSONB NOT NULL DEFAULT '{}',
    "state" JSONB NOT NULL DEFAULT '{}',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "totalItems" INTEGER,
    "processedItems" INTEGER NOT NULL DEFAULT 0,
    "successItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "skippedItems" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "errorCode" TEXT,
    "errorDetails" JSONB,
    "lockedBy" TEXT,
    "lockToken" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "runAfter" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "cancelRequestedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "resultStorageKey" TEXT,
    "resultFilename" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "level" "JobEventLevel" NOT NULL DEFAULT 'INFO',
    "stage" "JobStage",
    "message" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalRepository" (
    "id" TEXT NOT NULL,
    "provider" "RepoProvider" NOT NULL,
    "visibility" "RepoVisibility" NOT NULL DEFAULT 'PUBLIC',
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "owner" TEXT,
    "repo" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "externalRepoId" TEXT,
    "repoType" TEXT,
    "defaultBranch" TEXT,
    "description" TEXT,
    "homepageUrl" TEXT,
    "createdById" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalRepository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "RepoProvider" NOT NULL,
    "authType" "RepoAuthType" NOT NULL DEFAULT 'TOKEN',
    "baseUrl" TEXT NOT NULL DEFAULT '',
    "name" TEXT,
    "externalAccountId" TEXT,
    "accountUsername" TEXT,
    "accountEmail" TEXT,
    "tokenEncrypted" TEXT,
    "refreshTokenEncrypted" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" JSONB NOT NULL DEFAULT '[]',
    "status" "SourceConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "revokedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dataset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "DatasetType" NOT NULL DEFAULT 'MULTI_MODAL',
    "primaryModality" "Modality",
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "sourceMode" "DatasetSourceMode" NOT NULL DEFAULT 'UPLOAD',
    "externalRepositoryId" TEXT,
    "sourceConnectionId" TEXT,
    "sourceRootPath" TEXT,
    "sourceBranch" TEXT,
    "lockedRevision" TEXT,
    "currentRevision" TEXT,
    "includePatterns" JSONB NOT NULL DEFAULT '[]',
    "excludePatterns" JSONB NOT NULL DEFAULT '[]',
    "lastSyncedAt" TIMESTAMP(3),
    "syncStatus" "AssetSyncStatus" NOT NULL DEFAULT 'SYNCED',
    "syncSummary" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Dataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetMember" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "DatasetMemberRole" NOT NULL DEFAULT 'LABELER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DatasetMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "uploadedById" TEXT,
    "modality" "Modality" NOT NULL,
    "filename" TEXT NOT NULL,
    "originalFilename" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "textLength" INTEGER,
    "sourceMode" "DatasetSourceMode" NOT NULL DEFAULT 'UPLOAD',
    "storageProvider" "StorageProvider",
    "storageBucket" TEXT,
    "storageKey" TEXT,
    "checksum" TEXT,
    "externalRepositoryId" TEXT,
    "sourceProvider" "RepoProvider",
    "sourceBranch" TEXT,
    "sourceRevision" TEXT,
    "sourcePath" TEXT,
    "sourceFileSha" TEXT,
    "sourceBlobSha" TEXT,
    "sourceLfsOid" TEXT,
    "sourceEtag" TEXT,
    "sourceUrl" TEXT,
    "sourceFingerprint" TEXT NOT NULL,
    "cacheStatus" "CacheStatus" NOT NULL DEFAULT 'NOT_CACHED',
    "cacheProvider" "StorageProvider",
    "cacheBucket" TEXT,
    "cacheKey" TEXT,
    "cacheChecksum" TEXT,
    "cachedAt" TIMESTAMP(3),
    "cacheExpiresAt" TIMESTAMP(3),
    "cacheError" TEXT,
    "currentVersionId" TEXT,
    "syncStatus" "AssetSyncStatus" NOT NULL DEFAULT 'SYNCED',
    "lastSyncedAt" TIMESTAMP(3),
    "syncSummary" JSONB NOT NULL DEFAULT '{}',
    "status" "AssetStatus" NOT NULL DEFAULT 'NEW',
    "batchIndex" INTEGER NOT NULL DEFAULT 0,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetVersion" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "modality" "Modality" NOT NULL,
    "sourceMode" "DatasetSourceMode" NOT NULL,
    "externalRepositoryId" TEXT,
    "sourceProvider" "RepoProvider",
    "sourceBranch" TEXT,
    "sourceRevision" TEXT,
    "sourcePath" TEXT,
    "sourceFileSha" TEXT,
    "sourceBlobSha" TEXT,
    "sourceLfsOid" TEXT,
    "sourceEtag" TEXT,
    "sourceUrl" TEXT,
    "sourceFingerprint" TEXT NOT NULL,
    "storageProvider" "StorageProvider",
    "storageBucket" TEXT,
    "storageKey" TEXT,
    "checksum" TEXT,
    "cacheStatus" "CacheStatus" NOT NULL DEFAULT 'NOT_CACHED',
    "cacheProvider" "StorageProvider",
    "cacheBucket" TEXT,
    "cacheKey" TEXT,
    "cacheChecksum" TEXT,
    "cachedAt" TIMESTAMP(3),
    "cacheExpiresAt" TIMESTAMP(3),
    "cacheError" TEXT,
    "filename" TEXT NOT NULL,
    "originalFilename" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "textLength" INTEGER,
    "syncStatus" "AssetSyncStatus" NOT NULL DEFAULT 'SYNCED',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Label" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "modality" "Modality",
    "scope" "LabelScope" NOT NULL DEFAULT 'OBJECT',
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "description" TEXT,
    "hotkey" TEXT,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Annotation" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "assetVersionId" TEXT,
    "labelId" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "reviewedById" TEXT,
    "modality" "Modality" NOT NULL,
    "type" "AnnotationType" NOT NULL,
    "source" "AnnotationSource" NOT NULL DEFAULT 'MANUAL',
    "geometry" JSONB NOT NULL DEFAULT '{}',
    "properties" JSONB NOT NULL DEFAULT '{}',
    "status" "AnnotationStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "frameIndex" INTEGER,
    "timestampMs" INTEGER,
    "trackId" TEXT,
    "isKeyframe" BOOLEAN NOT NULL DEFAULT false,
    "isInterpolated" BOOLEAN NOT NULL DEFAULT false,
    "startMs" INTEGER,
    "endMs" INTEGER,
    "startChar" INTEGER,
    "endChar" INTEGER,
    "startToken" INTEGER,
    "endToken" INTEGER,
    "tokenIndex" INTEGER,
    "sentenceIndex" INTEGER,
    "textValue" TEXT,
    "fromAnnotationId" TEXT,
    "toAnnotationId" TEXT,
    "speakerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Annotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageAsset" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "thumbnailKey" TEXT,
    "exif" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "ImageAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoAsset" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "fps" DOUBLE PRECISION,
    "totalFrames" INTEGER,
    "codec" TEXT,
    "thumbnailKey" TEXT,
    "frameStorageKey" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "VideoAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoObjectTrack" (
    "id" TEXT NOT NULL,
    "videoAssetId" TEXT NOT NULL,
    "labelId" TEXT,
    "createdById" TEXT,
    "name" TEXT,
    "color" TEXT,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "status" "AnnotationStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoObjectTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TextDocument" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "content" TEXT,
    "language" TEXT,
    "tokenization" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "TextDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioAsset" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "sampleRate" INTEGER,
    "channels" INTEGER,
    "codec" TEXT,
    "bitRate" INTEGER,
    "waveformKey" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "AudioAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioSpeaker" (
    "id" TEXT NOT NULL,
    "audioAssetId" TEXT NOT NULL,
    "externalId" TEXT,
    "name" TEXT,
    "role" TEXT,
    "color" TEXT,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioSpeaker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiTask" (
    "id" TEXT NOT NULL,
    "externalTaskId" TEXT,
    "datasetId" TEXT NOT NULL,
    "assetId" TEXT,
    "jobId" TEXT,
    "createdById" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "type" "AiTaskType" NOT NULL,
    "status" "AiTaskStatus" NOT NULL DEFAULT 'QUEUED',
    "modality" "Modality",
    "modelName" TEXT,
    "modelVersion" TEXT,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "errorCode" TEXT,
    "errorDetails" JSONB,
    "resultStorageKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_refreshTokenHash_key" ON "AuthSession"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");

-- CreateIndex
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

-- CreateIndex
CREATE INDEX "Job_datasetId_status_idx" ON "Job"("datasetId", "status");

-- CreateIndex
CREATE INDEX "Job_createdById_idx" ON "Job"("createdById");

-- CreateIndex
CREATE INDEX "Job_canceledById_idx" ON "Job"("canceledById");

-- CreateIndex
CREATE INDEX "Job_status_runAfter_idx" ON "Job"("status", "runAfter");

-- CreateIndex
CREATE INDEX "Job_status_priorityValue_createdAt_idx" ON "Job"("status", "priorityValue", "createdAt");

-- CreateIndex
CREATE INDEX "Job_status_heartbeatAt_idx" ON "Job"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "Job_lockedUntil_idx" ON "Job"("lockedUntil");

-- CreateIndex
CREATE INDEX "Job_sourceConnectionId_idx" ON "Job"("sourceConnectionId");

-- CreateIndex
CREATE INDEX "Job_externalRepositoryId_idx" ON "Job"("externalRepositoryId");

-- CreateIndex
CREATE INDEX "Job_type_status_idx" ON "Job"("type", "status");

-- CreateIndex
CREATE INDEX "Job_queueName_queueJobId_idx" ON "Job"("queueName", "queueJobId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_datasetId_idempotencyKey_key" ON "Job"("datasetId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "JobEvent_jobId_idx" ON "JobEvent"("jobId");

-- CreateIndex
CREATE INDEX "JobEvent_jobId_createdAt_idx" ON "JobEvent"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "JobEvent_level_idx" ON "JobEvent"("level");

-- CreateIndex
CREATE INDEX "ExternalRepository_provider_idx" ON "ExternalRepository"("provider");

-- CreateIndex
CREATE INDEX "ExternalRepository_createdById_idx" ON "ExternalRepository"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalRepository_provider_baseUrl_fullName_key" ON "ExternalRepository"("provider", "baseUrl", "fullName");

-- CreateIndex
CREATE INDEX "SourceConnection_userId_idx" ON "SourceConnection"("userId");

-- CreateIndex
CREATE INDEX "SourceConnection_provider_idx" ON "SourceConnection"("provider");

-- CreateIndex
CREATE INDEX "SourceConnection_provider_baseUrl_idx" ON "SourceConnection"("provider", "baseUrl");

-- CreateIndex
CREATE INDEX "SourceConnection_status_idx" ON "SourceConnection"("status");

-- CreateIndex
CREATE INDEX "SourceConnection_tokenExpiresAt_idx" ON "SourceConnection"("tokenExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SourceConnection_userId_provider_externalAccountId_key" ON "SourceConnection"("userId", "provider", "externalAccountId");

-- CreateIndex
CREATE INDEX "Dataset_ownerId_idx" ON "Dataset"("ownerId");

-- CreateIndex
CREATE INDEX "Dataset_ownerId_primaryModality_idx" ON "Dataset"("ownerId", "primaryModality");

-- CreateIndex
CREATE INDEX "Dataset_type_idx" ON "Dataset"("type");

-- CreateIndex
CREATE INDEX "Dataset_primaryModality_idx" ON "Dataset"("primaryModality");

-- CreateIndex
CREATE INDEX "Dataset_sourceMode_idx" ON "Dataset"("sourceMode");

-- CreateIndex
CREATE INDEX "Dataset_externalRepositoryId_idx" ON "Dataset"("externalRepositoryId");

-- CreateIndex
CREATE INDEX "Dataset_sourceConnectionId_idx" ON "Dataset"("sourceConnectionId");

-- CreateIndex
CREATE INDEX "Dataset_currentRevision_idx" ON "Dataset"("currentRevision");

-- CreateIndex
CREATE INDEX "DatasetMember_userId_idx" ON "DatasetMember"("userId");

-- CreateIndex
CREATE INDEX "DatasetMember_datasetId_idx" ON "DatasetMember"("datasetId");

-- CreateIndex
CREATE INDEX "DatasetMember_datasetId_role_idx" ON "DatasetMember"("datasetId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "DatasetMember_datasetId_userId_key" ON "DatasetMember"("datasetId", "userId");

-- CreateIndex
CREATE INDEX "Asset_sourceFingerprint_idx" ON "Asset"("sourceFingerprint");

-- CreateIndex
CREATE INDEX "Asset_datasetId_modality_idx" ON "Asset"("datasetId", "modality");

-- CreateIndex
CREATE INDEX "Asset_datasetId_batchIndex_idx" ON "Asset"("datasetId", "batchIndex");

-- CreateIndex
CREATE INDEX "Asset_datasetId_batchIndex_orderIndex_idx" ON "Asset"("datasetId", "batchIndex", "orderIndex");

-- CreateIndex
CREATE INDEX "Asset_datasetId_filename_idx" ON "Asset"("datasetId", "filename");

-- CreateIndex
CREATE INDEX "Asset_datasetId_status_idx" ON "Asset"("datasetId", "status");

-- CreateIndex
CREATE INDEX "Asset_datasetId_syncStatus_idx" ON "Asset"("datasetId", "syncStatus");

-- CreateIndex
CREATE INDEX "Asset_datasetId_cacheStatus_idx" ON "Asset"("datasetId", "cacheStatus");

-- CreateIndex
CREATE INDEX "Asset_uploadedById_idx" ON "Asset"("uploadedById");

-- CreateIndex
CREATE INDEX "Asset_externalRepositoryId_idx" ON "Asset"("externalRepositoryId");

-- CreateIndex
CREATE INDEX "Asset_sourceProvider_idx" ON "Asset"("sourceProvider");

-- CreateIndex
CREATE INDEX "Asset_sourceRevision_idx" ON "Asset"("sourceRevision");

-- CreateIndex
CREATE INDEX "Asset_sourcePath_idx" ON "Asset"("sourcePath");

-- CreateIndex
CREATE INDEX "Asset_sourceFileSha_idx" ON "Asset"("sourceFileSha");

-- CreateIndex
CREATE INDEX "Asset_sourceBlobSha_idx" ON "Asset"("sourceBlobSha");

-- CreateIndex
CREATE INDEX "Asset_sourceLfsOid_idx" ON "Asset"("sourceLfsOid");

-- CreateIndex
CREATE INDEX "Asset_currentVersionId_idx" ON "Asset"("currentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_storageProvider_storageBucket_storageKey_key" ON "Asset"("storageProvider", "storageBucket", "storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_cacheProvider_cacheBucket_cacheKey_key" ON "Asset"("cacheProvider", "cacheBucket", "cacheKey");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_datasetId_sourceFingerprint_key" ON "Asset"("datasetId", "sourceFingerprint");

-- CreateIndex
CREATE INDEX "AssetVersion_assetId_idx" ON "AssetVersion"("assetId");

-- CreateIndex
CREATE INDEX "AssetVersion_datasetId_idx" ON "AssetVersion"("datasetId");

-- CreateIndex
CREATE INDEX "AssetVersion_datasetId_isCurrent_idx" ON "AssetVersion"("datasetId", "isCurrent");

-- CreateIndex
CREATE INDEX "AssetVersion_externalRepositoryId_idx" ON "AssetVersion"("externalRepositoryId");

-- CreateIndex
CREATE INDEX "AssetVersion_sourceRevision_idx" ON "AssetVersion"("sourceRevision");

-- CreateIndex
CREATE INDEX "AssetVersion_sourcePath_idx" ON "AssetVersion"("sourcePath");

-- CreateIndex
CREATE INDEX "AssetVersion_sourceFileSha_idx" ON "AssetVersion"("sourceFileSha");

-- CreateIndex
CREATE INDEX "AssetVersion_sourceBlobSha_idx" ON "AssetVersion"("sourceBlobSha");

-- CreateIndex
CREATE INDEX "AssetVersion_sourceLfsOid_idx" ON "AssetVersion"("sourceLfsOid");

-- CreateIndex
CREATE INDEX "AssetVersion_syncStatus_idx" ON "AssetVersion"("syncStatus");

-- CreateIndex
CREATE INDEX "AssetVersion_cacheStatus_idx" ON "AssetVersion"("cacheStatus");

-- CreateIndex
CREATE INDEX "AssetVersion_sourceFingerprint_idx" ON "AssetVersion"("sourceFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "AssetVersion_assetId_versionNumber_key" ON "AssetVersion"("assetId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AssetVersion_storageProvider_storageBucket_storageKey_key" ON "AssetVersion"("storageProvider", "storageBucket", "storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "AssetVersion_cacheProvider_cacheBucket_cacheKey_key" ON "AssetVersion"("cacheProvider", "cacheBucket", "cacheKey");

-- CreateIndex
CREATE UNIQUE INDEX "AssetVersion_datasetId_sourceFingerprint_key" ON "AssetVersion"("datasetId", "sourceFingerprint");

-- CreateIndex
CREATE INDEX "Label_datasetId_idx" ON "Label"("datasetId");

-- CreateIndex
CREATE INDEX "Label_datasetId_scope_idx" ON "Label"("datasetId", "scope");

-- CreateIndex
CREATE INDEX "Label_datasetId_modality_idx" ON "Label"("datasetId", "modality");

-- CreateIndex
CREATE UNIQUE INDEX "Label_datasetId_normalizedName_key" ON "Label"("datasetId", "normalizedName");

-- CreateIndex
CREATE INDEX "Annotation_datasetId_modality_idx" ON "Annotation"("datasetId", "modality");

-- CreateIndex
CREATE INDEX "Annotation_datasetId_status_idx" ON "Annotation"("datasetId", "status");

-- CreateIndex
CREATE INDEX "Annotation_assetId_type_idx" ON "Annotation"("assetId", "type");

-- CreateIndex
CREATE INDEX "Annotation_assetId_status_createdAt_idx" ON "Annotation"("assetId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Annotation_assetVersionId_idx" ON "Annotation"("assetVersionId");

-- CreateIndex
CREATE INDEX "Annotation_labelId_idx" ON "Annotation"("labelId");

-- CreateIndex
CREATE INDEX "Annotation_createdById_idx" ON "Annotation"("createdById");

-- CreateIndex
CREATE INDEX "Annotation_assetId_frameIndex_idx" ON "Annotation"("assetId", "frameIndex");

-- CreateIndex
CREATE INDEX "Annotation_trackId_frameIndex_idx" ON "Annotation"("trackId", "frameIndex");

-- CreateIndex
CREATE INDEX "Annotation_assetId_timestampMs_idx" ON "Annotation"("assetId", "timestampMs");

-- CreateIndex
CREATE INDEX "Annotation_assetId_startMs_endMs_idx" ON "Annotation"("assetId", "startMs", "endMs");

-- CreateIndex
CREATE INDEX "Annotation_assetId_startChar_endChar_idx" ON "Annotation"("assetId", "startChar", "endChar");

-- CreateIndex
CREATE INDEX "Annotation_assetId_tokenIndex_idx" ON "Annotation"("assetId", "tokenIndex");

-- CreateIndex
CREATE INDEX "Annotation_fromAnnotationId_toAnnotationId_idx" ON "Annotation"("fromAnnotationId", "toAnnotationId");

-- CreateIndex
CREATE INDEX "Annotation_speakerId_idx" ON "Annotation"("speakerId");

-- CreateIndex
CREATE UNIQUE INDEX "ImageAsset_assetId_key" ON "ImageAsset"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoAsset_assetId_key" ON "VideoAsset"("assetId");

-- CreateIndex
CREATE INDEX "VideoAsset_assetId_idx" ON "VideoAsset"("assetId");

-- CreateIndex
CREATE INDEX "VideoObjectTrack_videoAssetId_idx" ON "VideoObjectTrack"("videoAssetId");

-- CreateIndex
CREATE INDEX "VideoObjectTrack_labelId_idx" ON "VideoObjectTrack"("labelId");

-- CreateIndex
CREATE INDEX "VideoObjectTrack_createdById_idx" ON "VideoObjectTrack"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "TextDocument_assetId_key" ON "TextDocument"("assetId");

-- CreateIndex
CREATE INDEX "TextDocument_assetId_idx" ON "TextDocument"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "AudioAsset_assetId_key" ON "AudioAsset"("assetId");

-- CreateIndex
CREATE INDEX "AudioAsset_assetId_idx" ON "AudioAsset"("assetId");

-- CreateIndex
CREATE INDEX "AudioSpeaker_audioAssetId_idx" ON "AudioSpeaker"("audioAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "AudioSpeaker_audioAssetId_externalId_key" ON "AudioSpeaker"("audioAssetId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "AiTask_externalTaskId_key" ON "AiTask"("externalTaskId");

-- CreateIndex
CREATE INDEX "AiTask_datasetId_idx" ON "AiTask"("datasetId");

-- CreateIndex
CREATE INDEX "AiTask_assetId_idx" ON "AiTask"("assetId");

-- CreateIndex
CREATE INDEX "AiTask_jobId_idx" ON "AiTask"("jobId");

-- CreateIndex
CREATE INDEX "AiTask_createdById_idx" ON "AiTask"("createdById");

-- CreateIndex
CREATE INDEX "AiTask_status_idx" ON "AiTask"("status");

-- CreateIndex
CREATE INDEX "AiTask_provider_idx" ON "AiTask"("provider");

-- CreateIndex
CREATE INDEX "AiTask_type_idx" ON "AiTask"("type");

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_canceledById_fkey" FOREIGN KEY ("canceledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_sourceConnectionId_fkey" FOREIGN KEY ("sourceConnectionId") REFERENCES "SourceConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_externalRepositoryId_fkey" FOREIGN KEY ("externalRepositoryId") REFERENCES "ExternalRepository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalRepository" ADD CONSTRAINT "ExternalRepository_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceConnection" ADD CONSTRAINT "SourceConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_externalRepositoryId_fkey" FOREIGN KEY ("externalRepositoryId") REFERENCES "ExternalRepository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_sourceConnectionId_fkey" FOREIGN KEY ("sourceConnectionId") REFERENCES "SourceConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetMember" ADD CONSTRAINT "DatasetMember_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetMember" ADD CONSTRAINT "DatasetMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_externalRepositoryId_fkey" FOREIGN KEY ("externalRepositoryId") REFERENCES "ExternalRepository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetVersion" ADD CONSTRAINT "AssetVersion_externalRepositoryId_fkey" FOREIGN KEY ("externalRepositoryId") REFERENCES "ExternalRepository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetVersion" ADD CONSTRAINT "AssetVersion_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetVersion" ADD CONSTRAINT "AssetVersion_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Label" ADD CONSTRAINT "Label_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_assetVersionId_fkey" FOREIGN KEY ("assetVersionId") REFERENCES "AssetVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "VideoObjectTrack"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_speakerId_fkey" FOREIGN KEY ("speakerId") REFERENCES "AudioSpeaker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_fromAnnotationId_fkey" FOREIGN KEY ("fromAnnotationId") REFERENCES "Annotation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_toAnnotationId_fkey" FOREIGN KEY ("toAnnotationId") REFERENCES "Annotation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageAsset" ADD CONSTRAINT "ImageAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoAsset" ADD CONSTRAINT "VideoAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoObjectTrack" ADD CONSTRAINT "VideoObjectTrack_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoObjectTrack" ADD CONSTRAINT "VideoObjectTrack_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoObjectTrack" ADD CONSTRAINT "VideoObjectTrack_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TextDocument" ADD CONSTRAINT "TextDocument_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioSpeaker" ADD CONSTRAINT "AudioSpeaker_audioAssetId_fkey" FOREIGN KEY ("audioAssetId") REFERENCES "AudioAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

