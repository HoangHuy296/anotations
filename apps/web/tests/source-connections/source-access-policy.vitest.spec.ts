import { describe, expect, it } from "vitest";

import { readSourceAccessPolicy, validateSourceBaseUrl } from "@fieldframe/domain";

describe("source destination policy with injected resolver", () => {
  it("fails closed for private, mixed, and unavailable DNS answers", async () => {
    const policy = readSourceAccessPolicy({ NODE_ENV: "test" });
    await expect(validateSourceBaseUrl("https://private.example.test", policy, async () => ["127.0.0.1"])) .resolves.toEqual({ ok: false, code: "SOURCE_DESTINATION_NOT_ALLOWED" });
    await expect(validateSourceBaseUrl("https://mixed.example.test", policy, async () => ["203.0.113.10", "10.0.0.1"])) .resolves.toEqual({ ok: false, code: "SOURCE_DESTINATION_NOT_ALLOWED" });
    await expect(validateSourceBaseUrl("https://failed.example.test", policy, async () => { throw new Error("injected lookup failure"); })) .resolves.toEqual({ ok: false, code: "SOURCE_DESTINATION_NOT_ALLOWED" });
  });

  it("permits only server-owned numeric exceptions", async () => {
    const allowed = readSourceAccessPolicy({ NODE_ENV: "test", SOURCE_ALLOWED_IP_CIDRS: "203.0.113.8/32,198.51.100.0/24" });
    await expect(validateSourceBaseUrl("https://203.0.113.8", allowed)).resolves.toMatchObject({ ok: true });
    await expect(validateSourceBaseUrl("https://198.51.100.16", allowed)).resolves.toMatchObject({ ok: true });
    await expect(validateSourceBaseUrl("https://203.0.113.9", allowed)).resolves.toEqual({ ok: false, code: "SOURCE_DESTINATION_NOT_ALLOWED" });
  });
});
