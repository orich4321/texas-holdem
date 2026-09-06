import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RoomRepository } from '../apps/server/src/persistence/room-repository.ts';

const room = { id: 'room-db-id', joinId: '0123456789abcdef', hostPlayerId: 'host-id', status: 'WAITING' };
const privateSnapshot = Object.freeze({
  version: 1,
  hand: Object.freeze({ deck: Object.freeze(['AS', 'KH']), holeCardsBySeat: Object.freeze({ 1: Object.freeze(['AS', 'KH']) }) }),
});

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
  const repository = new RoomRepository(db);

  const started = await repository.startGameAtomically({
    joinId: room.joinId,
    hostPlayerId: room.hostPlayerId,
    snapshot: privateSnapshot,
    event: { dealerSeat: 3, smallBlind: 5, bigBlind: 10 },
  });

  assert.deepEqual(started, { roomId: room.id, sequence: 0 });
  assert.deepEqual(db.calls.map(([name]) => name), ['room.updateMany', 'room.findUnique', 'gameEvent.create', 'gameSnapshot.create']);
  assert.deepEqual(db.calls[0][1], { where: { joinId: room.joinId, hostPlayerId: room.hostPlayerId, status: 'WAITING' }, data: { status: 'IN_PROGRESS' } });
  assert.deepEqual(db.calls[1][1], { where: { joinId: room.joinId }, select: { id: true } });
  assert.deepEqual(db.calls[2][1].data, { roomId: room.id, sequence: 0, type: 'GAME_STARTED', payload: { dealerSeat: 3, smallBlind: 5, bigBlind: 10 } });
  assert.equal(db.calls[3][1].data.state, privateSnapshot);
  assert.equal(JSON.stringify(db.calls[2][1]).includes('holeCardsBySeat'), false, 'events must never contain private cards/deck state');
});

test('game start rejects non-host or already-started rooms before writing an event or snapshot', async () => {
  const db = createDb({ updateCount: 0 });
  const repository = new RoomRepository(db);

  await assert.rejects(
    repository.startGameAtomically({ joinId: room.joinId, hostPlayerId: 'attacker', snapshot: privateSnapshot, event: { dealerSeat: 3, smallBlind: 5, bigBlind: 10 } }),
    /not startable/i,
  );
  assert.deepEqual(db.calls.map(([name]) => name), ['room.updateMany']);
});

test('game-start event whitelists public metadata and never persists attacker-supplied card or deck fields', async () => {
  const db = createDb();
  const repository = new RoomRepository(db);

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
  const repository = new RoomRepository(db);

  const recovered = await repository.findLatestGameSnapshotForPlayer(room.id, 'player-1');

  assert.deepEqual(recovered, { sequence: 8, state: privateSnapshot });
  assert.deepEqual(db.calls[0], ['gameSnapshot.findFirst', { where: { roomId: room.id, room: { players: { some: { id: 'player-1' } } } }, orderBy: { sequence: 'desc' }, select: { sequence: true, state: true } }]);
});
