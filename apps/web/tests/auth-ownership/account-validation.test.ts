import assert from "node:assert/strict";
import test from "node:test";

import { passwordChangeSchema, profileSchema } from "@/lib/validation/auth";

test("profile updates only accept a bounded display name", () => {
  assert.equal(profileSchema.safeParse({ name: "  Ada Lovelace  " }).success, true);
  assert.equal(profileSchema.safeParse({ name: "" }).success, false);
  assert.equal(profileSchema.safeParse({ name: "Ada", email: "browser-controlled@example.test" }).success, false);
});

test("password changes require a new, sufficiently long password", () => {
  assert.equal(passwordChangeSchema.safeParse({ currentPassword: "old password", newPassword: "a-new-long-password" }).success, true);
  assert.equal(passwordChangeSchema.safeParse({ currentPassword: "same-password", newPassword: "same-password" }).success, false);
  assert.equal(passwordChangeSchema.safeParse({ currentPassword: "old password", newPassword: "short" }).success, false);
});
