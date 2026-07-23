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

/** Safe, self-service account edits. Email and role are intentionally excluded. */
export const profileSchema = z.object({
  name: z.string().trim().min(1).max(100),
}).strict();

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12).max(256),
}).strict().refine((value) => value.currentPassword !== value.newPassword, {
  path: ["newPassword"],
  message: "Choose a password that is different from your current password.",
});
