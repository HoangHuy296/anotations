import "db-safety/deny-entry.cjs"; // G1: this writer has no approved operation scope.
import { PrismaClient } from "../lib/generated/prisma/client.js";
import { AiozRegistrationError, registerAiozModel } from "../apps/worker/src/providers/ai/aioz-model-registration.js";

async function main() {
  // Explicit operator write; safe default never mutates a database.
  const [flag, key, displayName, ...extra] = process.argv.slice(2);
  if (flag !== "--apply" || !key || !displayName || extra.length) {
    console.log('No changes. Optional manual registration: --apply <model-uuid> "<display-name>". Toolbox discovery registers supported models automatically.');
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_CONFIGURATION_REQUIRED");
  const db = new PrismaClient();
  try {
    console.log(JSON.stringify(await registerAiozModel(db, { key, displayName, provider: "aioz-company", modality: "IMAGE", taskType: "DETECTION" })));
  } finally { await db.$disconnect(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof AiozRegistrationError ? error.code : "AIOZ_MODEL_REGISTRATION_FAILED");
  process.exitCode = 1;
});
