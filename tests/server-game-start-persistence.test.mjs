import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { RoomRepository } from '../apps/server/src/persistence/room-repository.ts';
import { startHand } from '../packages/poker-core/src/index.ts';
import { signPrivateHandSnapshot } from '../apps/server/src/persistence/private-hand-snapshot.ts';

const room = { id: 'room-db-id', joinId: '0123456789abcdef', hostPlayerId: 'host-id', status: 'WAITING' };
const snapshotKey = Buffer.from('a server-only snapshot signing key with adequate length', 'utf8');
const snapshotKeyId = 'test-current';
const snapshotKeyring = new Map([[snapshotKeyId, snapshotKey]]);
const privateSnapshot = signPrivateHandSnapshot(startHand({
  seats: [{ seatNumber: 1, playerId: 'host-id', stack: 100 }, { seatNumber: 2, playerId: 'player-1', stack: 100 }],
  dealerSeat: 1,
  smallBlind: 5,
  bigBlind: 10,
  randomInt: () => 0,
}), { roomId: room.id, sequence: 0, keyId: snapshotKeyId }, snapshotKey);

function createDb({ updateCount = 1, createEvent = undefined, createSnapshot = undefined } = {}) {
  const calls = [];
  const gameSnapshot = {
    create: async (args) => { calls.push(['gameSnapshot.create', args]); return createSnapshot ?? { id: 'snapshot-1', sequence: 0, ...args.data }; },
    findFirst: async (args) => { calls.push(['gameSnapshot.findFirst', args]); return createSnapshot ?? { id: 'snapshot-1', roomId: room.id, sequence: 0, state: privateSnapshot }; },
  };
  const tx = {
    room: {
      updateMany: async (args) => { calls.push(['room.updateMany', args]); return { count: updateCount }; },
      findUnique: async (args) => { calls.push(['room.findUnique', args]); return room; },
    },
    gameEvent: { create: async (args) => { calls.push(['gameEvent.create', args]); return createEvent ?? { id: 'event-1', sequence: 0, ...args.data }; } },
    gameSnapshot,
  };
  return { calls, gameSnapshot, $transaction: async (fn) => fn(tx) };
}

test('game start atomically moves only the host waiting room in progress and persists a private snapshot plus public event', async () => {
  const db = createDb();
  const repository = new RoomRepository(db, undefined, undefined, undefined, snapshotKeyring);

  const started = await repository.startGameAtomically({
    joinId: room.joinId,
    hostPlayerId: room.hostPlayerId,
    snapshot: privateSnapshot,
    event: { dealerSeat: 3, smallBlind: 5, bigBlind: 10 },
  });

  assert.deepEqual(started, { roomId: room.id, sequence: 0 });
  assert.deepEqual(db.calls.map(([name]) => name), ['room.findUnique', 'room.updateMany', 'gameEvent.create', 'gameSnapshot.create']);
  assert.deepEqual(db.calls[0][1], { where: { joinId: room.joinId }, select: { id: true } });
  assert.deepEqual(db.calls[1][1], { where: { joinId: room.joinId, hostPlayerId: room.hostPlayerId, status: 'WAITING' }, data: { status: 'IN_PROGRESS' } });
  assert.deepEqual(db.calls[2][1].data, { roomId: room.id, sequence: 0, type: 'GAME_STARTED', payload: { dealerSeat: 3, smallBlind: 5, bigBlind: 10 } });
  assert.equal(db.calls[3][1].data.state, privateSnapshot);
  assert.equal(JSON.stringify(db.calls[2][1]).includes('holeCards'), false, 'events must never contain private cards/deck state');
});

test('game start rejects non-host or already-started rooms before writing an event or snapshot', async () => {
  const db = createDb({ updateCount: 0 });
  const repository = new RoomRepository(db, undefined, undefined, undefined, snapshotKeyring);

  await assert.rejects(
    repository.startGameAtomically({ joinId: room.joinId, hostPlayerId: 'attacker', snapshot: privateSnapshot, event: { dealerSeat: 3, smallBlind: 5, bigBlind: 10 } }),
    /not startable/i,
  );
  assert.deepEqual(db.calls.map(([name]) => name), ['room.findUnique', 'room.updateMany']);
});

test('game-start event whitelists public metadata and never persists attacker-supplied card or deck fields', async () => {
  const db = createDb();
  const repository = new RoomRepository(db, undefined, undefined, undefined, snapshotKeyring);

  await repository.startGameAtomically({
    joinId: room.joinId,
    hostPlayerId: room.hostPlayerId,
    snapshot: privateSnapshot,
    event: { dealerSeat: 3, smallBlind: 5, bigBlind: 10, deck: ['AS'], holeCards: { 1: ['AS', 'KH'] } },
  });

  assert.deepEqual(db.calls[2][1].data.payload, { dealerSeat: 3, smallBlind: 5, bigBlind: 10 });
});

test('restart recovery scopes the latest private snapshot to an authenticated room participant', async () => {
  const db = createDb({ createSnapshot: { id: 'snapshot-8', roomId: room.id, sequence: 8, state: privateSnapshot } });
  const repository = new RoomRepository(db, undefined, undefined, undefined, snapshotKeyring);

  const recovered = await repository.findLatestGameSnapshotForPlayer(room.id, 'player-1');

  assert.deepEqual(recovered, { sequence: 8, state: privateSnapshot });
  assert.deepEqual(db.calls[0], ['gameSnapshot.findFirst', { where: { roomId: room.id, room: { players: { some: { id: 'player-1' } } } }, orderBy: { sequence: 'desc' }, select: { sequence: true, state: true } }]);
});

test('game start rejects an envelope whose signed room or sequence does not match the atomic snapshot row', async () => {
  const db = createDb();
  const repository = new RoomRepository(db, undefined, undefined, undefined, snapshotKeyring);
  const wrongRoom = { ...privateSnapshot, roomId: 'other-room' };
  await assert.rejects(
    repository.startGameAtomically({ joinId: room.joinId, hostPlayerId: room.hostPlayerId, snapshot: wrongRoom, event: { dealerSeat: 1, smallBlind: 5, bigBlind: 10 } }),
    /snapshot/i,
  );
  assert.deepEqual(db.calls.map(([name]) => name), ['room.findUnique']);
});

test('game start verifies an initial private snapshot MAC before claiming or durably writing the room', async () => {
  const db = createDb();
  const repository = new RoomRepository(db, undefined, undefined, undefined, new Map([[snapshotKeyId, snapshotKey]]));
  const forged = { ...privateSnapshot, signature: '0'.repeat(64) };
  await assert.rejects(
    repository.startGameAtomically({ joinId: room.joinId, hostPlayerId: room.hostPlayerId, snapshot: forged, event: { dealerSeat: 1, smallBlind: 5, bigBlind: 10 } }),
    /invalid signed/i,
  );
  assert.deepEqual(db.calls.map(([name]) => name), ['room.findUnique'], 'invalid private state must not claim a room before verification');
});

test('restart recovery verifies the participant-scoped durable envelope and returns an authoritative hand only after MAC validation', async () => {
  const db = createDb({ createSnapshot: { id: 'snapshot-0', roomId: room.id, sequence: 0, state: privateSnapshot } });
  const repository = new RoomRepository(db, undefined, undefined, undefined, new Map([[snapshotKeyId, snapshotKey]]));
  const recovered = await repository.recoverLatestHandForPlayer(room.id, 'player-1');
  assert.equal(recovered?.sequence, 0);
  assert.equal(recovered?.recovery.hand.street, 'preflop');

  const badDb = createDb({ createSnapshot: { id: 'snapshot-bad', roomId: room.id, sequence: 0, state: { ...privateSnapshot, signature: 'f'.repeat(64) } } });
  const badRepository = new RoomRepository(badDb, undefined, undefined, undefined, new Map([[snapshotKeyId, snapshotKey]]));
  await assert.rejects(badRepository.recoverLatestHandForPlayer(room.id, 'player-1'), /invalid signed/i);
});
