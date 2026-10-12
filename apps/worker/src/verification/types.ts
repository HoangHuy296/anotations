import type { Client as MinioClient } from "minio";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";
import type { PersistedProbe } from "../media/classification-policy.js";

/**
 * A2 verifier building blocks (contract section 5.3/5.4). Everything that touches the outside world is injected so each step is testable against real
 * PostgreSQL/MinIO and against deterministic fault injection without changing production code paths.
 */
export type VerifierMinio = Pick<MinioClient, "statObject" | "copyObject" | "getObject" | "removeObject">;

export type ProbeRun =
  | { kind: "CANCELED" }
  | { kind: "NOT_COMPLETED"; reason: "UPLOAD_VERIFICATION_PROBE_TIMEOUT" | "UPLOAD_VERIFICATION_PROBE_FAILED" }
  | { kind: "COMPLETED_INVALID"; marker: string }
  | { kind: "COMPLETED"; document: unknown };

export type VerifierDeps = {
  /** The I-VERIFIER identity: the only client that may write the sealed namespace. */
  minio: VerifierMinio;
  bucket: string;
  now: () => Date;
  /** Runs the fixed, bounded section 6.1 ffprobe invocation on a private temp file. */
  probe: (input: { filePath: string; cwd: string; isCancellationRequested: () => Promise<boolean> }) => Promise<ProbeRun>;
  /** `{ ffprobeVersion, processorVersion }`, resolved once per process. */
  versions: () => Promise<{ ffprobeVersion: string; processorVersion: string }>;
  /** Throws `AssetWritesQuiescedError` during a maintenance window. */
  assertWritesNotQuiesced: () => Promise<void>;
  withTempWorkspace: <T>(jobId: string, run: (workspace: { path: string }) => Promise<T>) => Promise<T>;
  /** Largest object the verifier will materialize (contract: 100 MiB, may only be lowered). */
  sourceCapBytes: number;
  probeTimeoutMs: number;
};

export type OperationalReason =
  | "UPLOAD_VERIFICATION_PROBE_TIMEOUT"
  | "UPLOAD_VERIFICATION_PROBE_FAILED"
  | "UPLOAD_VERIFICATION_STORAGE_FAILED"
  | "UPLOAD_VERIFICATION_LEASE_LOST";

/** A step's result. `advanced` re-enters the state loop; everything else leaves it. */
export type StepResult =
  | { kind: "advanced" }
  | { kind: "terminal" }
  | { kind: "operational"; reason: OperationalReason }
  | { kind: "retry_later"; runAfter: Date }
  | { kind: "lease_lost" };

export type VerificationRow = NonNullable<Awaited<ReturnType<PrismaClient["mediaVerification"]["findUnique"]>>>;

export type StepContext = {
  db: PrismaClient;
  deps: VerifierDeps;
  job: { id: string; datasetId: string; createdById: string | null; attempts: number; maxAttempts: number };
  lockToken: string;
};

export type { PersistedProbe };
