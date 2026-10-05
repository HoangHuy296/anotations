import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { findProcesses, identityOf, isMonitorProcess, matchesArgv, parseStat, selfAndAncestors, waitForExit } from '../process-monitor.mjs';

const MONITOR = fileURLToPath(new URL('../process-monitor.mjs', import.meta.url));
const marker = () => `zz-intended-${randomBytes(6).toString('hex')}.js`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** A real child whose argv carries `name` as a whole element, alive for `ms`. */
const child = (name, ms) => spawn(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`, '--', name], { stdio: 'ignore' });
const monitor = (...args) => spawnSync(process.execPath, [MONITOR, ...args], { encoding: 'utf8' });

// ---- required behavior, with real processes -------------------------------------------------------------

test('intended process alive: found by script name, with a pinned identity', async () => {
  const name = marker(), proc = child(name, 6000);
  try {
    await sleep(200);
    const found = findProcesses({ script: name });
    assert.deepEqual(found.map(entry => entry.pid), [proc.pid]);
    assert.match(found[0].start, /^\d+$/);
    assert.deepEqual(identityOf(proc.pid), { pid: proc.pid, start: found[0].start });
    const cli = monitor('find', '--script', name);
    assert.equal(cli.status, 0); assert.deepEqual(JSON.parse(cli.stdout).matches.map(entry => entry.pid), [proc.pid]);
  } finally { proc.kill('SIGKILL'); }
});

test('intended process absent: nothing found and the CLI reports exit 1', () => {
  const name = marker();
  assert.deepEqual(findProcesses({ script: name }), []);
  const cli = monitor('find', '--script', name);
  assert.equal(cli.status, 1); assert.deepEqual(JSON.parse(cli.stdout).matches, []);
});

test('the monitor/search process alone never produces a false positive, even when its own shell text contains the pattern', async () => {
  const name = marker();
  // The enclosing bash -c command text and this node process's argv both contain `name`.
  const run = spawnSync('bash', ['-c', `node ${MONITOR} find --script ${name}; echo "rc=$?"`], { encoding: 'utf8' });
  assert.match(run.stdout, /"matches":\[\]/); assert.match(run.stdout, /rc=1/);
  // Concurrent monitors waiting for the same name do not see each other either.
  const target = child(marker(), 6000);
  const other = spawn(process.execPath, [MONITOR, 'wait', '--pid', String(target.pid), '--timeout-ms', '4000', '--poll-ms', '200', '--arg', name], { stdio: 'ignore' });
  try { await sleep(200); assert.deepEqual(findProcesses({ script: name }), []); } finally { other.kill('SIGKILL'); target.kill('SIGKILL'); }
});

test('characterization: the original defect is real (naive pgrep -f matches its own shell) and this monitor does not have it', () => {
  const name = marker();
  const naive = spawnSync('bash', ['-c', `pgrep -f "${name}" >/dev/null && echo MATCHED || echo none`], { encoding: 'utf8' });
  assert.equal(naive.stdout.trim(), 'MATCHED'); // false positive: nothing intended is running
  const fixed = spawnSync('bash', ['-c', `node ${MONITOR} find --script "${name}" >/dev/null && echo MATCHED || echo none`], { encoding: 'utf8' });
  assert.equal(fixed.stdout.trim(), 'none');
});

test('intended process exits during observation: wait returns exited, never hangs on the monitor', async () => {
  const proc = child(marker(), 400);
  const started = Date.now();
  const result = await waitForExit({ pid: proc.pid }, { timeoutMs: 8000, pollMs: 50 });
  assert.equal(result.exited, true); assert.ok(['GONE', 'ZOMBIE'].includes(result.reason), result.reason);
  assert.ok(Date.now() - started < 6000);
  const cli = monitor('wait', '--pid', String(child(marker(), 300).pid), '--timeout-ms', '8000', '--poll-ms', '50');
  assert.equal(cli.status, 0); assert.equal(JSON.parse(cli.stdout).exited, true);
});

test('intended process still alive at the deadline: timeout, not a false exit', async () => {
  const proc = child(marker(), 6000);
  try {
    const result = await waitForExit({ pid: proc.pid }, { timeoutMs: 300, pollMs: 50 });
    assert.deepEqual({ exited: result.exited, timedOut: result.timedOut }, { exited: false, timedOut: true });
    const cli = monitor('wait', '--pid', String(proc.pid), '--timeout-ms', '300', '--poll-ms', '50');
    assert.equal(cli.status, 3);
  } finally { proc.kill('SIGKILL'); }
});

test('a reused pid (different kernel start time) is not the intended process', async () => {
  const proc = child(marker(), 6000);
  try {
    await sleep(100);
    const result = await waitForExit({ pid: proc.pid, start: '1' }, { timeoutMs: 2000, pollMs: 50 });
    assert.deepEqual({ exited: result.exited, reason: result.reason }, { exited: true, reason: 'START_TIME_CHANGED' });
  } finally { proc.kill('SIGKILL'); }
});

// ---- structural cases with a fake process table ---------------------------------------------------------

const table = entries => ({
  listPids: () => entries.map(entry => entry.pid),
  readCmdline: pid => { const entry = entries.find(item => item.pid === pid); return entry ? entry.argv.join('\0') + '\0' : null; },
  readStat: pid => { const entry = entries.find(item => item.pid === pid); return entry ? `${pid} (${entry.comm ?? 'node'}) ${entry.state ?? 'S'} ${entry.ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${entry.start ?? 1000} 0 0` : null; },
});

test('matching is per argv element and never a substring search of the joined command line', () => {
  assert.equal(matchesArgv(['python3', 'scripts/db-safety/g3-rehearse.py', '--g5'], { script: 'g3-rehearse.py' }), true);
  assert.equal(matchesArgv(['python3', 'g3-rehearse.py'], { script: 'g3-rehearse.py', exe: 'python3' }), true);
  assert.equal(matchesArgv(['/bin/bash', '-c', 'until ! pgrep -f "g3-rehearse.py"; do sleep 1; done'], { script: 'g3-rehearse.py' }), false);
  assert.equal(matchesArgv(['python3', 'old-g3-rehearse.py'], { script: 'g3-rehearse.py' }), false);
  assert.equal(matchesArgv(['python3', 'x.py', '--g5'], { script: 'x.py', args: ['--g5'] }), true);
  assert.equal(matchesArgv(['python3', 'x.py'], { script: 'x.py', args: ['--g5'] }), false);
  assert.equal(matchesArgv(['node', 'g3-rehearse.py'], { exe: 'python3', script: 'g3-rehearse.py' }), false);
});

test('self, ancestors and other monitor instances are excluded; a zombie is not a live match', () => {
  const entries = [
    { pid: 10, ppid: 1, argv: ['python3', 'scripts/db-safety/g3-rehearse.py', '--g5'], start: 111 },
    { pid: 20, ppid: 1, argv: ['/bin/bash', '-c', 'node process-monitor.mjs find --script g3-rehearse.py'] },
    { pid: 21, ppid: 20, argv: ['node', '/x/scripts/db-safety/process-monitor.mjs', 'find', '--script', 'g3-rehearse.py'] },
    { pid: 30, ppid: 1, argv: ['node', '/x/scripts/db-safety/process-monitor.mjs', 'wait', '--script', 'g3-rehearse.py'] },
    { pid: 40, ppid: 1, argv: ['python3', 'g3-rehearse.py'], state: 'Z' },
    { pid: 50, ppid: 21, argv: ['sh', '-c', 'echo g3-rehearse.py'] },
  ];
  const found = findProcesses({ script: 'g3-rehearse.py' }, { proc: table(entries), selfPid: 21 });
  assert.deepEqual(found.map(entry => entry.pid), [10]);
  assert.deepEqual([...selfAndAncestors(entries, 21)].sort((a, b) => a - b), [1, 20, 21]);
  assert.equal(isMonitorProcess(entries[2].argv), true); assert.equal(isMonitorProcess(entries[0].argv), false);
});

test('stat parsing survives command names with spaces and parentheses', () => {
  const stat = `123 (my (weird) name) S 77 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 987654 0 0`;
  assert.deepEqual(parseStat(stat), { state: 'S', ppid: 77, start: '987654' });
  assert.equal(parseStat('garbage'), null); assert.equal(parseStat(undefined), null);
});

test('an empty spec is rejected rather than matching everything', () => {
  assert.throws(() => findProcesses({}), /PROCESS_MONITOR_SPEC_REQUIRED/);
  assert.equal(monitor('find').status, 2);
});
