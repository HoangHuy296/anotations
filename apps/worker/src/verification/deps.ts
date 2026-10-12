import { MEDIA_VERIFICATION_PROBE_TIMEOUT_MS, MEDIA_VERIFICATION_SOURCE_CAP_BYTES } from "@annotationplatform/domain/media-verification";
import type { ProviderConfig } from "@annotationplatform/domain";

import { buildPremediaProbeArgs, interpretProbeCompletion, parseFfprobeVersion, PROBE_LIMITS } from "../media/classification-policy.js";
import { runBoundedMediaProcess } from "../media/subprocess.js";
import { withJobTempWorkspace } from "../media/temp-workspace.js";
import { assertAssetWritesNotQuiesced } from "../providers/asset-write-quiescence-guard.js";
import { assertSealedOwnerReady } from "../providers/sealed-namespace.js";
import type { ProbeRun, VerifierDeps } from "./types.js";

/** Runs the fixed section 6.1 invocation and maps every bounded-process outcome onto the R5 completion semantics. */
export function createFfprobeRunner(options: { command?: string; timeoutMs?: number; ffprobeVersion: () => Promise<string> }): VerifierDeps["probe"] {
  return async ({ filePath, cwd, isCancellationRequested }): Promise<ProbeRun> => {
    const ffprobeVersion = await options.ffprobeVersion();
    const result = await runBoundedMediaProcess({ command: options.command ?? "ffprobe", args: buildPremediaProbeArgs(filePath), cwd, timeoutMs: options.timeoutMs ?? PROBE_LIMITS.timeoutMs, maxOutputBytes: PROBE_LIMITS.outputCapBytes, isCancellationRequested });
    if (result.kind === "canceled") return { kind: "CANCELED" };
    const base = { ffprobeVersion, spawnError: false, timedOut: false, signal: null as string | null, exitCode: null as number | null, stdoutTruncated: false, stdout: "", stderr: "" };
    const completion = interpretProbeCompletion(
      result.kind === "completed" ? { ...base, exitCode: 0, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") }
        : result.kind === "timed_out" ? { ...base, timedOut: true }
          : result.kind === "spawn_failed" ? { ...base, spawnError: true }
            : result.kind === "output_limit_exceeded" ? { ...base, stdoutTruncated: true }
              : { ...base, exitCode: result.exitCode, signal: result.signal ?? null, stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8") },
    );
    return completion;
  };
}

let cachedVersions: Promise<{ ffprobeVersion: string; processorVersion: string }> | undefined;
export function resolveVerifierVersions(options: { command?: string; revision?: string } = {}) {
  cachedVersions ??= (async () => {
    const result = await runBoundedMediaProcess({ command: options.command ?? "ffprobe", args: ["-version"], cwd: "/", timeoutMs: 10_000, maxOutputBytes: 16 * 1024 });
    const banner = result.kind === "completed" ? result.stdout.toString("utf8").split("\n")[0] ?? "" : "";
    const ffprobeVersion = parseFfprobeVersion(banner);
    return { ffprobeVersion, processorVersion: `worker@${options.revision ?? process.env.WORKER_IMAGE_REVISION ?? "unversioned"}+ffprobe@${ffprobeVersion}` };
  })();
  return cachedVersions;
}

/** Production dependencies. The verifier identity is mandatory: a missing or non-distinct verifier identity fails closed (it never falls back to the general identity). */
export function createVerifierDeps(config: ProviderConfig): VerifierDeps {
  const minio = assertSealedOwnerReady(config);
  const versions = () => resolveVerifierVersions();
  return {
    minio, bucket: config.MINIO_BUCKET, now: () => new Date(),
    probe: createFfprobeRunner({ ffprobeVersion: async () => (await versions()).ffprobeVersion }),
    versions, assertWritesNotQuiesced: assertAssetWritesNotQuiesced,
    withTempWorkspace: withJobTempWorkspace,
    sourceCapBytes: MEDIA_VERIFICATION_SOURCE_CAP_BYTES, probeTimeoutMs: MEDIA_VERIFICATION_PROBE_TIMEOUT_MS,
  };
}
