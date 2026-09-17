/** One in-flight pass per process; database leases still coordinate replicas. */
export function createPeriodicTask(operation: () => Promise<unknown>, onFailure: () => void) {
  let pending: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  function run(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (!pending) {
      pending = Promise.resolve().then(operation).then(() => undefined)
        .catch(() => { onFailure(); })
        .finally(() => { pending = null; });
    }
    return pending;
  }

  return {
    run,
    start(intervalMs: number) {
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError("Invalid maintenance interval.");
      if (timer || stopped) return;
      timer = setInterval(() => { void run(); }, intervalMs);
      timer.unref();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      await pending;
    },
  };
}
