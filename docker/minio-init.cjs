// One-shot MinIO bootstrap run by the `minio-init` Compose service with the MinIO root credentials.
// It only creates a MISSING bucket (plus the direct-upload expiry rule on that new bucket). An existing bucket is never touched, so the
// least-privilege identities/policies/lifecycle provisioned on it are never overwritten.
const { Client } = require("minio");
const url = new URL(process.env.MINIO_ENDPOINT);
const client = new Client({ endPoint: url.hostname, port: Number(url.port || 9000), useSSL: url.protocol === "https:", accessKey: process.env.MINIO_ROOT_USER, secretKey: process.env.MINIO_ROOT_PASSWORD });
const bucket = process.env.MINIO_BUCKET;
const days = Number(process.env.MINIO_TEMP_UPLOAD_LIFECYCLE_DAYS || 7);
(async () => {
  if (await client.bucketExists(bucket)) { console.log("MinIO bucket already present: " + bucket); return; }
  await client.makeBucket(bucket);
  await client.setBucketLifecycle(bucket, { Rule: [{ ID: "annotationplatform-expire-direct-uploads", Status: "Enabled", Filter: { Prefix: "direct-uploads/" }, Expiration: { Days: days } }] });
  console.log("MinIO bucket created: " + bucket);
})().catch((error) => { console.error("MinIO provisioning failed: " + (error.code || error.message)); process.exit(1); });
