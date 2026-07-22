import { z } from "zod";

export const credentialsSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(12).max(256),
}).strict();

/** Registration alone accepts a non-sensitive optional display name. */
export const registrationSchema = credentialsSchema.extend({
  name: z.string().trim().min(1).max(100).optional(),
  role: z.enum(["MANAGER", "LABELER", "REVIEWER"]),
}).strict();
