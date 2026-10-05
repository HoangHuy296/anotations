// Deterministic process monitoring for verification runs. It replaces ad-hoc
// `until ! pgrep -f "<command line>"` wait loops, which match their own shell
// (the shell's command text contains the pattern) and therefore never see the
// target exit.
//
// Rules that make a self-match impossible:
//   1. Matching is per argv element (exact, or a path ending in "/<name>"); it never
//      searches the joined command line, so `bash -c '...<pattern>...'` cannot match.
//   2. The monitor's own process, its ancestors, and every other process running
//      this script are excluded, because their argv legitimately contains the pattern.
//   3. A process is identified by PID plus kernel start time, so a reused PID is not
//      mistaken for the intended process. A zombie counts as exited.
//
// CLI:  node scripts/db-safety/process-monitor.mjs find --script NAME [--exe NAME] [--arg VALUE ...]
//       node scripts/db-safety/process-monitor.mjs wait --pid N [--start TICKS] [--timeout-ms N] [--poll-ms N]
//   find: prints JSON, exit 0 if at least one process matches, 1 if none.
//   wait: exit 0 when the process has exited, 3 on timeout, 2 on usage error.
import { readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

export const MONITOR_SCRIPT = 'process-monitor.mjs';

/** /proc-backed accessor; replaceable in tests. */
export const realProc = {
  listPids: () => readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number),
  readCmdline: pid => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { return null; } },
  readStat: pid => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; } },
};

/** Parses /proc/<pid>/stat; the command name may contain spaces and parentheses, so split after the last ')'. */
export function parseStat(text) {
  if (typeof text !== 'string') return null;
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const fields = text.slice(close + 2).trim().split(/\s+/);
  const state = fields[0], ppid = Number(fields[1]), start = fields[19];
  return Number.isInteger(ppid) && state && /^\d+$/.test(start ?? '') ? { state, ppid, start } : null;
}

export function readProcess(pid, proc = realProc) {
  const stat = parseStat(proc.readStat(pid));
  const raw = proc.readCmdline(pid);
  if (!stat || raw === null) return null;
  return { pid, ppid: stat.ppid, state: stat.state, start: stat.start, argv: raw.split('\0').filter((part, index, all) => part !== '' || index < all.length - 1) };
}

export function listProcesses(proc = realProc) {
  return proc.listPids().map(pid => readProcess(pid, proc)).filter(Boolean);
}

const elementMatches = (element, name) => element === name || element.endsWith('/' + name);

/** True when every requested property matches whole argv elements. Never substring-searches. */
export function matchesArgv(argv, spec) {
  if (!Array.isArray(argv) || !argv.length) return false;
  if (spec.exe && basename(argv[0]) !== spec.exe) return false;
  if (spec.script && !argv.slice(1).some(element => elementMatches(element, spec.script))) return false;
  return (spec.args ?? []).every(value => argv.slice(1).includes(value));
}

export const isMonitorProcess = argv => argv.some(element => elementMatches(element, MONITOR_SCRIPT));

/** Pids of this process and all ancestors, followed through the parent links in the table. */
export function selfAndAncestors(table, pid = process.pid) {
  const byPid = new Map(table.map(entry => [entry.pid, entry]));
  const chain = new Set();
  for (let current = pid; current && !chain.has(current); current = byPid.get(current)?.ppid) chain.add(current);
  return chain;
}

/** Live (non-zombie) processes matching spec, excluding the monitor itself, its ancestors and other monitors. */
export function findProcesses(spec, { proc = realProc, selfPid = process.pid } = {}) {
  if (!spec || (!spec.script && !spec.exe && !(spec.args ?? []).length)) throw Error('PROCESS_MONITOR_SPEC_REQUIRED');
  const table = listProcesses(proc);
  const excluded = selfAndAncestors(table, selfPid);
  return table
    .filter(entry => !excluded.has(entry.pid) && !isMonitorProcess(entry.argv) && !['Z', 'X'].includes(entry.state) && matchesArgv(entry.argv, spec))
    .map(({ pid, ppid, start, argv }) => ({ pid, ppid, start, argv }));
}

/** Current identity token of a pid, or null when it does not exist / is a zombie. */
export function identityOf(pid, proc = realProc) {
  const entry = readProcess(pid, proc);
  return entry && !['Z', 'X'].includes(entry.state) ? { pid, start: entry.start } : null;
}

/**
 * Waits for the identified process to exit. `start` pins the identity; if the pid now
 * has a different start time it is a different process and the intended one is gone.
 */
export async function waitForExit({ pid, start }, { timeoutMs = 600000, pollMs = 500, proc = realProc, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw Error('PROCESS_MONITOR_PID_REQUIRED');
  const deadline = now() + timeoutMs;
  const pinned = start ?? identityOf(pid, proc)?.start ?? null;
  if (pinned === null) return { exited: true, reason: 'GONE', pid };
  for (;;) {
    const entry = readProcess(pid, proc);
    if (!entry) return { exited: true, reason: 'GONE', pid };
    if (entry.start !== String(pinned)) return { exited: true, reason: 'START_TIME_CHANGED', pid };
    if (['Z', 'X'].includes(entry.state)) return { exited: true, reason: 'ZOMBIE', pid };
    if (now() >= deadline) return { exited: false, timedOut: true, pid };
    await sleep(pollMs);
  }
}

function parseArgs(args) {
  const out = { args: [] };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (value === undefined) throw Error('PROCESS_MONITOR_USAGE');
    if (key === '--arg') out.args.push(value);
    else if (['--script', '--exe', '--pid', '--start', '--timeout-ms', '--poll-ms'].includes(key)) out[key.slice(2)] = value;
    else throw Error('PROCESS_MONITOR_USAGE');
  }
  return out;
}

if (process.argv[1] && basename(process.argv[1]) === MONITOR_SCRIPT) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    const options = parseArgs(rest);
    if (command === 'find') {
      const found = findProcesses({ script: options.script, exe: options.exe, args: options.args });
      console.log(JSON.stringify({ matches: found.map(({ pid, start }) => ({ pid, start })) }));
      process.exitCode = found.length ? 0 : 1;
    } else if (command === 'wait') {
      const result = await waitForExit({ pid: Number(options.pid), start: options.start }, { timeoutMs: Number(options['timeout-ms'] ?? 600000), pollMs: Number(options['poll-ms'] ?? 500) });
      console.log(JSON.stringify(result));
      process.exitCode = result.exited ? 0 : 3;
    } else throw Error('PROCESS_MONITOR_USAGE');
  } catch (error) {
    console.error(/^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'PROCESS_MONITOR_FAILED');
    process.exitCode = 2;
  }
}
