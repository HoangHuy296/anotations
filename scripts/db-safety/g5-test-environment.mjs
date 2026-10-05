// Exact G5 regression command enables only test switches; resource targets
// remain the already verified private G1 configuration and cannot be replaced.
import { verify, must } from './guard.mjs';
const incoming = process.env.DATABASE_URL;
const checked = await verify(process.env.DB_SAFETY_RECEIPT, 'test');
must(checked.r.command === 'web:test:g5-regressions', 'G5_REGRESSION_SCOPE_REQUIRED');
must(incoming === checked.target.url.toString(), 'TEST_DATASOURCE_OVERRIDE');
for (const [key, value] of Object.entries(checked.env)) must(process.env[key] === value, 'TEST_PROVIDER_OVERRIDE');
process.env.DATABASE_URL = checked.target.url.toString();
process.env.WORKSPACE_INTEGRATION_TESTS = '1';
process.env.VIDEO_ANNOTATION_READ_MODEL_TESTS = '1';
