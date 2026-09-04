import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test, before, after, beforeEach } from 'node:test';

const testDatabaseUrl = globalThis.process?.env.TEST_DATABASE_URL;
const integrationEnabled = testDatabaseUrl !== undefined;

const { prisma } = integrationEnabled
  ? await import('../apps/server/src/persistence/prisma.ts')
  : { prisma: undefined };
const { RoomRepository } = integrationEnabled
  ? await import('../apps/server/src/persistence/room-repository.ts')
  : { RoomRepository: undefined };
const { createApp } = integrationEnabled
  ? await import('../apps/server/src/app.ts')
  : { createApp: undefined };

let server;
let baseUrl;
let repository;

if (integrationEnabled) {
  before(async () => {
    assert.match(testDatabaseUrl, /(?:_|-)test(?:\?|$|\/)/, 'TEST_DATABASE_URL must use a test database');
    repository = new RoomRepository(prisma);
    server = createServer(createApp({ roomRepository: repository }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.settlement.deleteMany();
    await prisma.gameSnapshot.deleteMany();
    await prisma.gameEvent.deleteMany();
    await prisma.room.updateMany({ data: { hostPlayerId: null } });
    await prisma.player.deleteMany();
    await prisma.room.deleteMany();
  });
}

async function postRoom(body) {
  return globalThis.fetch(`${baseUrl}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /rooms persists a waiting room and its host then returns an opaque invite', { skip: !integrationEnabled }, async () => {
  const response = await postRoom({ displayName: '  Ada  ', initialStack: 1500 });

  assert.equal(response.status, 201);
  const result = await response.json();
  assert.match(result.roomId, /^[a-f0-9]{16}$/);
  assert.deepEqual(result, { roomId: result.roomId, invitePath: `/r/${result.roomId}` });

  const room = await repository.findRoomByJoinId(result.roomId);
  assert.equal(room?.status, 'WAITING');
  assert.equal(room?.hostPlayerId, room?.players[0]?.id);
  assert.deepEqual(room?.players.map(({ displayName, initialStack, currentStack }) => ({ displayName, initialStack, currentStack })), [
    { displayName: 'Ada', initialStack: 1500, currentStack: 1500 },
  ]);
});

test('POST /rooms rejects invalid creation input with a stable client error', { skip: !integrationEnabled }, async () => {
  for (const body of [
    {},
    { displayName: '   ', initialStack: 100 },
    { displayName: '😀'.repeat(25), initialStack: 100 },
    { displayName: 'Ada', initialStack: 1.5 },
    { displayName: 'Ada', initialStack: 0 },
    { displayName: 'Ada', initialStack: 1_000_001 },
  ]) {
    const response = await postRoom(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { code: 'INVALID_REQUEST' } });
  }

  const malformedResponse = await globalThis.fetch(`${baseUrl}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(malformedResponse.status, 400);
  assert.deepEqual(await malformedResponse.json(), { error: { code: 'INVALID_REQUEST' } });

  const oversizedResponse = await globalThis.fetch(`${baseUrl}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'A'.repeat(20_000), initialStack: 100 }),
  });
  assert.equal(oversizedResponse.status, 413);
  assert.deepEqual(await oversizedResponse.json(), { error: { code: 'INVALID_REQUEST' } });

  assert.equal(await prisma.room.count(), 0);
});

test('POST /rooms ignores attacker-controlled persistence fields', { skip: !integrationEnabled }, async () => {
  const response = await postRoom({
    displayName: 'Host',
    initialStack: 800,
    id: 'attacker-player-id',
    roomId: 'attacker-room-id',
    joinId: 'predictable',
    hostPlayerId: 'attacker-host-id',
    currentStack: 999_999,
    status: 'COMPLETED',
  });

  assert.equal(response.status, 201);
  const { roomId } = await response.json();
  assert.notEqual(roomId, 'predictable');

  const room = await repository.findRoomByJoinId(roomId);
  assert.equal(room?.status, 'WAITING');
  assert.notEqual(room?.id, 'attacker-room-id');
  assert.notEqual(room?.hostPlayerId, 'attacker-host-id');
  assert.deepEqual(room?.players.map(({ id, displayName, initialStack, currentStack }) => ({ id, displayName, initialStack, currentStack })), [
    { id: room?.hostPlayerId, displayName: 'Host', initialStack: 800, currentStack: 800 },
  ]);
});

test('POST /rooms rejects unapproved browser origins and supports approved preflight', { skip: !integrationEnabled }, async () => {
  const approvedOrigin = 'http://localhost:3000';
  const preflight = await globalThis.fetch(`${baseUrl}/rooms`, {
    method: 'OPTIONS',
    headers: {
      origin: approvedOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });

  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), approvedOrigin);
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST');

  const rejected = await globalThis.fetch(`${baseUrl}/rooms`, {
    method: 'POST',
    headers: { origin: 'https://unapproved.example', 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Host', initialStack: 800 }),
  });

  assert.equal(rejected.status, 403);
  assert.equal(await prisma.room.count(), 0);
});

test('POST /rooms hides actual PostgreSQL failures behind a generic server error', { skip: !integrationEnabled }, async () => {
  await prisma.$executeRawUnsafe('ALTER TABLE "Room" RENAME TO "Room_unavailable"');

  const response = await postRoom({ displayName: 'Host', initialStack: 800 });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: 'INTERNAL_ERROR' } });
});
