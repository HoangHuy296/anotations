import { randomBytes } from "node:crypto";

import { Client as MinioClient } from "minio";

import type { ProviderConfig } from "@annotationplatform/domain";

import { createWorkerMinio } from "./minio.js";

/**
 * Storage-authority boundary for the A2 sealed namespace (specs/029-modality-specific-datasets/contracts/premedia-verification-a2.md §5.5, decision R9/M1).
 *
 * Objects under `verified-uploads/` are owned by exactly one MinIO identity (I-VERIFIER). Every other application identity is denied
 * mutation there by IAM. This module is the application-side half of that boundary:
 *  - `classifyStorageKey` is the single trusted classification of a storage key;
 *  - `routeSealedDeletes` sends deletions of sealed keys to the owner client and every other deletion to the general client, **by the key
 *    alone** — callers can neither select nor supply a privilege;
 *  - the owner credentials come only from the worker-only `MINIO_VERIFIER_*` variables, with **no fallback** to `MINIO_*`, root or any other
 *    identity.
 * Nothing here logs or returns a secret.
 */
export const SEALED_PREFIX = "verified-uploads/";

export type StorageNamespace = "SEALED" | "GENERAL" | "INVALID";

export type SealedNamespaceErrorCode =
  | "SEALED_OWNER_UNAVAILABLE"
  | "SEALED_OWNER_CREDENTIALS_PARTIAL"
  | "SEALED_OWNER_NOT_DISTINCT"
  | "SEALED_NAMESPACE_WRITABLE"
  | "STORAGE_KEY_INVALID";

export class SealedNamespaceError extends Error {
  constructor(readonly code: SealedNamespaceErrorCode) {
    super(code);
    this.name = "SealedNamespaceError";
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\\]/;

/**
 * Trusted, literal (S3-semantics) classification. A key is SEALED only if it starts with the exact, case-sensitive sealed prefix. Keys that
 * cannot be classified with certainty (control characters, backslashes, leading or doubled slashes, dot segments, case-variants of the sealed
 * prefix, non-strings, over-long keys) are INVALID: they are never deleted and never routed to a privileged client.
 */
export function classifyStorageKey(key: unknown): StorageNamespace {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return "INVALID";
  if (CONTROL.test(key) || key.startsWith("/") || key.includes("//")) return "INVALID";
  if (key.split("/").some((segment) => segment === "." || segment === "..")) return "INVALID";
  if (key.startsWith(SEALED_PREFIX)) return "SEALED";
  if (key.toLowerCase().startsWith(SEALED_PREFIX)) return "INVALID";
  return "GENERAL";
}

export type SealedOwnerCredentials = { accessKey: string; secretKey: string };

/** Worker-only credentials. Absent ⇒ `null`; exactly one of the pair ⇒ error; never falls back to another identity. */
export function readSealedOwnerCredentials(env: NodeJS.ProcessEnv): SealedOwnerCredentials | null {
  const accessKey = env.MINIO_VERIFIER_ACCESS_KEY?.trim() ?? "";
  const secretKey = env.MINIO_VERIFIER_SECRET_KEY?.trim() ?? "";
  if (!accessKey && !secretKey) return null;
  if (!accessKey || !secretKey) throw new SealedNamespaceError("SEALED_OWNER_CREDENTIALS_PARTIAL");
  return { accessKey, secretKey };
}

/** The owner must be a distinct identity from the general worker identity (a shared credential would void the boundary). */
export function createSealedOwnerMinio(config: ProviderConfig, env: NodeJS.ProcessEnv = process.env): MinioClient | null {
  const credentials = readSealedOwnerCredentials(env);
  if (!credentials) return null;
  if (credentials.accessKey === config.MINIO_ACCESS_KEY) throw new SealedNamespaceError("SEALED_OWNER_NOT_DISTINCT");
  const endpoint = new URL(config.MINIO_ENDPOINT);
  return new MinioClient({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    useSSL: endpoint.protocol === "https:",
    accessKey: credentials.accessKey,
    secretKey: credentials.secretKey,
  });
}

/** A2 readiness: a missing verifier identity fails closed (never defaults to the general identity). */
export function assertSealedOwnerReady(config: ProviderConfig, env: NodeJS.ProcessEnv = process.env): MinioClient {
  const owner = createSealedOwnerMinio(config, env);
  if (!owner) throw new SealedNamespaceError("SEALED_OWNER_UNAVAILABLE");
  return owner;
}

type DeleteTarget = string | { name: string; versionId?: string };
const keyOf = (target: DeleteTarget) => (typeof target === "string" ? target : target.name);

/**
 * Wraps the general client so that `removeObject`/`removeObjects` are routed by `classifyStorageKey`. Everything else is delegated untouched.
 * SEALED without an owner client ⇒ `SEALED_OWNER_UNAVAILABLE`; INVALID ⇒ `STORAGE_KEY_INVALID` (checked for the whole batch before any
 * deletion happens).
 */
export function routeSealedDeletes(general: MinioClient, sealedOwner: MinioClient | null): MinioClient {
  const clientFor = (key: string): MinioClient => {
    const namespace = classifyStorageKey(key);
    if (namespace === "INVALID") throw new SealedNamespaceError("STORAGE_KEY_INVALID");
    if (namespace === "GENERAL") return general;
    if (!sealedOwner) throw new SealedNamespaceError("SEALED_OWNER_UNAVAILABLE");
    return sealedOwner;
  };
  const overrides = {
    removeObject: async (bucket: string, key: string, options?: unknown) => {
      const client = clientFor(key);
      return (client.removeObject as (b: string, k: string, o?: unknown) => Promise<void>).call(client, bucket, key, options);
    },
    removeObjects: async (bucket: string, targets: DeleteTarget[]) => {
      const sealed: DeleteTarget[] = [];
      const general_: DeleteTarget[] = [];
      for (const target of targets) (clientFor(keyOf(target)) === general ? general_ : sealed).push(target);
      if (general_.length) await general.removeObjects(bucket, general_ as never);
      if (sealed.length) await sealedOwner!.removeObjects(bucket, sealed as never);
    },
  } as const;
  return new Proxy(general, {
    get(target, property, receiver) {
      if (property === "removeObject" || property === "removeObjects") return overrides[property];
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The worker's general client with trusted sealed-key delete routing; the owner client exists only when `MINIO_VERIFIER_*` is configured. */
export function createRoutedWorkerMinio(config: ProviderConfig, env: NodeJS.ProcessEnv = process.env): MinioClient {
  return routeSealedDeletes(createWorkerMinio(config), createSealedOwnerMinio(config, env));
}

/**
 * Readiness probe for a NON-owner identity: it must be unable to write under the sealed namespace. A harmless sentinel PUT is attempted; a
 * 403 is the expected, passing outcome. If the write unexpectedly succeeds the process fails closed (the sentinel is an unreferenced object
 * collected by the sealed-owner GC). Any non-authorization error is rethrown (inconclusive ⇒ not ready).
 */
export async function assertNoSealedWriteAuthority(client: MinioClient, bucket: string): Promise<void> {
  const key = `${SEALED_PREFIX}.authority-probe/${randomBytes(12).toString("hex")}`;
  try {
    await client.putObject(bucket, key, Buffer.from("0"), 1);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "AccessDenied") return;
    throw error;
  }
  throw new SealedNamespaceError("SEALED_NAMESPACE_WRITABLE");
}
