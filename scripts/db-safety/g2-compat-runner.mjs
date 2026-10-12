// Evidence-only wrapper for the G2 compatibility checks. Behavior is unchanged
// and fail-closed: any check that does not exit 0 with no signal and no spawn
// error stops the sequence and throws G2_SCHEMA_COMPATIBILITY_FAILED. There is
// no retry and a failure is never downgraded to a warning. Every spawned child
// is now recorded (identity, spawn error, status, signal, duration, bounded and
// redacted output) so a failure can be diagnosed from the run log alone.
import { redact } from './guard.mjs';

export const OUTPUT_LIMIT = 4096;

/** Keep the tail (where errors are), mark truncation, redact database URLs. */
export function boundedRedacted(value, limit = OUTPUT_LIMIT, secrets = []) {
  let text = redact(String(value ?? ''));
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[REDACTED]');
  return text.length > limit ? { text: text.slice(-limit), truncated: true, totalChars: text.length } : { text, truncated: false, totalChars: text.length };
}

const safeCode = value => (typeof value === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(value) ? value : null);

/** Pure description of one finished spawn. */
export function describeChild(check, result, durationMs, secrets = []) {
  const error = result?.error ?? null;
  const status = typeof result?.status === 'number' ? result.status : null;
  const signal = safeCode(result?.signal);
  const spawnErrorCode = error ? safeCode(error.code) ?? 'SPAWN_ERROR' : null;
  const outcome = error ? 'SPAWN_FAILED' : signal ? 'KILLED_BY_SIGNAL' : status === 0 ? 'EXIT_0' : status === null ? 'NO_EXIT_STATUS' : 'EXIT_NONZERO';
  return {
    check,
    outcome,
    spawned: !error,
    spawnErrorCode,
    status,
    signal,
    durationMs: Math.round(durationMs),
    stdout: boundedRedacted(result?.stdout, OUTPUT_LIMIT, secrets),
    stderr: boundedRedacted(result?.stderr, OUTPUT_LIMIT, secrets),
  };
}
export const isPass = record => record.outcome === 'EXIT_0';

/**
 * Runs the checks in order. `spawn(check)` returns a spawnSync-shaped result.
 * `log` receives the legacy combined output and one G2_COMPAT_CHECK JSON line per child.
 */
export function runCompatibilityChecks(checks, spawn, { log = console.log, now = () => performance.now(), secrets = [] } = {}) {
  const records = [];
  for (const check of checks) {
    const started = now();
    let result;
    try { result = spawn(check); } catch (error) { result = { error, status: null, signal: null, stdout: '', stderr: '' }; }
    const record = describeChild(check.name, result, now() - started, secrets);
    records.push(record);
    log(boundedRedacted((result?.stdout ?? '') + (result?.stderr ?? ''), Number.MAX_SAFE_INTEGER, secrets).text);
    log('G2_COMPAT_CHECK ' + JSON.stringify(record));
    if (!isPass(record)) {
      const failure = Error('G2_SCHEMA_COMPATIBILITY_FAILED');
      failure.compatibilityRecords = records;
      throw failure;
    }
  }
  return records;
}
