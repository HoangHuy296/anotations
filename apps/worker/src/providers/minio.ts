import { Client as MinioClient } from "minio";

import type { ProviderConfig } from "@fieldframe/domain";

export function createWorkerMinio(config: ProviderConfig) {
  const endpoint = new URL(config.MINIO_ENDPOINT);
  return new MinioClient({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)),
    useSSL: endpoint.protocol === "https:",
    accessKey: config.MINIO_ACCESS_KEY,
    secretKey: config.MINIO_SECRET_KEY,
  });
}

export async function ensureBucket(client: MinioClient, bucket: string) {
  if (!(await client.bucketExists(bucket))) {
    await client.makeBucket(bucket);
  }
}
