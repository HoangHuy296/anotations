import "server-only";

import { UserRole } from "@internal/db";
import { headers } from "next/headers";

import { db } from "@/lib/db";

const INTERNAL_EMAIL_HEADER = "x-fieldframe-auth-email";
const INTERNAL_VERIFIED_HEADER = "x-fieldframe-proxy-verified";
const DEFAULT_DEVELOPMENT_EMAIL = "developer@localhost";

export type RequestActor = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
};

function normalizeEmail(value: string | null) {
  const email = value?.trim().toLowerCase();
  return email && email.includes("@") ? email : null;
}

export async function getRequestActor(): Promise<RequestActor | null> {
  const requestHeaders = await headers();
  const verified = requestHeaders.get(INTERNAL_VERIFIED_HEADER) === "1";
  const email = verified
    ? normalizeEmail(requestHeaders.get(INTERNAL_EMAIL_HEADER))
    : null;

  if (!email) {
    return null;
  }

  if (
    process.env.NODE_ENV !== "production" &&
    email === DEFAULT_DEVELOPMENT_EMAIL
  ) {
    return {
      id: "00000000-0000-0000-0000-000000000000",
      email,
      name: "Local Developer",
      role: UserRole.ADMIN,
    };
  }

  const user = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
    },
  });

  return user
    ? {
        ...user,
        name: user.name ?? user.email,
      }
    : null;
}

export function canManageLabels(actor: RequestActor | null) {
  return actor?.role === UserRole.ADMIN || actor?.role === UserRole.REVIEWER;
}

export function canImportDatasets(actor: RequestActor | null) {
  return actor?.role === UserRole.ADMIN || actor?.role === UserRole.REVIEWER;
}
