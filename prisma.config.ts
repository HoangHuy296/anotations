import { config as loadEnvironment } from "dotenv";
import { defineConfig } from "prisma/config";

import { getDatabaseUrl } from "./database-url";

// G1: runtime config is not a migration authorization. Use a verified frozen config.
const command = process.argv.slice(2);
if (command.includes("studio") || command.includes("db") || (command.includes("migrate") && command[command.indexOf("migrate") + 1] !== "status")) {
  throw new Error("DB_SAFETY_ROOT_MUTATION_DENIED: use the disposable safety launcher.");
}

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
