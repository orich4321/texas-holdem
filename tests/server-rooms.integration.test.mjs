import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
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
  ? await import('../apps/server/src/http-app.ts')
  : { createApp: undefined };

let server;
let baseUrl;
let repository;

const snapshotKeyring = new Map([['integration-current', Buffer.from('integration snapshot signing key that is safely over 32 bytes', 'utf8')]]);

if (integrationEnabled) {
  before(async () => {
    assert.match(testDatabaseUrl, /(?:_|-)test(?:\?|$|\/)/, 'TEST_DATABASE_URL must use a test database');
    repository = new RoomRepository(prisma, undefined, undefined, undefined, snapshotKeyring);
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
    await prisma.chipAdjustment.deleteMany();
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

async function postJoin(joinId, body) {
  return globalThis.fetch(`${baseUrl}/rooms/${joinId}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postStart(joinId, cookie) {
  return globalThis.fetch(`${baseUrl}/rooms/${joinId}/start`, { method: 'POST', headers: { cookie } });
}

test('POST /rooms persists a waiting room and its host then returns an opaque invite', { skip: !integrationEnabled }, async () => {
  const response = await postRoom({ displayName: '  Ada  ', initialStack: 1500 });

  assert.equal(response.status, 201);
  const result = await response.json();
  assert.match(result.roomId, /^[a-f0-9]{16}$/);
  assert.deepEqual(result, { roomId: result.roomId, hostPath: `/r/${result.roomId}/host`, invitePath: `/r/${result.roomId}` });
  const sessionCookie = response.headers.get('set-cookie');
  assert.match(sessionCookie, /^poker_player_token=[A-Za-z0-9_-]{43}; Max-Age=2592000;/);
  assert.match(sessionCookie, /; Path=\/;/);
  assert.match(sessionCookie, /; HttpOnly; SameSite=Lax$/);
  assert.equal(sessionCookie.includes('Secure'), false);

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
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, POST');
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');

  const rejected = await globalThis.fetch(`${baseUrl}/rooms`, {
    method: 'POST',
    headers: { origin: 'https://unapproved.example', 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Host', initialStack: 800 }),
  });

  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('access-control-allow-credentials'), null);
  assert.equal(await prisma.room.count(), 0);
});

test('POST /rooms/:joinId/join creates a non-host player with a private session cookie', { skip: !integrationEnabled }, async () => {
  const created = await postRoom({ displayName: 'Host', initialStack: 800 });
  const { roomId } = await created.json();
  const joined = await postJoin(roomId, { displayName: '  Guest  ', initialStack: 400, id: 'attacker-player-id', currentStack: 999_999, role: 'HOST', token: 'attacker-token' });

  assert.equal(joined.status, 201);
  assert.deepEqual(await joined.json(), { roomId, invitePath: `/r/${roomId}` });
  const guestCookie = joined.headers.get('set-cookie');
  assert.match(guestCookie, /^poker_player_token=[A-Za-z0-9_-]{43}; Max-Age=2592000;/);
  assert.match(guestCookie, /; Path=\/;/);
  assert.match(guestCookie, /; HttpOnly; SameSite=Lax$/);

  const room = await repository.findRoomByJoinId(roomId);
  assert.equal(room?.hostPlayerId, room?.players[0]?.id);
  assert.deepEqual(room?.players.map(({ displayName, initialStack, currentStack }) => ({ displayName, initialStack, currentStack })), [
    { displayName: 'Host', initialStack: 800, currentStack: 800 },
    { displayName: 'Guest', initialStack: 800, currentStack: 800 },
  ]);
  assert.notEqual(room?.hostPlayerId, room?.players[1]?.id);
  const guestToken = guestCookie.match(/^poker_player_token=([^;]+)/)?.[1];
  const persistedGuest = await prisma.$queryRaw`SELECT "accessTokenHash" FROM "Player" WHERE "id" = ${room?.players[1]?.id}::uuid`;
  assert.equal(persistedGuest.length, 1);
  assert.match(persistedGuest[0].accessTokenHash, /^[a-f0-9]{64}$/);
  assert.notEqual(persistedGuest[0].accessTokenHash, guestToken);
  assert.equal((await repository.findPlayerByRoomJoinIdAndAccessToken(roomId, guestToken))?.id, room?.players[1]?.id);
});

test('POST /rooms/:joinId/join permits one seat per existing room session', { skip: !integrationEnabled }, async () => {
  const created = await postRoom({ displayName: 'Host', initialStack: 800 });
  const hostCookie = created.headers.get('set-cookie');
  const { roomId } = await created.json();
  const joined = await postJoin(roomId, { displayName: 'Guest', initialStack: 400 });
  const guestCookie = joined.headers.get('set-cookie');

  for (const cookie of [hostCookie, guestCookie]) {
    const repeated = await globalThis.fetch(`${baseUrl}/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Duplicate', initialStack: 400 }),
    });
    assert.equal(repeated.status, 409);
    assert.deepEqual(await repeated.json(), { error: { code: 'ALREADY_JOINED' } });
  }
  assert.equal(await prisma.player.count(), 2);
});

test('POST /rooms/:joinId/join caps a waiting room at nine players', { skip: !integrationEnabled }, async () => {
  const created = await postRoom({ displayName: 'Host', initialStack: 800 });
  const { roomId } = await created.json();

  for (let index = 1; index <= 8; index += 1) {
    const joined = await postJoin(roomId, { displayName: `Guest ${index}`, initialStack: 400 });
    assert.equal(joined.status, 201);
  }

  const full = await postJoin(roomId, { displayName: 'Overflow', initialStack: 400 });
  assert.equal(full.status, 409);
  assert.deepEqual(await full.json(), { error: { code: 'ROOM_FULL' } });
  assert.equal(await prisma.player.count(), 9);
});

test('POST /rooms/:joinId/join returns stable generic errors for invalid input, missing, and closed rooms', { skip: !integrationEnabled }, async () => {
  const missing = await postJoin('0123456789abcdef', { displayName: 'Guest', initialStack: 400 });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: { code: 'ROOM_NOT_FOUND' } });

  const created = await postRoom({ displayName: 'Host', initialStack: 800 });
  const { roomId } = await created.json();
  for (const invalidBody of [{}, { displayName: ' ', initialStack: 400 }, { displayName: 123 }]) {
    const invalid = await postJoin(roomId, invalidBody);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: { code: 'INVALID_REQUEST' } });
  }
  await prisma.room.update({ where: { joinId: roomId }, data: { status: 'IN_PROGRESS' } });
  const closed = await postJoin(roomId, { displayName: 'Guest', initialStack: 400 });
  assert.equal(closed.status, 409);
  assert.deepEqual(await closed.json(), { error: { code: 'ROOM_NOT_JOINABLE' } });
  assert.equal(await prisma.player.count(), 1);
});

test('POST /rooms/:joinId/start accepts only the authenticated host and never exposes a dealt hand', { skip: !integrationEnabled }, async () => {
  const created = await postRoom({ displayName: 'Host', initialStack: 800 });
  const hostCookie = created.headers.get('set-cookie');
  const { roomId } = await created.json();
  const joined = await postJoin(roomId, { displayName: 'Guest', initialStack: 800 });
  const guestCookie = joined.headers.get('set-cookie');

  const guestAttempt = await postStart(roomId, guestCookie);
  assert.equal(guestAttempt.status, 403);
  const started = await postStart(roomId, hostCookie);
  assert.equal(started.status, 201);
  assert.deepEqual(await started.json(), { roomId, status: 'IN_PROGRESS' });
  assert.equal(await prisma.gameEvent.count({ where: { room: { joinId: roomId } } }), 1);
  assert.equal(await prisma.gameSnapshot.count({ where: { room: { joinId: roomId } } }), 1);

  const publicRoom = await globalThis.fetch(`${baseUrl}/rooms/${roomId}`);
  assert.equal(publicRoom.status, 200);
  const projection = await publicRoom.json();
  assert.equal(projection.status, 'IN_PROGRESS');
  assert.equal(projection.canStart, false);
  assert.equal(JSON.stringify(projection).includes('holeCards'), false);
  assert.equal(JSON.stringify(projection).includes('deck'), false);
});

test('GET /rooms/:joinId exposes a player-safe waiting-room lobby projection', { skip: !integrationEnabled }, async () => {
  const created = await postRoom({ displayName: 'Host', initialStack: 800 });
  const { roomId } = await created.json();
  await postJoin(roomId, { displayName: 'Guest', initialStack: 400 });

  const lobby = await globalThis.fetch(`${baseUrl}/rooms/${roomId}`);
  assert.equal(lobby.status, 200);
  const result = await lobby.json();
  assert.deepEqual(result, { joinId: roomId, status: 'WAITING', isHost: false, isParticipant: false, canStart: false, settings: { initialStack: 800, smallBlind: 5, bigBlind: 10, maxPlayers: 9 }, host: { displayName: 'Host' }, players: [
    { displayName: 'Host', initialStack: 800, currentStack: 800 },
    { displayName: 'Guest', initialStack: 800, currentStack: 800 },
  ] });
  assert.equal(JSON.stringify(result).includes('accessToken'), false);

  await prisma.room.update({ where: { joinId: roomId }, data: { status: 'CANCELLED' } });
  const unavailable = await globalThis.fetch(`${baseUrl}/rooms/${roomId}`);
  assert.equal(unavailable.status, 404);
  assert.deepEqual(await unavailable.json(), { error: { code: 'ROOM_NOT_FOUND' } });
});

test('POST /rooms hides actual PostgreSQL failures behind a generic server error', { skip: !integrationEnabled }, async () => {
  await prisma.$executeRawUnsafe('ALTER TABLE "Room" RENAME TO "Room_unavailable"');

  const response = await postRoom({ displayName: 'Host', initialStack: 800 });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: 'INTERNAL_ERROR' } });
});
