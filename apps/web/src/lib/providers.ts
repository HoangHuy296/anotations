import "server-only";

import { Client as MinioClient } from "minio";

import { readProviderConfig } from "@fieldframe/domain";

import { db } from "@/lib/db";

export function getWebProviders() {
  const config = readProviderConfig();
  const endpoint = new URL(config.MINIO_ENDPOINT);
  const minio = new MinioClient({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    useSSL: endpoint.protocol === "https:",
    accessKey: config.MINIO_ACCESS_KEY,
    secretKey: config.MINIO_SECRET_KEY,
  });

  return { config, db, minio };
}
