import "./db-safety/test-entry.cjs"; // G1: receipt-bound seed scope (fails closed without a valid disposable receipt).
import { PrismaClient } from "../lib/generated/prisma/client.js";
import { AiozRegistrationError, registerAiozModel } from "../apps/worker/src/providers/ai/aioz-model-registration.js";
import { RegistrationNotSanctionedError, requireSanctionedRegistration } from "./register-aioz-model-scope.js";

async function main() {
  // Explicit operator write; safe default never mutates a database.
  const argv = process.argv.slice(2);
  if (argv[0] !== "--apply") {
    console.log("No changes. Sanctioned registration (receipt-bound): --apply <model-uuid> <display-name>.");
    return;
  }
  const definition = requireSanctionedRegistration(argv); // exact provider/model/name/capability; throws before any database access
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_CONFIGURATION_REQUIRED");
  const db = new PrismaClient();
  try {
    console.log(JSON.stringify(await registerAiozModel(db, { key: definition.key, displayName: definition.displayName, provider: definition.provider, modality: definition.modality, taskType: definition.taskType })));
  } finally { await db.$disconnect(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof AiozRegistrationError ? error.code : error instanceof RegistrationNotSanctionedError ? error.message : "AIOZ_MODEL_REGISTRATION_FAILED");
  process.exitCode = 1;
});
