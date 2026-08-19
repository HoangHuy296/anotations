import { randomBytes } from "node:crypto";

import { Modality, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";

/**
 * Shared fixtures/utilities for the OpenAPI contract suite
 * (specs/api/openapi.yaml). This suite is deliberately black-box: every test
 * talks to an already-running web service over real HTTP (no spawned
 * server, no in-process route-handler import) and asserts only what
 * openapi.yaml documents -- status code, envelope shape, and the documented
 * field set. It is not a substitute for the deeper business-logic suites
 * under tests/annotation-api, tests/direct-upload, tests/auth-ownership,
 * etc.; keep new edge-case coverage there and keep this suite focused on
 * "does the live response still match the published contract."
 */

export const contractBaseUrl = process.env.OPENAPI_CONTRACT_BASE_URL ?? "http://127.0.0.1:3000";
export const contractTestsEnabled = process.env.OPENAPI_CONTRACT_TESTS === "1";
export const contractPassword = "openapi-contract-test-password";

export function contractUnique(prefix: string) {
  return `${prefix}-${Date.now()}-${randomBytes(5).toString("hex")}`;
}

export async function createContractUser(role: UserRole = UserRole.MANAGER) {
  const marker = contractUnique("contract-user");
  const user = await db.user.create({
    data: { email: `${marker}@test.invalid`, name: marker, role, passwordHash: await hashPassword(contractPassword) },
    select: { id: true, email: true, name: true, role: true },
  });
  return { ...user, name: user.name ?? user.email };
}

export async function createContractDataset(ownerId: string) {
  return db.dataset.create({ data: { ownerId, name: contractUnique("contract-dataset") }, select: { id: true } });
}

export async function createContractAsset(datasetId: string, modality: Modality = Modality.IMAGE) {
  const marker = contractUnique("contract-asset");
  const byModality = {
    [Modality.IMAGE]: { filename: `${marker}.png`, mimeType: "image/png", width: 640, height: 480 },
    [Modality.VIDEO]: { filename: `${marker}.mp4`, mimeType: "video/mp4" },
    [Modality.AUDIO]: { filename: `${marker}.mp3`, mimeType: "audio/mpeg" },
    [Modality.TEXT]: { filename: `${marker}.txt`, mimeType: "text/plain" },
  } as const;
  return db.asset.create({
    data: { datasetId, modality, sourceFingerprint: marker, ...byModality[modality] },
    select: { id: true, revision: true },
  });
}

export async function createContractLabel(datasetId: string) {
  const marker = contractUnique("contract-label");
  return db.label.create({ data: { datasetId, modality: Modality.IMAGE, name: marker, normalizedName: marker, color: "#0EA5E9" }, select: { id: true } });
}

export async function cleanupContractFixture(userIds: string[], datasetIds: string[]) {
  await db.annotation.deleteMany({ where: { datasetId: { in: datasetIds } } });
  await db.videoObjectTrack.deleteMany({ where: { videoAsset: { asset: { datasetId: { in: datasetIds } } } } });
  await db.asset.deleteMany({ where: { datasetId: { in: datasetIds } } });
  await db.dataset.deleteMany({ where: { id: { in: datasetIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

/** Real HTTP call against the running server -- never an in-process route-handler import. */
export async function contractFetch(path: string, init?: RequestInit & { cookie?: string }) {
  const { cookie, headers, ...rest } = init ?? {};
  return fetch(`${contractBaseUrl}${path}`, {
    ...rest,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
  });
}

export function sessionCookieFrom(response: Response) {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const token = /^fieldframe_session=([^;]+)/.exec(setCookie)?.[1];
  return { setCookie, cookie: token ? `fieldframe_session=${token}` : null };
}

export async function contractLogin(email: string, password = contractPassword) {
  const response = await contractFetch("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  const { cookie } = sessionCookieFrom(response);
  if (!cookie) throw new Error(`contract login failed for ${email}: ${response.status}`);
  return cookie;
}

/** Asserts the object has exactly this key set -- no more, no less -- against the documented DTO. */
export function assertExactKeys(value: object, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join(",") !== wanted.join(",")) {
    throw new Error(`${label}: expected keys [${wanted.join(", ")}], got [${actual.join(", ")}]`);
  }
}
