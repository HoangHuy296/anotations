import "server-only";

import { Client as MinioClient } from "minio";

import { readDirectUploadConfig, readProviderConfig } from "@fieldframe/domain";

import { db } from "@/lib/db";

function createMinioClient(endpointValue: string, accessKey: string, secretKey: string, region?: string) {
  const endpoint = new URL(endpointValue);
  return new MinioClient({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    useSSL: endpoint.protocol === "https:",
    accessKey,
    secretKey,
    region,
  });
}

/**
 * POST policies are signed against the private service endpoint, then exposed
 * through the separately configured browser-reachable endpoint. The policy
 * signature binds bucket/key/form fields, not the host name.
 */
export function browserReachableMinioUrl(signedUrl: string, publicEndpoint: string) {
  const signed = new URL(signedUrl);
  const publicBase = new URL(publicEndpoint);
  return new URL(`${signed.pathname}${signed.search}`, publicBase).toString();
}

export function getWebProviders() {
  const config = readProviderConfig();
  const minio = createMinioClient(config.MINIO_ENDPOINT, config.MINIO_ACCESS_KEY, config.MINIO_SECRET_KEY);

  return { config, db, minio };
}

/** Server-only clients for constrained browser upload/view capabilities. */
export function getDirectUploadProviders() {
  const config = readDirectUploadConfig();
  return {
    config,
    db,
    minio: createMinioClient(config.MINIO_ENDPOINT, config.MINIO_ACCESS_KEY, config.MINIO_SECRET_KEY),
    // Supplying MinIO's default region lets the server sign a browser-facing
    // URL without trying to contact that public endpoint from its container.
    publicMinio: createMinioClient(config.MINIO_PUBLIC_ENDPOINT, config.MINIO_ACCESS_KEY, config.MINIO_SECRET_KEY, "us-east-1"),
  };
}
