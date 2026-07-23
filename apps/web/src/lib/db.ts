import "server-only";

import { Prisma, PrismaClient } from "@internal/db";

import { getDatabaseUrl } from "../../../../database-url";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

const databaseUrl = getDatabaseUrl();
const prismaLog: Prisma.LogLevel[] =
  process.env.NODE_ENV === "test"
    ? []
    : process.env.NODE_ENV === "development"
      ? ["warn", "error"]
      : ["error"];

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    ...(databaseUrl
      ? {
          datasources: {
            db: { url: databaseUrl },
          },
        }
      : {}),
    // Tests assert safe application responses; expected serialization retries
    // must not emit raw Prisma diagnostics into integration-test output.
    log: prismaLog,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}

export function isDatabaseConfigured() {
  return Boolean(databaseUrl);
}
