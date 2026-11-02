import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import process from 'node:process';
import { URL } from 'node:url';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('jackpot migration preserves old stacks and the original dealt order, and locks financial tables', { skip: !databaseUrl }, async () => {
  assert.match(databaseUrl, /(?:_|-)test(?:\?|$|\/)/);
  const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
  const { Client } = require('pg');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA jackpot_upgrade_fixture; SET LOCAL search_path TO jackpot_upgrade_fixture');
    await client.query(`CREATE TABLE "Room" ("id" UUID PRIMARY KEY, "hostPlayerId" UUID);
      CREATE TABLE "Player" ("id" UUID PRIMARY KEY, "roomId" UUID, "currentStack" INTEGER, "createdAt" TIMESTAMP);
      CREATE TABLE "GameSnapshot" ("roomId" UUID, "sequence" INTEGER, "state" JSONB);
      CREATE TABLE "ChipAdjustment" ("stackBefore" INTEGER, "stackAfter" INTEGER);
      INSERT INTO "Room" VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003');
      INSERT INTO "Player" VALUES
        ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 500, '2026-01-01'),
        ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 700, '2026-01-01');`);
    await client.query('INSERT INTO "GameSnapshot" VALUES ($1, 0, $2)', ['00000000-0000-4000-8000-000000000001', JSON.stringify({ snapshot: { hand: { seats: [
      { playerId: '00000000-0000-4000-8000-000000000003', seatNumber: 1 }, { playerId: '00000000-0000-4000-8000-000000000002', seatNumber: 2 },
    ] } } })]);
    await client.query(await readFile(new URL('../apps/server/prisma/migrations/20261102113100_shared_seven_deuce_jackpot/migration.sql', import.meta.url), 'utf8'));
    assert.deepEqual((await client.query('SELECT "currentStack", "seatOrder" FROM "Player" ORDER BY "seatOrder"')).rows, [
      { currentStack: 700, seatOrder: 0 }, { currentStack: 500, seatOrder: 1 },
    ]);
    assert.equal((await client.query('SELECT "balanceUnits" FROM "JackpotPool"')).rows[0].balanceUnits, 0);
    const tables = (await client.query(`SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'jackpot_upgrade_fixture' AND c.relname IN ('JackpotPool', 'JackpotHand')`)).rows;
    assert.equal(tables.length, 2);
    assert.ok(tables.every((table) => table.relrowsecurity));
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
