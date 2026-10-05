import '../test-entry.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PrismaClient } from '../../../lib/generated/prisma/client';
const require = createRequire(import.meta.url);

test('native Prisma constructor rejects explicit alternative URL before connection', () => {
  assert.throws(() => new PrismaClient({datasourceUrl:'postgresql://forbidden:fixture@127.0.0.1:5433/fieldframe'}), /DB_SAFETY_PRISMA_DATASOURCE_DENIED/);
});
test('actual Prisma writes only disposable data and transaction rolls back', async () => {
  const db = new PrismaClient();
  try {
    const count = await db.user.count();
    await assert.rejects(db.$transaction(async tx => {
      await tx.user.create({data:{id:'g1-fixture',email:'g1-fixture@test.invalid',role:'ADMIN'},select:{id:true}});
      assert.equal(await tx.user.count(), count + 1);
      throw new Error('G1_ROLLBACK');
    }), /G1_ROLLBACK/);
    assert.equal(await db.user.count(),count);
  } finally { await db.$disconnect(); }
});
test('isolated Redis and MinIO are usable; cleanup stays in fixture namespace', async () => {
  const workerRequire = createRequire(require.resolve('../../../apps/worker/package.json'));
  const Redis = workerRequire('ioredis');
  const { Client } = workerRequire('minio');
  const redis = new Redis({host:process.env.REDIS_HOST,port:Number(process.env.REDIS_PORT),password:process.env.REDIS_PASSWORD,maxRetriesPerRequest:0});
  const endpoint = new URL(process.env.MINIO_ENDPOINT!);
  const minio = new Client({endPoint:endpoint.hostname,port:Number(endpoint.port),useSSL:false,accessKey:process.env.MINIO_ACCESS_KEY,secretKey:process.env.MINIO_SECRET_KEY});
  const key = `${process.env.BULLMQ_PREFIX}:fixture`;
  const bucket = process.env.MINIO_BUCKET!;
  try {
    await redis.set(key,'isolated'); assert.equal(await redis.get(key),'isolated');
    await minio.makeBucket(bucket);
    await minio.putObject(bucket,'fixture.txt',Buffer.from('isolated'));
    assert.equal((await minio.statObject(bucket,'fixture.txt')).size,8);
    await minio.removeObject(bucket,'fixture.txt'); await minio.removeBucket(bucket);
  } finally {await redis.del(key);await redis.quit();}
});
