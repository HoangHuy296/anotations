// Offline pin test for scripts/mvp/fresh-install.mjs: its expected chain facts must equal the active repository, and must be the SAME M26 / manifest facts the guarded
// release chain proves (PROPOSAL_CHAIN, a2-chain.mjs). The live accept/reject behavior is exercised against throwaway G1 containers, not here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { PROPOSAL_CHAIN } from '../../db-safety/disposable-test.mjs';

const ROOT = resolve(import.meta.dirname, '../../..');
const source = readFileSync(join(ROOT, 'scripts/mvp/fresh-install.mjs'), 'utf8');
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const pinned = Object.fromEntries([...source.match(/const EXPECTED = \{([^}]*)\}/)[1].matchAll(/(\w+):\s*(?:'([^']*)'|(\d+))/g)].map(m => [m[1], m[2] ?? Number(m[3])]));
const migrations = readdirSync(join(ROOT, 'prisma/migrations'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
const file = suffix => join(ROOT, 'prisma/migrations', migrations.find(name => name.endsWith(suffix)), 'migration.sql');

test('fresh-install expects exactly the active 26-migration chain', () => {
  assert.equal(pinned.history, 26);
  assert.equal(migrations.length, pinned.history);
  assert.equal(pinned.schemaEntries, 1942);
  assert.equal(pinned.schemaManifestSha256, 'f6ab063b65f2293cef39f76dc2580bccb8165f6f686bf7591ded9e46102615c7');
});

test('fresh-install pins M24, M25 and M26 to the bytes of the active migration files and M26 is last', () => {
  assert.equal(pinned.m24, sha(file('_dataset_modality_g2')));
  assert.equal(pinned.m25, sha(file('_prepared_import_creation_request_hash')));
  assert.equal(pinned.m26, sha(file('_media_verification_a2')));
  assert.deepEqual(migrations.slice(-3).map(name => name.slice(15)), ['dataset_modality_g2', 'prepared_import_creation_request_hash', 'media_verification_a2']);
});

test('the M26 pin equals the reviewed A2 release-chain pin', () => {
  assert.equal(pinned.m26, PROPOSAL_CHAIN.find(entry => entry.name === '20261007000000_media_verification_a2').sha256);
});

test('no 25-migration or 1842-entry expectation survives in the installer checks', () => {
  assert.doesNotMatch(source, /canonical-chain-is-25|history-25-|manifest-1842|all 25 migrations/);
});
