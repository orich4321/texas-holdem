import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { RoomRepository } from '../apps/server/src/persistence/room-repository.ts';
import { advancePreflopToFlop, applyPreflopAllIn, applyPreflopCall, applyPreflopFold, applyPreflopRaise, finishUncontestedHand, runOutAllInToShowdown, startHand } from '../packages/poker-core/src/index.ts';
import { signPrivateHandSnapshot, hydrateSignedPrivateHandSnapshot } from '../apps/server/src/persistence/private-hand-snapshot.ts';

const key = Buffer.from('a server-only snapshot signing key with adequate length', 'utf8');
const keyId = 'test-current';
const keyring = new Map([[keyId, key]]);
const room = {
  id: 'room-db-id', joinId: '0123456789abcdef', hostPlayerId: 'host-id', status: 'IN_PROGRESS',
  finalSummaryVisible: true,
  players: [
    { id: 'host-id', displayName: 'אורי', avatarDataUrl: null, currentStack: 100, isSittingOut: false, createdAt: new Date('2026-01-01') },
    { id: 'player-1', displayName: 'נועה', avatarDataUrl: null, currentStack: 100, isSittingOut: false, createdAt: new Date('2026-01-02') },
    { id: 'parked-player', displayName: 'ממתין', avatarDataUrl: null, currentStack: 0, isSittingOut: true, createdAt: new Date('2026-01-03') },
  ],
};
const initial = signPrivateHandSnapshot(startHand({
  seats: room.players.slice(0, 2).map((player, index) => ({ seatNumber: index + 1, playerId: player.id, stack: player.currentStack })),
  dealerSeat: 1, smallBlind: 5, bigBlind: 10, randomInt: () => 0,
}), { roomId: room.id, sequence: 0, keyId }, key);
const raised = applyPreflopRaise(hydrateSignedPrivateHandSnapshot(initial, { roomId: room.id, sequence: 0 }, keyring).hand, 1, 20);
const raisedSnapshot = signPrivateHandSnapshot(raised, { roomId: room.id, sequence: 1, keyId }, key);

function createDb({ latest = { sequence: 0, state: initial }, currentHandStart = 'GAME_STARTED', duplicateAction = false, players = room.players } = {}) {
  const calls = [];
  let currentLatest = latest;
  const choices = new Map();
  const preAction = {
    findFirst: async () => [...choices.values()][0] ?? null,
    findUnique: async ({ where }) => choices.get(where.roomId_playerId.playerId) ?? null,
    upsert: async ({ where, create, update }) => {
      const playerId = where.roomId_playerId.playerId;
      const choice = { id: `choice-${playerId}`, ...(choices.has(playerId) ? update : create), roomId: room.id, playerId };
      choices.set(playerId, choice);
      return choice;
    },
    deleteMany: async ({ where }) => {
      let count = 0;
      for (const [playerId, choice] of choices) {
        if (where.id && where.id !== choice.id) continue;
        if (where.playerId && where.playerId !== playerId) continue;
        if (where.OR && !where.OR.some((condition) => condition.playerId === playerId
          || (condition.street?.not !== undefined && condition.street.not !== choice.street)
          || (condition.type === choice.type && condition.expectedCurrentBet?.not !== undefined && condition.expectedCurrentBet.not !== choice.expectedCurrentBet))) continue;
        choices.delete(playerId);
        count++;
      }
      return { count };
    },
  };
  const tx = {
    room: {
      findUnique: async (args) => { calls.push(['room.findUnique', args]); return { ...room, players }; },
      findFirst: async () => ({ ...room, players }),
      updateMany: async (args) => { calls.push(['room.updateMany', args]); return { count: 1 }; },
      update: async (args) => { calls.push(['room.update', args]); return args.data; },
    },
    gameSnapshot: {
      findFirst: async (args) => { calls.push(['gameSnapshot.findFirst', args]); return currentLatest; },
      create: async (args) => {
        calls.push(['gameSnapshot.create', args]);
        currentLatest = { sequence: args.data.sequence, state: args.data.state };
        return args.data;
      },
    },
    gameEvent: {
      create: async (args) => { calls.push(['gameEvent.create', args]); return args.data; },
      findFirst: async (args) => {
        calls.push(['gameEvent.findFirst', args]);
        if (args.where.clientActionId) return duplicateAction
          ? { sequence: latest.sequence, payload: { actorPlayerId: 'host-id', action: { type: 'call' }, amount: 5 } }
          : null;
        return { type: currentHandStart, sequence: 0, createdAt: new Date('2026-01-01T12:00:00Z') };
      },
    },
    player: { update: async (args) => { calls.push(['player.update', args]); return args.data; } },
    preAction,
    settlement: { create: async (args) => { calls.push(['settlement.create', args]); return args.data; } },
  };
  return {
    calls, choices, preAction, gameSnapshot: tx.gameSnapshot, gameEvent: tx.gameEvent,
    room: { findFirst: async () => ({ ...room, players: players.map((player) => ({ ...player, preAction: choices.get(player.id) ?? null })), events: [] }) },
    $transaction: async (callback) => callback(tx),
  };
}

function createThreeSeatDb() {
  const players = room.players.map((player) => player.id === 'parked-player'
    ? { ...player, currentStack: 100, isSittingOut: false }
    : player);
  const hand = startHand({
    seats: players.map((player, index) => ({ seatNumber: index + 1, playerId: player.id, stack: 100 })),
    dealerSeat: 1, smallBlind: 5, bigBlind: 10, randomInt: () => 0,
  });
  return createDb({ latest: { sequence: 0, state: signPrivateHandSnapshot(hand, { roomId: room.id, sequence: 0, keyId }, key) }, players });
}

test('a quoted call survives another player calling and executes exactly once when the turn arrives', async () => {
  const db = createThreeSeatDb();
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);
  assert.deepEqual(await repository.setPreActionForPlayer(room.id, 'player-1', 'call'), { type: 'call', quotedToCall: 5 });
  const guestView = await repository.recoverLatestPlayerViewForPlayer(room.id, 'player-1');
  const hostView = await repository.recoverLatestPlayerViewForPlayer(room.id, 'host-id');
  assert.equal(guestView?.preAction?.quotedToCall, 5);
  assert.equal(hostView?.preAction, undefined, 'another player must not see the private choice');

  await repository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'host-id', action: { type: 'call' } });
  await repository.drainPreActionsForRoom(room.id);
  assert.equal(db.choices.size, 0);
  assert.deepEqual(db.calls.filter(([name]) => name === 'gameEvent.create').map(([, args]) => args.data.payload.actorPlayerId), ['host-id', 'player-1']);
  await repository.drainPreActionsForRoom(room.id);
  assert.equal(db.calls.filter(([name]) => name === 'gameEvent.create').length, 2, 'the queued call is never repeated');
});

test('raising above an agreed call cancels it without taking the waiting player’s chips', async () => {
  const db = createThreeSeatDb();
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);
  await repository.setPreActionForPlayer(room.id, 'player-1', 'call');
  await repository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'host-id', action: { type: 'raise', raiseTo: 30 } });
  await repository.drainPreActionsForRoom(room.id);
  assert.equal(db.choices.size, 0);
  assert.equal(db.calls.filter(([name]) => name === 'gameEvent.create').length, 1);
  const next = await repository.recoverLatestPlayerViewForPlayer(room.id, 'player-1');
  assert.equal(next?.preAction, undefined);
  assert.equal(next?.currentActorSeat, 2);
  assert.equal(next?.waitingToCall, 25);
  await assert.rejects(repository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'player-1', action: { type: 'call' }, expectedSequence: 1, preActionId: 'choice-player-1' }), /Queued action is unavailable/);
});

test('check or fold is decided only from the legal price when the chosen player acts', async () => {
  const db = createThreeSeatDb();
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);
  await repository.setPreActionForPlayer(room.id, 'parked-player', 'check-fold');
  await repository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'host-id', action: { type: 'call' } });
  await repository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'player-1', action: { type: 'call' } });
  await repository.drainPreActionsForRoom(room.id);
  assert.equal(db.calls.filter(([name]) => name === 'gameEvent.create').at(-1)[1].data.payload.action.type, 'check');
  assert.equal(db.choices.size, 0);

  const raisedDb = createThreeSeatDb();
  const raisedRepository = new RoomRepository(raisedDb, undefined, undefined, undefined, keyring);
  await raisedRepository.setPreActionForPlayer(room.id, 'player-1', 'check-fold');
  await raisedRepository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'host-id', action: { type: 'raise', raiseTo: 30 } });
  await raisedRepository.drainPreActionsForRoom(room.id);
  assert.equal(raisedDb.calls.filter(([name]) => name === 'gameEvent.create').at(-1)[1].data.payload.action.type, 'fold');
});

test('a busted seat stays visually active while the host reviews the hand, then sits out after declining a rebuy', async () => {
  const allInHand = applyPreflopCall(
    applyPreflopAllIn(hydrateSignedPrivateHandSnapshot(initial, { roomId: room.id, sequence: 0 }, keyring).hand, 1),
    2,
  );
  const showdownHand = runOutAllInToShowdown(advancePreflopToFlop(allInHand));
  const snapshot = signPrivateHandSnapshot(showdownHand, { roomId: room.id, sequence: 4, keyId }, key);
  let decisionPending = true;
  const players = room.players.slice(0, 2).map((player) => ({
    ...player,
    currentStack: player.id === 'player-1' ? 0 : 200,
    isSittingOut: player.id === 'player-1',
    rebuyDecisionPending: player.id === 'player-1' && decisionPending,
  }));
  const repository = new RoomRepository({
    room: { findFirst: async () => ({ status: 'IN_PROGRESS', hostPlayerId: room.hostPlayerId, finalSummaryVisible: false, players: players.map((player) => ({ ...player, rebuyDecisionPending: player.id === 'player-1' && decisionPending })), events: [] }) },
    gameSnapshot: { findFirst: async () => ({ sequence: 4, state: snapshot }) },
    gameEvent: { findFirst: async () => ({ createdAt: new Date('2026-01-01T12:00:00.000Z') }) },
  }, undefined, undefined, undefined, keyring);

  const pendingView = await repository.recoverLatestPlayerViewForPlayer(room.id, 'host-id');
  assert.equal(pendingView?.seats.find((seat) => seat.playerId === 'player-1')?.isSittingOut, false);
  assert.equal(pendingView?.gameStartedAt, '2026-01-01T12:00:00.000Z');
  decisionPending = false;
  const declinedView = await repository.recoverLatestPlayerViewForPlayer(room.id, 'host-id');
  assert.equal(declinedView?.seats.find((seat) => seat.playerId === 'player-1')?.isSittingOut, true);
});

test('accepted authoritative action persists a minimal event and next signed snapshot atomically', async () => {
  const db = createDb();
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);

  const result = await repository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'host-id', action: { type: 'call' } });

  assert.equal(result.sequence, 1);
  assert.equal(result.view.playerId, 'host-id');
  assert.deepEqual(result.view.lastAction, {
    sequence: 1,
    actorPlayerId: 'host-id',
    actorPlayerName: 'אורי',
    action: { type: 'call' },
    amount: 5,
  });
  assert.deepEqual(result.view.seats.find((seat) => seat.playerId === 'parked-player'), {
    seatNumber: -3,
    playerId: 'parked-player',
    playerName: 'ממתין',
    stack: 0,
    currentBet: 0,
    isFolded: false,
    isSittingOut: true,
  });
  assert.deepEqual(db.calls.map(([name]) => name), ['room.findUnique', 'room.updateMany', 'gameSnapshot.findFirst', 'gameEvent.create', 'gameSnapshot.create', 'room.update']);
  assert.deepEqual(db.calls[3][1].data, { roomId: room.id, sequence: 1, type: 'PLAYER_ACTION', payload: { actorPlayerId: 'host-id', action: { type: 'call' }, amount: 5 } });
  const signed = db.calls[4][1].data.state;
  const recovered = hydrateSignedPrivateHandSnapshot(signed, { roomId: room.id, sequence: 1 }, keyring);
  assert.equal(recovered.hand.currentActorSeat, 2);
  assert.equal(JSON.stringify(db.calls[3][1].data).includes('holeCards'), false);
  assert.equal(JSON.stringify(db.calls[3][1].data).includes('deck'), false);
});

test('live game recovery and action responses never repeat player profile images', async () => {
  const avatarDataUrl = `data:image/png;base64,${'A'.repeat(32_000)}`;
  const players = room.players.map((player) => ({ ...player, avatarDataUrl }));
  const db = createDb({ players });
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);
  const recovered = await repository.recoverLatestPlayerViewForPlayer(room.id, 'host-id');
  const action = await repository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'host-id', action: { type: 'call' } });

  assert.doesNotMatch(JSON.stringify(recovered), /data:image\/png/);
  assert.doesNotMatch(JSON.stringify(action.view), /data:image\/png/);
  const actionRead = db.calls.find(([name]) => name === 'room.findUnique');
  assert.equal(actionRead[1].select.players.select.avatarDataUrl, undefined);
});

test('a preflop wager over the blinds is identified publicly as a raise', async () => {
  const db = createDb();
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);

  const result = await repository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'host-id', action: { type: 'raise', raiseTo: 20 } });

  assert.equal(result.view.lastAction?.raiseKind, 'raise');
  assert.equal(db.calls[3][1].data.payload.raiseKind, 'raise');
});

test('a raise to the complete stack is canonically persisted and announced as all-in', async () => {
  const db = createDb();
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);

  const result = await repository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'host-id', action: { type: 'raise', raiseTo: 100 } });

  assert.deepEqual(result.view.lastAction?.action, { type: 'all-in' });
  assert.equal(result.view.lastAction?.raiseKind, undefined);
  assert.deepEqual(db.calls[3][1].data.payload, { actorPlayerId: 'host-id', action: { type: 'all-in' }, amount: 100 });
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
  assert.deepEqual(result.view.lastAction, {
    sequence: 0, actorPlayerId: 'host-id', actorPlayerName: 'אורי', action: { type: 'call' }, amount: 5,
  });
  assert.equal(db.calls.filter(([name]) => name === 'gameEvent.create').length, 0);
  assert.equal(db.calls.filter(([name]) => name === 'gameSnapshot.create').length, 0);
});

test('the last fold atomically persists the uncontested winner and updated chip stacks', async () => {
  const db = createDb({ latest: { sequence: 1, state: raisedSnapshot } });
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);

  const result = await repository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'player-1', action: { type: 'fold' } });

  assert.equal(result.view.street, 'showdown');
  assert.deepEqual(result.view.showdown?.winners.map((winner) => winner.playerId), ['host-id']);
  assert.deepEqual(result.view.seats.map((seat) => [seat.playerId, seat.stack]), [['host-id', 110], ['player-1', 90], ['parked-player', 0]]);
  assert.deepEqual(db.calls.filter(([name]) => name === 'player.update').map(([, args]) => args.data.currentStack).sort((a, b) => a - b), [90, 110]);
  assert.equal(db.calls.filter(([name]) => name === 'settlement.create').length, 1);
  const persistedResult = db.calls.find(([name]) => name === 'settlement.create')[1].data.result;
  assert.equal(persistedResult.players.length, 2);
  assert.deepEqual(persistedResult.players.map((player) => [player.playerName, player.holeCards.length]), [['אורי', 2], ['נועה', 2]]);
  assert.deepEqual(persistedResult.board, []);
});

test('a fold against the last all-in player settles and persists the award', async () => {
  const players = room.players.map((player) => player.id === 'player-1' ? { ...player, currentStack: 10 } : player);
  const hand = startHand({
    seats: players.slice(0, 2).map((player, index) => ({ seatNumber: index + 1, playerId: player.id, stack: player.currentStack })),
    dealerSeat: 1, smallBlind: 5, bigBlind: 10, randomInt: () => 0,
  });
  const snapshot = signPrivateHandSnapshot(hand, { roomId: room.id, sequence: 0, keyId }, key);
  const db = createDb({ latest: { sequence: 0, state: snapshot }, players });
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);

  const result = await repository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'host-id', action: { type: 'fold' } });
  assert.equal(result.view.street, 'showdown');
  assert.deepEqual(result.view.showdown?.winners.map((winner) => winner.playerId), ['player-1']);
  assert.deepEqual(db.calls.filter(([name]) => name === 'player.update').map(([, args]) => args.data.currentStack).sort((a, b) => a - b), [15, 95]);
  assert.equal(db.calls.filter(([name]) => name === 'settlement.create').length, 1);
  assert.equal(db.calls.filter(([name]) => name === 'gameSnapshot.create').length, 1);
});

test('settling the signed final hand completes the room atomically', async () => {
  const db = createDb({ latest: { sequence: 1, state: raisedSnapshot }, currentHandStart: 'FINAL_HAND_STARTED' });
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);

  const result = await repository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'player-1', action: { type: 'fold' } });

  assert.equal(result.view.street, 'showdown');
  assert.equal(result.view.gameCompleted, true);
  assert.equal(result.view.finalSummaryVisible, false);
  assert.ok(db.calls.some(([name, args]) => name === 'room.updateMany' && args.data.status === 'COMPLETED' && args.data.finalSummaryVisible === false));
  assert.deepEqual(db.calls.find(([name]) => name === 'gameEvent.create')[1].data.type, 'PLAYER_ACTION');
});

test('a normal hand after a previous final hand does not complete the room again', async () => {
  const db = createDb({ latest: { sequence: 1, state: raisedSnapshot }, currentHandStart: 'HAND_STARTED' });
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);
  const result = await repository.persistPlayerActionAtomically({ roomId: room.id, playerId: 'player-1', action: { type: 'fold' } });
  assert.equal(result.view.gameCompleted, false);
  assert.equal(db.calls.some(([name, args]) => name === 'room.updateMany' && args.data.status === 'COMPLETED'), false);
  assert.deepEqual(db.calls.find(([name]) => name === 'gameEvent.findFirst')[1].where.type.in, ['GAME_STARTED', 'HAND_STARTED', 'FINAL_HAND_STARTED']);
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

test('the host persists the hypothetical flop, turn, and river after an uncontested hand without changing settlement', async () => {
  const recoveredRaise = hydrateSignedPrivateHandSnapshot(raisedSnapshot, { roomId: room.id, sequence: 1 }, keyring).hand;
  const foldedShowdown = finishUncontestedHand(applyPreflopFold(recoveredRaise, 2));
  const foldedSnapshot = signPrivateHandSnapshot(foldedShowdown, { roomId: room.id, sequence: 2, keyId }, key);
  const db = createDb({ latest: { sequence: 2, state: foldedSnapshot } });
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);

  const flop = await repository.advanceRabbitRunoutForHostAtomically({ joinId: room.joinId, hostPlayerId: 'host-id' });
  const turn = await repository.advanceRabbitRunoutForHostAtomically({ joinId: room.joinId, hostPlayerId: 'host-id' });
  const river = await repository.advanceRabbitRunoutForHostAtomically({ joinId: room.joinId, hostPlayerId: 'host-id' });

  assert.deepEqual([flop.sequence, turn.sequence, river.sequence], [3, 4, 5]);
  assert.deepEqual(db.calls.filter(([name]) => name === 'gameEvent.create').map(([, args]) => args.data), [{
    roomId: room.id, sequence: 3, type: 'UNCONTESTED_RUNOUT_ADVANCED', payload: { communityCardCount: 3 },
  }, {
    roomId: room.id, sequence: 4, type: 'UNCONTESTED_RUNOUT_ADVANCED', payload: { communityCardCount: 4 },
  }, {
    roomId: room.id, sequence: 5, type: 'UNCONTESTED_RUNOUT_ADVANCED', payload: { communityCardCount: 5 },
  }]);
  assert.equal(db.calls.filter(([name]) => name === 'settlement.create').length, 0);
  assert.equal(db.calls.filter(([name]) => name === 'player.update').length, 0);
  const snapshots = db.calls.filter(([name]) => name === 'gameSnapshot.create');
  const persisted = hydrateSignedPrivateHandSnapshot(snapshots.at(-1)[1].data.state, { roomId: room.id, sequence: 5 }, keyring);
  assert.equal(persisted.hand.street, 'showdown');
  assert.equal(persisted.hand.communityCards.length, 5);
});

test('a voluntary single-card showdown reveal is signed into the next snapshot without accepting client cards', async () => {
  const allInPreflop = applyPreflopCall(
    applyPreflopAllIn(hydrateSignedPrivateHandSnapshot(initial, { roomId: room.id, sequence: 0 }, keyring).hand, 1),
    2,
  );
  const showdown = runOutAllInToShowdown(advancePreflopToFlop(allInPreflop));
  const showdownSnapshot = signPrivateHandSnapshot(showdown, { roomId: room.id, sequence: 0, keyId }, key);
  const db = createDb({ latest: { sequence: 0, state: showdownSnapshot } });
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);

  const result = await repository.revealShowdownCardAtomically({ roomId: room.id, playerId: 'player-1', cardIndex: 0 });

  assert.equal(result.sequence, 1);
  assert.deepEqual(db.calls.find(([name]) => name === 'gameEvent.create')[1].data, {
    roomId: room.id, sequence: 1, type: 'SHOWDOWN_CARD_REVEALED', payload: { playerId: 'player-1', cardIndex: 0 },
  });
  assert.equal(JSON.stringify(db.calls.find(([name]) => name === 'gameEvent.create')[1].data).includes('holeCards'), false);
  const persisted = hydrateSignedPrivateHandSnapshot(db.calls.find(([name]) => name === 'gameSnapshot.create')[1].data.state, { roomId: room.id, sequence: 1 }, keyring);
  assert.deepEqual(persisted.hand.revealedHoleCards, [{ seatNumber: 2, cardIndexes: [0] }]);
});

test('a folded player can reveal their server-authoritative cards after an uncontested finish', async () => {
  const recoveredRaise = hydrateSignedPrivateHandSnapshot(raisedSnapshot, { roomId: room.id, sequence: 1 }, keyring).hand;
  const foldedShowdown = finishUncontestedHand(applyPreflopFold(recoveredRaise, 2));
  const foldedSnapshot = signPrivateHandSnapshot(foldedShowdown, { roomId: room.id, sequence: 2, keyId }, key);
  const db = createDb({ latest: { sequence: 2, state: foldedSnapshot } });
  const repository = new RoomRepository(db, undefined, undefined, undefined, keyring);

  const result = await repository.revealShowdownCardAtomically({ roomId: room.id, playerId: 'player-1', cardIndex: 1 });

  assert.equal(result.sequence, 3);
  assert.equal(result.view.exposedHands.find((hand) => hand.playerId === 'player-1')?.reason, 'voluntary');
  assert.deepEqual(result.views.find((view) => view.playerId === 'host-id')?.exposedHands.find((hand) => hand.playerId === 'player-1')?.cards, [{ cardIndex: 1, card: result.view.holeCards[1] }]);
  const persisted = hydrateSignedPrivateHandSnapshot(db.calls.find(([name]) => name === 'gameSnapshot.create')[1].data.state, { roomId: room.id, sequence: 3 }, keyring);
  assert.deepEqual(persisted.hand.revealedHoleCards, [{ seatNumber: 2, cardIndexes: [1] }]);
});
