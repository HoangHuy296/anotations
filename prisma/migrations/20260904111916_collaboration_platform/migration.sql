-- CreateEnum
CREATE TYPE "DatasetInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AssetAssignmentType" AS ENUM ('ANNOTATION', 'REVIEW');

-- CreateEnum
CREATE TYPE "AssetAssignmentEventAction" AS ENUM ('ASSIGNED', 'REASSIGNED', 'UNASSIGNED', 'REMOVED_FOR_ROLE_CHANGE');

-- CreateEnum
CREATE TYPE "DatasetMembershipEventAction" AS ENUM ('INVITED', 'ACCEPTED', 'DECLINED', 'REVOKED', 'ROLE_CHANGED', 'REMOVED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('DATASET_INVITE', 'ASSET_ASSIGNED', 'REVIEW_ASSIGNED', 'MENTIONED', 'COMMENT_REPLY', 'REVIEW_SUBMITTED', 'REVIEW_APPROVED', 'REVIEW_REJECTED');

-- CreateEnum
CREATE TYPE "CollaborationOutboxEventType" AS ENUM ('MEMBER_CHANGED', 'ASSIGNMENT_CHANGED', 'COMMENT_CHANGED', 'NOTIFICATION_CREATED', 'WORKFLOW_CHANGED', 'MEMBERSHIP_REVOKED');

-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'COLLABORATION_OUTBOX_DISPATCH';

-- CreateTable
CREATE TABLE "DatasetInvitation" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "inviteeUserId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "role" "DatasetMemberRole" NOT NULL,
    "status" "DatasetInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "activeKey" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DatasetInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetAssignment" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "AssetAssignmentType" NOT NULL,
    "assignedById" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetAssignmentEvent" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "action" "AssetAssignmentEventAction" NOT NULL,
    "previousUserId" TEXT,
    "nextUserId" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetAssignmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetComment" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "parentId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "AssetComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommentMention" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentMention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "datasetId" TEXT,
    "assetId" TEXT,
    "commentId" TEXT,
    "actorId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "contextUnavailableAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetMembershipEvent" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "memberUserId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" "DatasetMembershipEventAction" NOT NULL,
    "previousRole" "DatasetMemberRole",
    "nextRole" "DatasetMemberRole",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetMembershipEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollaborationOutboxEvent" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "assetId" TEXT,
    "recipientUserId" TEXT,
    "actorId" TEXT,
    "jobId" TEXT NOT NULL,
    "type" "CollaborationOutboxEventType" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollaborationOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DatasetInvitation_inviteeUserId_status_createdAt_idx" ON "DatasetInvitation"("inviteeUserId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "DatasetInvitation_datasetId_status_createdAt_idx" ON "DatasetInvitation"("datasetId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "DatasetInvitation_expiresAt_idx" ON "DatasetInvitation"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DatasetInvitation_datasetId_inviteeUserId_activeKey_key" ON "DatasetInvitation"("datasetId", "inviteeUserId", "activeKey");

-- CreateIndex
CREATE INDEX "AssetAssignment_datasetId_type_idx" ON "AssetAssignment"("datasetId", "type");

-- CreateIndex
CREATE INDEX "AssetAssignment_userId_type_idx" ON "AssetAssignment"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "AssetAssignment_assetId_type_key" ON "AssetAssignment"("assetId", "type");

-- CreateIndex
CREATE INDEX "AssetAssignmentEvent_assetId_createdAt_idx" ON "AssetAssignmentEvent"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "AssetAssignmentEvent_datasetId_createdAt_idx" ON "AssetAssignmentEvent"("datasetId", "createdAt");

-- CreateIndex
CREATE INDEX "AssetAssignmentEvent_assignmentId_idx" ON "AssetAssignmentEvent"("assignmentId");

-- CreateIndex
CREATE INDEX "AssetComment_assetId_parentId_createdAt_idx" ON "AssetComment"("assetId", "parentId", "createdAt");

-- CreateIndex
CREATE INDEX "AssetComment_datasetId_createdAt_idx" ON "AssetComment"("datasetId", "createdAt");

-- CreateIndex
CREATE INDEX "AssetComment_authorId_createdAt_idx" ON "AssetComment"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "CommentMention_userId_createdAt_idx" ON "CommentMention"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommentMention_commentId_userId_key" ON "CommentMention"("commentId", "userId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_datasetId_createdAt_idx" ON "Notification"("datasetId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_assetId_createdAt_idx" ON "Notification"("assetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "DatasetMembershipEvent_datasetId_createdAt_idx" ON "DatasetMembershipEvent"("datasetId", "createdAt");

-- CreateIndex
CREATE INDEX "DatasetMembershipEvent_memberUserId_createdAt_idx" ON "DatasetMembershipEvent"("memberUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollaborationOutboxEvent_jobId_key" ON "CollaborationOutboxEvent"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "CollaborationOutboxEvent_dedupeKey_key" ON "CollaborationOutboxEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "CollaborationOutboxEvent_datasetId_dispatchedAt_createdAt_idx" ON "CollaborationOutboxEvent"("datasetId", "dispatchedAt", "createdAt");

-- CreateIndex
CREATE INDEX "CollaborationOutboxEvent_recipientUserId_createdAt_idx" ON "CollaborationOutboxEvent"("recipientUserId", "createdAt");

-- CreateIndex
CREATE INDEX "CollaborationOutboxEvent_assetId_createdAt_idx" ON "CollaborationOutboxEvent"("assetId", "createdAt");

-- AddForeignKey
ALTER TABLE "DatasetInvitation" ADD CONSTRAINT "DatasetInvitation_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetInvitation" ADD CONSTRAINT "DatasetInvitation_inviteeUserId_fkey" FOREIGN KEY ("inviteeUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetInvitation" ADD CONSTRAINT "DatasetInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignment" ADD CONSTRAINT "AssetAssignment_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignment" ADD CONSTRAINT "AssetAssignment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignment" ADD CONSTRAINT "AssetAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignment" ADD CONSTRAINT "AssetAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignmentEvent" ADD CONSTRAINT "AssetAssignmentEvent_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignmentEvent" ADD CONSTRAINT "AssetAssignmentEvent_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetAssignmentEvent" ADD CONSTRAINT "AssetAssignmentEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetComment" ADD CONSTRAINT "AssetComment_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetComment" ADD CONSTRAINT "AssetComment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetComment" ADD CONSTRAINT "AssetComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetComment" ADD CONSTRAINT "AssetComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "AssetComment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetComment" ADD CONSTRAINT "AssetComment_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentMention" ADD CONSTRAINT "CommentMention_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "AssetComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentMention" ADD CONSTRAINT "CommentMention_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "AssetComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetMembershipEvent" ADD CONSTRAINT "DatasetMembershipEvent_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetMembershipEvent" ADD CONSTRAINT "DatasetMembershipEvent_memberUserId_fkey" FOREIGN KEY ("memberUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetMembershipEvent" ADD CONSTRAINT "DatasetMembershipEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollaborationOutboxEvent" ADD CONSTRAINT "CollaborationOutboxEvent_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollaborationOutboxEvent" ADD CONSTRAINT "CollaborationOutboxEvent_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollaborationOutboxEvent" ADD CONSTRAINT "CollaborationOutboxEvent_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollaborationOutboxEvent" ADD CONSTRAINT "CollaborationOutboxEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollaborationOutboxEvent" ADD CONSTRAINT "CollaborationOutboxEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
