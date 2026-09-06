import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ServerGameLifecycle } from '../apps/server/src/game-lifecycle.ts';
import { startHand } from '../packages/poker-core/src/index.ts';
import { signPrivateHandSnapshot, hydrateSignedPrivateHandSnapshot } from '../apps/server/src/persistence/private-hand-snapshot.ts';
import { Buffer } from 'node:buffer';

const seats = [
  { seatNumber: 1, playerId: 'ada', playerName: 'עדה', stack: 100 },
  { seatNumber: 2, playerId: 'ben', playerName: 'בן', stack: 100 },
  { seatNumber: 3, playerId: 'cy', playerName: 'סי', stack: 100 },
];

test('server lifecycle starts only through the server CSPRNG boundary and exposes player-safe private views', () => {
  const game = new ServerGameLifecycle({ seats, dealerSeat: 1, smallBlind: 5, bigBlind: 10 });
  const view = game.start();

  assert.equal(view.street, 'preflop');
  assert.equal(view.playerId, 'ada');
  assert.equal(view.holeCards.length, 2);
  assert.equal(view.seats.length, 3);
  assert.equal(JSON.stringify(view).includes('holeCards'), true);
  assert.equal(JSON.stringify(view).match(/"holeCards"/g).length, 1);
  assert.throws(() => game.viewFor('outsider'), /not seated/i);
});

test('server lifecycle accepts only the active player action, advances the authoritative hand, and keeps opponent cards private', () => {
  const game = new ServerGameLifecycle({ seats, dealerSeat: 1, smallBlind: 5, bigBlind: 10 });
  game.start();
  const active = game.currentActorPlayerId();
  const inactive = seats.find((seat) => seat.playerId !== active).playerId;

  assert.throws(() => game.applyAction(inactive, { type: 'call' }), /active player/i);
  const before = game.viewFor(active);
  const after = game.applyAction(active, before.toCall === 0 ? { type: 'check' } : { type: 'call' });

  assert.notEqual(after.currentActorSeat, before.currentActorSeat);
  assert.equal(after.holeCards.length, 2);
  const opponentView = game.viewFor(inactive);
  assert.equal(JSON.stringify(opponentView).match(/"holeCards"/g).length, 1);
  assert.notDeepEqual(opponentView.holeCards, after.holeCards);
});

test('server lifecycle rejects malformed actions and cannot be started twice', () => {
  const game = new ServerGameLifecycle({ seats, dealerSeat: 1, smallBlind: 5, bigBlind: 10 });
  game.start();
  const active = game.currentActorPlayerId();

  assert.throws(() => game.applyAction(active, { type: 'raise', raiseTo: 1.5 }), /safe integer/i);
  assert.throws(() => game.applyAction(active, { type: 'cheat' }), /unsupported/i);
  assert.throws(() => game.start(), /already started/i);
});

test('a street-closing action advances before its view is returned through flop, turn, river, and showdown', () => {
  const game = new ServerGameLifecycle({ seats, dealerSeat: 1, smallBlind: 5, bigBlind: 10 });
  game.start();

  const act = () => {
    const playerId = game.currentActorPlayerId();
    const view = game.viewFor(playerId);
    return game.applyAction(playerId, view.toCall === 0 ? { type: 'check' } : { type: 'call' });
  };
  act();
  act();
  const flop = act();
  act();
  act();
  const turn = act();
  act();
  act();
  const river = act();
  act();
  act();
  const showdown = act();

  assert.equal(flop.street, 'flop');
  assert.equal(flop.communityCards.length, 3);
  assert.equal(turn.street, 'turn');
  assert.equal(river.street, 'river');
  assert.equal(showdown.street, 'showdown');
  assert.equal(showdown.communityCards.length, 5);
  assert.equal(showdown.toCall, 0);
});

test('server lifecycle snapshots constructor input before callers can mutate it', () => {
  const mutableInput = { seats: seats.map((seat) => ({ ...seat })), dealerSeat: 1, smallBlind: 5, bigBlind: 10 };
  const game = new ServerGameLifecycle(mutableInput);
  mutableInput.seats[0].playerId = 'attacker';
  mutableInput.seats[0].stack = 0;
  mutableInput.dealerSeat = 3;
  mutableInput.smallBlind = 99;
  mutableInput.bigBlind = 100;

  const view = game.start();
  assert.equal(view.playerId, 'ada');
  assert.equal(view.dealerSeat, 1);
  assert.equal(view.seats.find((seat) => seat.playerId === 'ada').stack, 100);
});

test('server lifecycle supports the nine persisted lobby seats without exposing another seat’s private cards', () => {
  const nineSeats = Array.from({ length: 9 }, (_, index) => ({
    seatNumber: index + 1,
    playerId: `player-${index + 1}`,
    playerName: `שחקן ${index + 1}`,
    stack: 100,
  }));
  const game = new ServerGameLifecycle({ seats: nineSeats, dealerSeat: 9, smallBlind: 5, bigBlind: 10 });
  const view = game.start();

  assert.equal(view.currentActorSeat, 3);
  assert.equal(view.seats.length, 9);
  assert.equal(JSON.stringify(view).match(/"holeCards"/g).length, 1);
  assert.equal(view.holeCards.length, 2);
});

test('a settled preflop all-in runs out server-private board cards to showdown before emitting a view', () => {
  const game = new ServerGameLifecycle({
    seats: seats.map((seat) => ({ ...seat, stack: 25 })),
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
  });
  game.start();
  game.applyAction(game.currentActorPlayerId(), { type: 'all-in' });
  game.applyAction(game.currentActorPlayerId(), { type: 'call' });
  const showdown = game.applyAction(game.currentActorPlayerId(), { type: 'call' });

  assert.equal(showdown.street, 'showdown');
  assert.equal(showdown.communityCards.length, 5);
  assert.equal(showdown.toCall, 0);
});

test('a verified recovered hand resumes without a fresh deal and cannot be started again', () => {
  const recoveredHand = startHand({
    seats: seats.map(({ seatNumber, playerId, stack }) => ({ seatNumber, playerId, stack })),
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: () => 0,
  });
  const key = Buffer.from('a server-only snapshot signing key with adequate length', 'utf8');
  const context = { roomId: 'room-id', sequence: 0, keyId: 'test-key' };
  const recovered = hydrateSignedPrivateHandSnapshot(
    signPrivateHandSnapshot(recoveredHand, context, key),
    context,
    new Map([[context.keyId, key]]),
  );
  const game = ServerGameLifecycle.fromVerifiedRecoveredHand({ seats, dealerSeat: 1, smallBlind: 5, bigBlind: 10 }, recovered);

  assert.equal(game.currentActorPlayerId(), 'ada');
  assert.throws(() => game.start(), /already started/i);
  const after = game.applyAction('ada', { type: 'call' });
  assert.equal(after.playerId, 'ada');
  assert.throws(() => game.applyAction('ada', { type: 'call' }), /active player/i);
});

test('lifecycle recovery rejects an unsigned hand even when its seats match', () => {
  const unsignedHand = startHand({
    seats: seats.map(({ seatNumber, playerId, stack }) => ({ seatNumber, playerId, stack })),
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: () => 0,
  });
  assert.throws(
    () => ServerGameLifecycle.fromVerifiedRecoveredHand({ seats, dealerSeat: 1, smallBlind: 5, bigBlind: 10 }, { hand: unsignedHand }),
    /verified/i,
  );
});
