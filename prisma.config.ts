import { config as loadEnvironment } from "dotenv";
import { defineConfig } from "prisma/config";

import { getDatabaseUrl } from "./database-url";

loadEnvironment({ path: ".env", override: true, quiet: true });
loadEnvironment({ path: ".env.local", override: false, quiet: true });

const databaseUrl = getDatabaseUrl();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for Prisma commands.");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  engine: "classic",
  datasource: {
    url: databaseUrl,
  },
});
