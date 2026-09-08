import { z } from "zod";

const schema = z.object({
  REALTIME_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  REALTIME_TICKET_SECRET: z.string().min(32),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_PASSWORD: z.string().min(1),
  REDIS_DB: z.coerce.number().int().min(0).default(0),
  BULLMQ_PREFIX: z.string().min(1),
});
export type RealtimeConfig = z.infer<typeof schema>;
export const getRealtimeConfig = (environment: NodeJS.ProcessEnv = process.env) => schema.parse(environment);
