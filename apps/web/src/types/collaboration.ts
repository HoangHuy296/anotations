import type {
  AssetAssignmentType,
  CollaborationOutboxEventType,
  DatasetMemberRole,
  NotificationType,
} from "@internal/db";

/** Browser-safe collaboration DTOs. They intentionally exclude geometry,
 * credentials, private URLs, and operational/audit payloads. */
export type SafeDatasetMember = {
  userId: string;
  name: string;
  email: string;
  role: DatasetMemberRole;
};

export type SafeAssetAssignment = {
  assetId: string;
  type: AssetAssignmentType;
  userId: string;
  assignedAt: string;
};

export type SafeNotificationContext = {
  datasetId?: string | null;
  assetId?: string | null;
  commentId?: string | null;
};

export type SafeNotification = SafeNotificationContext & {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
  unavailable: boolean;
};

export type SafeRealtimeEnvelope = {
  id: string;
  type: CollaborationOutboxEventType;
  occurredAt: string;
  datasetId: string;
  assetId?: string;
  recipientUserId?: string;
  payload: Record<string, string | number | boolean | null>;
};
