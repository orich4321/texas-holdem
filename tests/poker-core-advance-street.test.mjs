import assert from 'node:assert/strict';
import { test } from 'node:test';

import { advancePreflopToFlop, applyPreflopCall, applyPreflopCheck, applyPreflopFold, applyPreflopRaise, getPreflopLegalActions, startHand } from '../packages/poker-core/src/index.ts';

const unshuffledRandomInt = (maxExclusive) => maxExclusive - 1;

function startedThreePlayerHand() {
  return startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 100 },
      { seatNumber: 2, playerId: 'ben', stack: 100 },
      { seatNumber: 3, playerId: 'cy', stack: 100 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  });
}

function startedHeadsUpHand() {
  return startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 100 },
      { seatNumber: 2, playerId: 'ben', stack: 100 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  });
}

function assertPrivateDeckIsNotSerialized(hand) {
  assert.equal(Object.getOwnPropertyDescriptor(hand, 'remainingDeck')?.enumerable, false);
  assert.equal(Object.getOwnPropertyDescriptor(hand, 'pendingActorSeats')?.enumerable, false);
  assert.equal(JSON.stringify(hand).includes('remainingDeck'), false);
  assert.equal(JSON.stringify(hand).includes('pendingActorSeats'), false);
}

test('a preflop cannot advance until the big blind has received its closing option', () => {
  const utgCalled = applyPreflopCall(startedThreePlayerHand(), 1);
  const smallBlindCalled = applyPreflopCall(utgCalled, 2);

  assert.equal(smallBlindCalled.currentActorSeat, 3);
  assert.throws(() => advancePreflopToFlop(smallBlindCalled), /acted|settled/i);

  const settledHand = applyPreflopCheck(smallBlindCalled, 3);
  const flopHand = advancePreflopToFlop(settledHand);

  assert.equal(flopHand.street, 'flop');
  assert.deepEqual(flopHand.communityCards, [
    { rank: '9', suit: 'clubs' },
    { rank: '10', suit: 'clubs' },
    { rank: 'J', suit: 'clubs' },
  ]);
  assert.equal(flopHand.currentActorSeat, 2);
  assert.equal(flopHand.currentBet, 0);
  assert.equal(flopHand.minimumRaiseIncrement, 10);
  assert.deepEqual(flopHand.seats.map(({ seatNumber, stack, currentBet }) => ({ seatNumber, stack, currentBet })), [
    { seatNumber: 1, stack: 90, currentBet: 0 },
    { seatNumber: 2, stack: 90, currentBet: 0 },
    { seatNumber: 3, stack: 90, currentBet: 0 },
  ]);
  assert.equal(flopHand.pot, 30);
  assert.equal(flopHand.remainingDeck.length, 42);
  assertPrivateDeckIsNotSerialized(flopHand);
});

test('a settled heads-up preflop advances after the big blind checks', () => {
  const dealerCalled = applyPreflopCall(startedHeadsUpHand(), 1);
  assert.throws(() => advancePreflopToFlop(dealerCalled), /acted|settled/i);

  const flopHand = advancePreflopToFlop(applyPreflopCheck(dealerCalled, 2));

  assert.equal(flopHand.street, 'flop');
  assert.equal(flopHand.remainingDeck.length, 44);
  assert.equal(new Set([
    ...flopHand.communityCards,
    ...flopHand.seats.flatMap((seat) => seat.holeCards),
    ...flopHand.remainingDeck,
  ].map(({ rank, suit }) => `${rank}-${suit}`)).size, 51);
});

test('a valid preflop fold does not prevent the flop transition or leak future cards', () => {
  const folded = applyPreflopFold(startedThreePlayerHand(), 1);
  const called = applyPreflopCall(folded, 2);
  const settled = applyPreflopCheck(called, 3);

  assertPrivateDeckIsNotSerialized(folded);
  const flopHand = advancePreflopToFlop(settled);

  assert.equal(flopHand.street, 'flop');
  assert.equal(flopHand.seats[0].isFolded, true);
  assertPrivateDeckIsNotSerialized(flopHand);
});

test('a completed preflop round rejects reused actions until the flop transition', () => {
  const settled = applyPreflopCheck(
    applyPreflopCall(
      applyPreflopCall(startedThreePlayerHand(), 1),
      2,
    ),
    3,
  );

  assert.deepEqual(settled.pendingActorSeats, []);
  assert.throws(() => getPreflopLegalActions(settled), /settled/i);
  assert.throws(() => applyPreflopCheck(settled, 1), /settled/i);
  assert.throws(() => applyPreflopRaise(settled, 1, 20), /settled/i);
});

test('the flop transition rejects a settled hand whose pot does not equal committed bets', () => {
  const settled = applyPreflopCheck(
    applyPreflopCall(
      applyPreflopCall(startedThreePlayerHand(), 1),
      2,
    ),
    3,
  );
  settled.pot += 1;

  assert.throws(() => advancePreflopToFlop(settled), /pot|committed/i);
});

test('private deck and pending-action state cannot be mutated to control a later deal', () => {
  const hand = startedThreePlayerHand();
  const originalFirstFutureCard = hand.remainingDeck[0];

  assert.throws(() => hand.remainingDeck.reverse(), /read only|frozen|extensible|delete/i);
  assert.throws(() => hand.pendingActorSeats.pop(), /read only|frozen|extensible|delete/i);
  assert.deepEqual(hand.remainingDeck[0], originalFirstFutureCard);
  assert.deepEqual(hand.pendingActorSeats, [1, 2, 3]);
});

test('a heads-up all-in preflop reaches the flop without inventing another betting actor', () => {
  const hand = startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 10 },
      { seatNumber: 2, playerId: 'ben', stack: 10 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  });

  const settled = applyPreflopCall(hand, 1);
  const flopHand = advancePreflopToFlop(settled);

  assert.deepEqual(settled.pendingActorSeats, []);
  assert.equal(flopHand.street, 'flop');
  assert.equal(flopHand.currentActorSeat, 1);
  assert.equal(flopHand.seats.every((seat) => seat.stack === 0), true);
  assert.deepEqual(flopHand.communityCards, [
    { rank: '7', suit: 'clubs' },
    { rank: '8', suit: 'clubs' },
    { rank: '9', suit: 'clubs' },
  ]);
});
