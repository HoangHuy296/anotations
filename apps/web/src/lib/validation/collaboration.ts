import {
  AssetAssignmentType,
  DatasetMemberRole,
  NotificationType,
} from "@internal/db";
import { z } from "zod";

import { datasetIdSchema } from "@/lib/validation/dataset";

const identifier = z.string().cuid();
const optionalCursor = z.string().cuid().optional();

export const datasetInvitationCreateSchema = z.object({
  inviteeUserId: identifier,
  role: z.nativeEnum(DatasetMemberRole).refine((role) => role !== DatasetMemberRole.OWNER, "Owner invitations are not allowed."),
}).strict();

export const datasetMemberRoleChangeSchema = z.object({
  role: z.nativeEnum(DatasetMemberRole),
}).strict();

export const assetAssignmentWriteSchema = z.object({
  userId: identifier,
}).strict();

export const assetAssignmentTypeSchema = z.nativeEnum(AssetAssignmentType);

export const assetCommentCreateSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
  parentId: identifier.optional(),
}).strict();

export const assetCommentUpdateSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
}).strict();

export const notificationListQuerySchema = z.object({
  cursor: optionalCursor,
  limit: z.coerce.number().int().min(1).max(100).default(25),
  type: z.nativeEnum(NotificationType).optional(),
  unreadOnly: z.enum(["true", "false"]).optional(),
}).strict();

export const realtimeTicketRequestSchema = z.object({
  datasetIds: z.array(datasetIdSchema).min(1).max(100),
}).strict();

export const collaborationRouteParamsSchema = z.object({
  datasetId: datasetIdSchema,
  assetId: identifier.optional(),
  commentId: identifier.optional(),
  invitationId: identifier.optional(),
  notificationId: identifier.optional(),
}).strict();
