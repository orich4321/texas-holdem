import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, before, after, beforeEach } from 'node:test';

const testDatabaseUrl = globalThis.process?.env.TEST_DATABASE_URL;
const integrationEnabled = testDatabaseUrl !== undefined;

const { prisma } = integrationEnabled
  ? await import('../apps/server/src/persistence/prisma.ts')
  : { prisma: undefined };
const { RoomRepository } = integrationEnabled
  ? await import('../apps/server/src/persistence/room-repository.ts')
  : { RoomRepository: undefined };

if (integrationEnabled) {
  before(() => {
    assert.match(testDatabaseUrl, /(?:_|-)test(?:\?|$|\/)/, 'TEST_DATABASE_URL must use a test database');
  });

  after(async () => {
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

test('room repository persists a room with two players and retrieves it by join ID', { skip: !integrationEnabled }, async () => {
  const repository = new RoomRepository(prisma);
  const created = await repository.createRoom({
    status: 'WAITING',
    host: { id: randomUUID(), displayName: 'Host', initialStack: 1_000 },
    players: [
      { id: randomUUID(), displayName: 'Guest', initialStack: 1_000 },
    ],
  });

  const found = await repository.findRoomByJoinId(created.joinId);

  assert.match(created.joinId, /^[a-f0-9]{16}$/);
  assert.equal(found?.id, created.id);
  assert.equal(found?.hostPlayerId, created.hostPlayerId);
  assert.deepEqual(
    found?.players.map(({ id, displayName, initialStack, currentStack }) => ({
      id,
      displayName,
      initialStack,
      currentStack,
    })),
    [
      { id: created.hostPlayerId, displayName: 'Host', initialStack: 1_000, currentStack: 1_000 },
      { id: created.players[1].id, displayName: 'Guest', initialStack: 1_000, currentStack: 1_000 },
    ],
  );
});

test('room repository rejects duplicate join IDs', { skip: !integrationEnabled }, async () => {
  const joinId = `room-${randomUUID()}`;
  const repository = new RoomRepository(prisma, () => joinId);

  await repository.createRoom({
    status: 'WAITING',
    host: { id: randomUUID(), displayName: 'Host', initialStack: 1_000 },
  });

  await assert.rejects(
    repository.createRoom({
      status: 'WAITING',
      host: { id: randomUUID(), displayName: 'Another Host', initialStack: 1_000 },
    }),
    { code: 'P2002' },
  );
});

test('database rejects assigning a room host from another room', { skip: !integrationEnabled }, async () => {
  const repository = new RoomRepository(prisma);
  const firstRoom = await repository.createRoom({
    status: 'WAITING',
    host: { id: randomUUID(), displayName: 'First host', initialStack: 1_000 },
  });
  const secondRoom = await repository.createRoom({
    status: 'WAITING',
    host: { id: randomUUID(), displayName: 'Second host', initialStack: 1_000 },
  });

  await assert.rejects(
    prisma.room.update({
      where: { id: firstRoom.id },
      data: { hostPlayerId: secondRoom.hostPlayerId },
    }),
  );
});
