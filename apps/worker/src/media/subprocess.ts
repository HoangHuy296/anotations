import { spawn } from "node:child_process";

export type MediaProcessResult =
  | { kind: "completed"; exitCode: number; stdout: Buffer; stderr: Buffer }
  | { kind: "failed"; exitCode: number | null }
  | { kind: "canceled" }
  | { kind: "timed_out" }
  | { kind: "output_limit_exceeded" }
  | { kind: "spawn_failed" };

export type RunBoundedMediaProcessInput = {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  isCancellationRequested?: () => Promise<boolean>;
  cancellationPollMs?: number;
};

function appendBounded(chunks: Buffer[], next: Buffer, state: { size: number }, maxBytes: number) {
  state.size += next.length;
  if (state.size > maxBytes) return false;
  chunks.push(next);
  return true;
}

/**
 * Runs an approved local media command without a shell. Tool output remains an
 * internal parsing input: callers receive a classified failure, never a raw
 * spawn error or an unbounded transcript suitable for a JobEvent/response.
 */
export async function runBoundedMediaProcess(input: RunBoundedMediaProcessInput): Promise<MediaProcessResult> {
  return new Promise<MediaProcessResult>((resolve) => {
    let settled = false;
    let cancellationTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let terminal: MediaProcessResult | null = null;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutSize = { size: 0 };
    const stderrSize = { size: 0 };

    const finish = (result: MediaProcessResult) => {
      if (settled) return;
      settled = true;
      if (cancellationTimer) clearInterval(cancellationTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      finish({ kind: "spawn_failed" });
      return;
    }

    const terminate = (reason: Exclude<MediaProcessResult, { kind: "completed" } | { kind: "failed" }>) => {
      if (terminal) return;
      terminal = reason;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), Math.min(5_000, Math.max(100, input.timeoutMs))).unref();
    };

    child.once("error", () => finish({ kind: "spawn_failed" }));
    child.stdout.on("data", (chunk: Buffer) => {
      if (!appendBounded(stdout, Buffer.from(chunk), stdoutSize, input.maxOutputBytes)) terminate({ kind: "output_limit_exceeded" });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!appendBounded(stderr, Buffer.from(chunk), stderrSize, input.maxOutputBytes)) terminate({ kind: "output_limit_exceeded" });
    });
    child.once("close", (code) => {
      if (terminal) return finish(terminal);
      if (code === 0) return finish({ kind: "completed", exitCode: 0, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      return finish({ kind: "failed", exitCode: code });
    });

    timeoutTimer = setTimeout(() => terminate({ kind: "timed_out" }), input.timeoutMs).unref();
    if (input.isCancellationRequested) {
      const poll = async () => {
        try {
          if (await input.isCancellationRequested?.()) terminate({ kind: "canceled" });
        } catch {
          // Fail closed: a cancellation-state read failure must not permit an
          // unbounded private tool invocation to continue.
          terminate({ kind: "canceled" });
        }
      };
      void poll();
      cancellationTimer = setInterval(() => { void poll(); }, input.cancellationPollMs ?? 250);
      cancellationTimer.unref();
    }
  });
}
