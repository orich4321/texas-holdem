import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
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

const snapshotKeyring = new Map([['integration-current', Buffer.from('integration snapshot signing key that is safely over 32 bytes', 'utf8')]]);

if (integrationEnabled) {
  before(() => {
    assert.match(testDatabaseUrl, /(?:_|-)test(?:\?|$|\/)/, 'TEST_DATABASE_URL must use a test database');
  });

  after(async () => {
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

test('room repository stores only hashed access tokens and resolves them only in their room', { skip: !integrationEnabled }, async () => {
  const repository = new RoomRepository(prisma);
  const firstRoom = await repository.createRoom({
    status: 'WAITING',
    host: { id: randomUUID(), displayName: 'First host', initialStack: 1_000 },
  });
  const secondRoom = await repository.createRoom({
    status: 'WAITING',
    host: { id: randomUUID(), displayName: 'Second host', initialStack: 1_000 },
  });

  assert.equal(typeof firstRoom.hostAccessToken, 'string');
  assert.match(firstRoom.hostAccessToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(firstRoom.hostAccessToken, secondRoom.hostAccessToken);

  const persistedHost = await prisma.$queryRaw`
    SELECT "accessTokenHash" FROM "Player" WHERE "id" = ${firstRoom.hostPlayerId}::uuid
  `;
  assert.equal(persistedHost.length, 1);
  assert.notEqual(persistedHost[0].accessTokenHash, firstRoom.hostAccessToken);
  assert.match(persistedHost[0].accessTokenHash, /^[a-f0-9]{64}$/);

  const resolved = await repository.findPlayerByRoomJoinIdAndAccessToken(firstRoom.joinId, firstRoom.hostAccessToken);
  assert.equal(resolved?.id, firstRoom.hostPlayerId);
  assert.equal(await repository.findPlayerByRoomJoinIdAndAccessToken(firstRoom.joinId, 'not-a-valid-token'), null);
  assert.equal(await repository.findPlayerByRoomJoinIdAndAccessToken(firstRoom.joinId, secondRoom.hostAccessToken), null);
  assert.equal(await repository.findPlayerByRoomJoinIdAndAccessToken(secondRoom.joinId, firstRoom.hostAccessToken), null);

  const publicRoom = await repository.findRoomByJoinId(firstRoom.joinId);
  assert.equal('hostAccessToken' in publicRoom, false);
  assert.equal('accessTokenHash' in publicRoom.players[0], false);
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

test('host management settings, queued rebuys, removals, and ownership transfer persist atomically', { skip: !integrationEnabled }, async () => {
  const repository = new RoomRepository(prisma);
  const firstGuestId = randomUUID();
  const secondGuestId = randomUUID();
  const created = await repository.createRoom({
    status: 'IN_PROGRESS',
    host: { id: randomUUID(), displayName: 'Host', initialStack: 1_000 },
    players: [
      { id: firstGuestId, displayName: 'First guest', initialStack: 1_000 },
      { id: secondGuestId, displayName: 'Second guest', initialStack: 1_000 },
    ],
  });

  await repository.updateBlindsForHost(created.joinId, created.hostPlayerId, 25, 50);
  await repository.scheduleFinalHandForHost(created.joinId, created.hostPlayerId, true);
  await repository.addChipsForHost(created.joinId, created.hostPlayerId, firstGuestId, 500);
  await repository.removePlayerBetweenHandsForHostAtomically({ joinId: created.joinId, hostPlayerId: created.hostPlayerId, targetPlayerId: firstGuestId });

  const management = await repository.getHostManagement(created.joinId, created.hostPlayerId);
  assert.equal(management.smallBlind, 25);
  assert.equal(management.bigBlind, 50);
  assert.equal(management.nextHandIsFinal, true);
  assert.equal(management.players.find((player) => player.id === firstGuestId).leaveAfterHand, true);
  assert.equal(management.players.find((player) => player.id === firstGuestId).pendingChips, 0, 'removal cancels an unapplied rebuy');

  await repository.transferHostForHost(created.joinId, created.hostPlayerId, secondGuestId, false);
  assert.equal(await repository.getHostManagement(created.joinId, created.hostPlayerId), null);
  assert.equal((await repository.getHostManagement(created.joinId, secondGuestId)).players.find((player) => player.id === secondGuestId).isHost, true);
});

test('a busted member sits out, keeps their session, and can return to the same seat identity several hands later', { skip: !integrationEnabled }, async () => {
  const repository = new RoomRepository(prisma, undefined, undefined, undefined, snapshotKeyring);
  const bustedId = randomUUID();
  const created = await repository.createRoom({
    status: 'WAITING',
    host: { id: randomUUID(), displayName: 'Host', initialStack: 1_000 },
    players: [
      { id: bustedId, displayName: 'Busted guest', initialStack: 1_000 },
      { id: randomUUID(), displayName: 'Other guest', initialStack: 1_000 },
    ],
  });
  await repository.startGameForHostAtomically({ joinId: created.joinId, hostPlayerId: created.hostPlayerId });
  async function finishHand() {
    for (let attempts = 0; attempts < 3; attempts += 1) {
      const current = await repository.recoverLatestHandForPlayer(created.id, created.hostPlayerId);
      if (current.recovery.hand.street === 'showdown') return;
      const actor = current.recovery.hand.seats.find((seat) => seat.seatNumber === current.recovery.hand.currentActorSeat);
      await repository.persistPlayerActionAtomically({ roomId: created.id, playerId: actor.playerId, action: { type: 'fold' } });
    }
    assert.fail('hand did not settle');
  }
  await finishHand();
  await prisma.player.update({ where: { id: bustedId }, data: { currentStack: 0, isSittingOut: true, rebuyDecisionPending: true } });
  assert.equal((await repository.getHostManagement(created.joinId, created.hostPlayerId)).players.find((player) => player.id === bustedId).rebuyDecisionPending, true);
  await assert.rejects(repository.startNextHandForHostAtomically({ joinId: created.joinId, hostPlayerId: created.hostPlayerId }));
  await assert.rejects(repository.declineRebuyForHost(created.joinId, created.players[2].id, bustedId));
  await repository.declineRebuyForHost(created.joinId, created.hostPlayerId, bustedId);
  assert.equal((await repository.getHostManagement(created.joinId, created.hostPlayerId)).players.find((player) => player.id === bustedId).isSittingOut, true);
  await repository.startNextHandForHostAtomically({ joinId: created.joinId, hostPlayerId: created.hostPlayerId });
  const spectator = await repository.recoverLatestPlayerViewForPlayer(created.id, bustedId);
  assert.equal(spectator.isSittingOut, true);
  assert.deepEqual(spectator.holeCards, [], 'spectators must not receive another player’s private cards');
  assert.equal(spectator.seats.some((seat) => seat.playerId === bustedId), false);
  assert.equal((await repository.findPlayerByRoomJoinIdAndAccessToken(created.joinId, created.hostAccessToken)).id, created.hostPlayerId);
  await finishHand();
  await repository.startNextHandForHostAtomically({ joinId: created.joinId, hostPlayerId: created.hostPlayerId });
  await finishHand();
  await repository.addChipsForHost(created.joinId, created.hostPlayerId, bustedId, 500);
  assert.equal((await repository.getHostManagement(created.joinId, created.hostPlayerId)).players.find((player) => player.id === bustedId).pendingChips, 500);
  await repository.startNextHandForHostAtomically({ joinId: created.joinId, hostPlayerId: created.hostPlayerId });
  const returned = await repository.recoverLatestPlayerViewForPlayer(created.id, bustedId);
  assert.equal(returned.holeCards.length, 2);
  assert.ok(returned.seats.find((seat) => seat.playerId === bustedId).stack <= 500, 'the next hand may have posted a blind');
  assert.equal((await prisma.player.findUnique({ where: { id: bustedId } })).currentStack, 500);
  assert.equal((await repository.getHostManagement(created.joinId, created.hostPlayerId)).players.find((player) => player.id === bustedId).isSittingOut, false);
  assert.equal((await prisma.chipAdjustment.findFirst({ where: { playerId: bustedId, status: 'APPLIED' } })).stackAfter, 500);
});

test('database transaction serializes an authenticated action into one private successor snapshot', { skip: !integrationEnabled }, async () => {
  const repository = new RoomRepository(prisma, undefined, undefined, undefined, snapshotKeyring);
  const created = await repository.createRoom({
    status: 'WAITING',
    host: { id: randomUUID(), displayName: 'Host', initialStack: 1_000 },
    players: [{ id: randomUUID(), displayName: 'Guest', initialStack: 1_000 }],
  });
  await repository.startGameForHostAtomically({ joinId: created.joinId, hostPlayerId: created.hostPlayerId });

  const latePlayerId = randomUUID();
  const lateJoin = await repository.joinWaitingRoom(created.joinId, { id: latePlayerId, displayName: 'Late guest' });
  assert.equal(lateJoin.kind, 'joined');
  assert.equal(await repository.recoverLatestPlayerViewForPlayer(created.id, latePlayerId), null, 'late join waits without entering the signed hand');

  const initial = await repository.recoverLatestHandForPlayer(created.id, created.hostPlayerId);
  const activePlayerId = initial.recovery.hand.seats.find((seat) => seat.seatNumber === initial.recovery.hand.currentActorSeat)?.playerId;
  assert.equal(typeof activePlayerId, 'string');
  const activeView = await repository.recoverLatestPlayerViewForPlayer(created.id, activePlayerId);
  const action = activeView.toCall === 0 ? { type: 'check' } : { type: 'call' };

  const attempts = await Promise.allSettled([
    repository.persistPlayerActionAtomically({ roomId: created.id, playerId: activePlayerId, action }),
    repository.persistPlayerActionAtomically({ roomId: created.id, playerId: activePlayerId, action }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);

  const events = await prisma.gameEvent.findMany({ where: { roomId: created.id }, orderBy: { sequence: 'asc' } });
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].payload, { actorPlayerId: activePlayerId, action });
  assert.equal(JSON.stringify(events[1].payload).includes('holeCards'), false);
  assert.equal(JSON.stringify(events[1].payload).includes('deck'), false);
  const recovered = await repository.recoverLatestHandForPlayer(created.id, created.hostPlayerId);
  assert.equal(recovered.sequence, 1);
  assert.equal(recovered.recovery.hand.currentActorSeat !== initial.recovery.hand.currentActorSeat, true);
  const guestView = await repository.recoverLatestPlayerViewForPlayer(created.id, created.players[1].id);
  assert.equal(JSON.stringify(guestView).match(/"holeCards"/g).length, 1);
});

test('a host can add another hand after a final hand and decide afresh whether it is final', { skip: !integrationEnabled }, async () => {
  const repository = new RoomRepository(prisma, undefined, undefined, undefined, snapshotKeyring);
  const created = await repository.createRoom({
    status: 'WAITING',
    host: { id: randomUUID(), displayName: 'Host', initialStack: 1_000 },
    players: [{ id: randomUUID(), displayName: 'Guest', initialStack: 1_000 }],
  });
  await repository.startGameForHostAtomically({ joinId: created.joinId, hostPlayerId: created.hostPlayerId });

  async function finishCurrentHand() {
    const current = await repository.recoverLatestHandForPlayer(created.id, created.hostPlayerId);
    const actorId = current.recovery.hand.seats.find((seat) => seat.seatNumber === current.recovery.hand.currentActorSeat).playerId;
    return repository.persistPlayerActionAtomically({ roomId: created.id, playerId: actorId, action: { type: 'fold' } });
  }

  await finishCurrentHand();
  await repository.scheduleFinalHandForHost(created.joinId, created.hostPlayerId, true);
  assert.equal((await repository.startNextHandForHostAtomically({ joinId: created.joinId, hostPlayerId: created.hostPlayerId })).finalHand, true);
  assert.equal((await finishCurrentHand()).view.gameCompleted, true);
  assert.equal((await prisma.room.findUnique({ where: { id: created.id } })).finalSummaryVisible, false);

  await assert.rejects(repository.startNextHandForHostAtomically({ joinId: created.joinId, hostPlayerId: created.players[1].id, finalHand: false }));
  await assert.rejects(repository.startNextHandForHostAtomically({ joinId: created.joinId, hostPlayerId: created.hostPlayerId }));
  assert.equal((await repository.startNextHandForHostAtomically({ joinId: created.joinId, hostPlayerId: created.hostPlayerId, finalHand: false })).finalHand, false);
  assert.equal((await finishCurrentHand()).view.gameCompleted, false, 'an earlier final marker must not end this ordinary hand');
  assert.equal((await prisma.room.findUnique({ where: { id: created.id } })).status, 'IN_PROGRESS');

  await repository.scheduleFinalHandForHost(created.joinId, created.hostPlayerId, true);
  await repository.startNextHandForHostAtomically({ joinId: created.joinId, hostPlayerId: created.hostPlayerId });
  assert.equal((await finishCurrentHand()).view.gameCompleted, true);
  assert.equal((await repository.startNextHandForHostAtomically({ joinId: created.joinId, hostPlayerId: created.hostPlayerId, finalHand: true })).finalHand, true);
  assert.equal((await finishCurrentHand()).view.gameCompleted, true, 'the same choice returns after every final hand');
});
