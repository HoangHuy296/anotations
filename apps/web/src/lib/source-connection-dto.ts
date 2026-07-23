import "server-only";

import type { RepoProvider, SourceConnectionStatus } from "@internal/db";

export type SafeSourceConnection = {
  id: string;
  provider: RepoProvider;
  name: string | null;
  status: SourceConnectionStatus;
  tokenExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toSafeSourceConnection(connection: {
  id: string;
  provider: RepoProvider;
  name: string | null;
  status: SourceConnectionStatus;
  tokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): SafeSourceConnection {
  return {
    id: connection.id,
    provider: connection.provider,
    name: connection.name,
    status: connection.status,
    tokenExpiresAt: connection.tokenExpiresAt?.toISOString() ?? null,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

const secretPattern = /(token|secret|password|credential|access.?key|database_url|redis_password|source_connection_encryption_key|stack|baseurl|end.?point)/i;

/** Testable final guard for explicit DTOs and safe error objects. */
export function containsForbiddenSourceData(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsForbiddenSourceData);
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) => (key !== "tokenExpiresAt" && secretPattern.test(key)) || containsForbiddenSourceData(entry));
}
