import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verify, must, sha, safeFailure, root } from './guard.mjs';
const require = createRequire(import.meta.url);
const authority = require('./runtime-authority.cjs');
try {
  const r = authority.receipt();
  const incoming = authority.environment(r);
  const role = process.env.G1_RUNTIME_ROLE;
  const spec = r.roles[role];
  must(spec, 'RUNTIME_ROLE_UNAPPROVED');
  const loader = process.argv[2] === '--loader-thread';
  const entry = join(root, 'scripts/db-safety/runtime-child.mjs');
  const compiler = Boolean(process.env.G1_COMPILER_CLAIM);
  must(loader || resolve(process.argv[2] || '') === (compiler ? r.compiler.entry : entry), 'RUNTIME_ENTRY_UNAPPROVED');
  must(loader || JSON.stringify(JSON.parse(process.argv[3] || '[]')) === JSON.stringify(compiler ? [] : [role]), 'RUNTIME_ARGUMENT_MISMATCH');
  const { target, env, r: base } = await verify(r.baseReceipt, 'test');
  must(['g4:runtime:safety','g4:runtime:e2e','g5:runtime:e2e'].includes(base.command), 'RUNTIME_COMMAND_SCOPE_REQUIRED');
  must(incoming.DATABASE_URL === target.url.toString(), 'RUNTIME_DATASOURCE_MISMATCH');
  for (const [key, value] of Object.entries(env)) must(incoming[key] === value, 'RUNTIME_PROVIDER_MISMATCH');
  // The checker is a subprocess: validate the actual child, not this checker PID.
  const child = authority.identity(process.ppid);
  if (compiler) {
    must(role === 'web', 'RUNTIME_COMPILER_ROLE_DENIED');
    const compilers = require('./runtime-compilers.cjs');
    compilers.validateChild(r, child);
  } else must(child.parent === r.owner.pid, 'RUNTIME_PARENT_MISMATCH');
  must(sha(readFileSync(entry)) === spec.entryHash, 'RUNTIME_ENTRY_CHANGED');
  for (const [file, checksum] of Object.entries(r.projectHashes)) must(sha(readFileSync(file)) === checksum, 'RUNTIME_PROJECT_CHANGED');
  const record = { ...child, runtime: r.id, role };
  if (compiler) {
    // Publish acceptance only after every identity, target, entry and project
    // checksum check has succeeded. A failed startup cannot leave verified=true.
    const compilers = require('./runtime-compilers.cjs');
    if (!compilers.claim(r, process.env.G1_COMPILER_CLAIM).c.verified)
      compilers.recordState(r, process.env.G1_COMPILER_CLAIM, 'verified', true);
    console.log('RUNTIME_COMPILER_VERIFIED');
  } else if (loader || existsSync(join(r.ledger, `${role}.json`))) {
    const previous = authority.read(join(r.ledger, `${role}.json`));
    must(authority.same(child, previous), 'RUNTIME_LOADER_OWNER_MISMATCH');
  } else writeFileSync(join(r.ledger, `${role}.json`), JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  console.log('RUNTIME_CHILD_VERIFIED');
} catch (error) { console.error('SAFETY_ABORT', safeFailure(error)); process.exitCode = 1; }
