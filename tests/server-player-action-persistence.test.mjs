import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { RoomRepository } from '../apps/server/src/persistence/room-repository.ts';
import { advancePreflopToFlop, applyPreflopAllIn, applyPreflopCall, applyPreflopRaise, runOutAllInToShowdown, startHand } from '../packages/poker-core/src/index.ts';
import { signPrivateHandSnapshot, hydrateSignedPrivateHandSnapshot } from '../apps/server/src/persistence/private-hand-snapshot.ts';

const key = Buffer.from('a server-only snapshot signing key with adequate length', 'utf8');
const keyId = 'test-current';
const keyring = new Map([[keyId, key]]);
const room = {
  id: 'room-db-id', joinId: '0123456789abcdef', hostPlayerId: 'host-id', status: 'IN_PROGRESS',
  players: [
    { id: 'host-id', displayName: 'אורי', currentStack: 100, createdAt: new Date('2026-01-01') },
    { id: 'player-1', displayName: 'נועה', currentStack: 100, createdAt: new Date('2026-01-02') },
  ],
};
const initial = signPrivateHandSnapshot(startHand({
  seats: room.players.map((player, index) => ({ seatNumber: index + 1, playerId: player.id, stack: player.currentStack })),
  dealerSeat: 1, smallBlind: 5, bigBlind: 10, randomInt: () => 0,
}), { roomId: room.id, sequence: 0, keyId }, key);
const raised = applyPreflopRaise(hydrateSignedPrivateHandSnapshot(initial, { roomId: room.id, sequence: 0 }, keyring).hand, 1, 20);
const raisedSnapshot = signPrivateHandSnapshot(raised, { roomId: room.id, sequence: 1, keyId }, key);

function createDb({ latest = { sequence: 0, state: initial }, finalHandSequence = null, duplicateAction = false } = {}) {
  const calls = [];
  const tx = {
    room: {
      findUnique: async (args) => { calls.push(['room.findUnique', args]); return room; },
      updateMany: async (args) => { calls.push(['room.updateMany', args]); return { count: 1 }; },
    },
    gameSnapshot: {
      findFirst: async (args) => { calls.push(['gameSnapshot.findFirst', args]); return latest; },
      create: async (args) => { calls.push(['gameSnapshot.create', args]); return args.data; },
    },
    gameEvent: {
      create: async (args) => { calls.push(['gameEvent.create', args]); return args.data; },
      findFirst: async (args) => { calls.push(['gameEvent.findFirst', args]); return finalHandSequence === null ? null : { sequence: finalHandSequence }; },
      findUnique: async (args) => { calls.push(['gameEvent.findUnique', args]); return duplicateAction ? { id: 'existing-event' } : null; },
    },
    player: { update: async (args) => { calls.push(['player.update', args]); return args.data; } },
    settlement: { create: async (args) => { calls.push(['settlement.create', args]); return args.data; } },
  };
  return { calls, $transaction: async (callback) => callback(tx) };
}

test('accepted authoritative action persists a minimal event and next signed snapshot atomically', async () => {
  const db = createDb();
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);

  const result = await repository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'host-id', action: { type: 'call' } });

  assert.equal(result.sequence, 1);
  assert.equal(result.view.playerId, 'host-id');
  assert.deepEqual(db.calls.map(([name]) => name), ['room.findUnique', 'room.updateMany', 'gameSnapshot.findFirst', 'gameEvent.create', 'gameSnapshot.create']);
  assert.deepEqual(db.calls[3][1].data, { roomId: room.id, sequence: 1, type: 'PLAYER_ACTION', payload: { actorPlayerId: 'host-id', action: { type: 'call' } } });
  const signed = db.calls[4][1].data.state;
  const recovered = hydrateSignedPrivateHandSnapshot(signed, { roomId: room.id, sequence: 1 }, keyring);
  assert.equal(recovered.hand.currentActorSeat, 2);
  assert.equal(JSON.stringify(db.calls[3][1].data).includes('holeCards'), false);
  assert.equal(JSON.stringify(db.calls[3][1].data).includes('deck'), false);
});

test('retrying a socket action through HTTP with the same client ID never applies it twice', async () => {
  const db = createDb({ duplicateAction: true });
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);
  const result = await repository.persistPlayerActionAtomically({
    roomId: room.id,
    playerId: 'host-id',
    clientActionId: '018f7b16-690c-4d1f-9d0b-a8c4a14ae999',
    action: { type: 'call' },
  });
  assert.equal(result.sequence, 0);
  assert.equal(db.calls.filter(([name]) => name === 'gameEvent.create').length, 0);
  assert.equal(db.calls.filter(([name]) => name === 'gameSnapshot.create').length, 0);
});

test('the last fold atomically persists the uncontested winner and updated chip stacks', async () => {
  const db = createDb({ latest: { sequence: 1, state: raisedSnapshot } });
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);

  const result = await repository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'player-1', action: { type: 'fold' } });

  assert.equal(result.view.street, 'showdown');
  assert.deepEqual(result.view.showdown?.winners.map((winner) => winner.playerId), ['host-id']);
  assert.deepEqual(result.view.seats.map((seat) => [seat.playerId, seat.stack]), [['host-id', 110], ['player-1', 90]]);
  assert.deepEqual(db.calls.filter(([name]) => name === 'player.update').map(([, args]) => args.data.currentStack).sort((a, b) => a - b), [90, 110]);
  assert.equal(db.calls.filter(([name]) => name === 'settlement.create').length, 1);
  const persistedResult = db.calls.find(([name]) => name === 'settlement.create')[1].data.result;
  assert.equal(persistedResult.players.length, 2);
  assert.deepEqual(persistedResult.players.map((player) => [player.playerName, player.holeCards.length]), [['אורי', 2], ['נועה', 2]]);
  assert.deepEqual(persistedResult.board, []);
});

test('settling the signed final hand completes the room atomically', async () => {
  const db = createDb({ latest: { sequence: 1, state: raisedSnapshot }, finalHandSequence: 1 });
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);

  const result = await repository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'player-1', action: { type: 'fold' } });

  assert.equal(result.view.street, 'showdown');
  assert.equal(result.view.gameCompleted, true);
  assert.ok(db.calls.some(([name, args]) => name === 'room.updateMany' && args.data.status === 'COMPLETED'));
  assert.deepEqual(db.calls.find(([name]) => name === 'gameEvent.create')[1].data.type, 'PLAYER_ACTION');
});

test('invalid or out-of-turn action writes nothing', async () => {
  for (const [playerId, action] of [
    ['player-1', { type: 'call' }],
    ['host-id', { type: 'raise', raiseTo: 1.5 }],
    ['host-id', { type: 'call', playerId: 'player-1' }],
  ]) {
    const db = createDb();
    const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);
    await assert.rejects(repository.persistPlayerActionAtomically({ roomId: room.id, playerId, action }), /action|active|raise/i);
    assert.deepEqual(db.calls.map(([name]) => name), playerId === 'host-id' ? [] : ['room.findUnique', 'room.updateMany', 'gameSnapshot.findFirst']);
  }
});

test('the host persists one all-in board street without exposing cards in the event payload', async () => {
  const allInPreflop = applyPreflopCall(
    applyPreflopAllIn(hydrateSignedPrivateHandSnapshot(initial, { roomId: room.id, sequence: 0 }, keyring).hand, 1),
    2,
  );
  const allInSnapshot = signPrivateHandSnapshot(allInPreflop, { roomId: room.id, sequence: 0, keyId }, key);
  const db = createDb({ latest: { sequence: 0, state: allInSnapshot } });
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);

  const result = await repository.advanceAllInRunoutForHostAtomically({ joinId: room.joinId, hostPlayerId: 'host-id' });

  assert.equal(result.sequence, 1);
  assert.deepEqual(db.calls.find(([name]) => name === 'gameEvent.create')[1].data, {
    roomId: room.id, sequence: 1, type: 'ALL_IN_RUNOUT_ADVANCED', payload: { street: 'flop' },
  });
  assert.equal(JSON.stringify(db.calls.find(([name]) => name === 'gameEvent.create')[1].data).includes('holeCards'), false);
  const persisted = hydrateSignedPrivateHandSnapshot(db.calls.find(([name]) => name === 'gameSnapshot.create')[1].data.state, { roomId: room.id, sequence: 1 }, keyring);
  assert.equal(persisted.hand.street, 'flop');
  assert.equal(persisted.hand.communityCards.length, 3);
});

test('a voluntary showdown reveal is signed into the next snapshot without accepting client cards', async () => {
  const allInPreflop = applyPreflopCall(
    applyPreflopAllIn(hydrateSignedPrivateHandSnapshot(initial, { roomId: room.id, sequence: 0 }, keyring).hand, 1),
    2,
  );
  const showdown = runOutAllInToShowdown(advancePreflopToFlop(allInPreflop));
  const showdownSnapshot = signPrivateHandSnapshot(showdown, { roomId: room.id, sequence: 0, keyId }, key);
  const db = createDb({ latest: { sequence: 0, state: showdownSnapshot } });
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);

  const result = await repository.revealShowdownHandAtomically({ roomId: room.id, playerId: 'player-1' });

  assert.equal(result.sequence, 1);
  assert.deepEqual(db.calls.find(([name]) => name === 'gameEvent.create')[1].data, {
    roomId: room.id, sequence: 1, type: 'SHOWDOWN_HAND_REVEALED', payload: { playerId: 'player-1' },
  });
  assert.equal(JSON.stringify(db.calls.find(([name]) => name === 'gameEvent.create')[1].data).includes('holeCards'), false);
  const persisted = hydrateSignedPrivateHandSnapshot(db.calls.find(([name]) => name === 'gameSnapshot.create')[1].data.state, { roomId: room.id, sequence: 1 }, keyring);
  assert.deepEqual(persisted.hand.revealedSeatNumbers, [2]);
});
