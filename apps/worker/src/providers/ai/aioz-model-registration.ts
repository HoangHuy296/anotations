import { z } from "zod";
import type { PrismaClient } from "../../../../../lib/generated/prisma/client.js";

/** Explicit operator declaration, not inference from upstream modality/name. */
const registrationSchema = z.object({
  key: z.string().uuid(),
  displayName: z.string().trim().min(1).max(256),
  provider: z.literal("aioz-company"),
  modality: z.literal("IMAGE"),
  taskType: z.literal("DETECTION"),
}).strict();

export class AiozRegistrationError extends Error {
  constructor(readonly code: "AIOZ_MODEL_CAPABILITY_UNSUPPORTED" | "AIOZ_MODEL_REGISTRATION_CONFLICT") {
    super(code);
    this.name = "AiozRegistrationError";
  }
}

/** Optional operator utility. Toolbox discovery registers supported models in the web service. */
export async function registerAiozModel(db: PrismaClient, input: unknown) {
  const parsed = registrationSchema.safeParse(input);
  if (!parsed.success) throw new AiozRegistrationError("AIOZ_MODEL_CAPABILITY_UNSUPPORTED");
  const definition = parsed.data;
  const select = { id: true, key: true, displayName: true, provider: true, modality: true, taskType: true, isActive: true } as const;
  const verify = (model: NonNullable<Awaited<ReturnType<typeof find>>>) => {
    if (!model.isActive || model.provider !== definition.provider || model.modality !== definition.modality || model.taskType !== definition.taskType || model.displayName !== definition.displayName) {
      throw new AiozRegistrationError("AIOZ_MODEL_REGISTRATION_CONFLICT");
    }
    return model;
  };
  const find = () => db.aiModel.findUnique({ where: { key: definition.key }, select });
  const existing = await find();
  if (existing) return { created: false, model: verify(existing) };
  try {
    const model = await db.aiModel.create({ data: { ...definition, isActive: true }, select });
    return { created: true, model };
  } catch (error) {
    // The existing unique key is the DB-enforced race/idempotency boundary.
    if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
    const winner = await find();
    if (!winner) throw error;
    return { created: false, model: verify(winner) };
  }
}
