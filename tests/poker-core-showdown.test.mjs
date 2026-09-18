import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  advanceFlopToTurn,
  advancePreflopToFlop,
  advanceRiverToShowdown,
  advanceTurnToRiver,
  applyFlopAllIn,
  applyFlopCall,
  applyFlopCheck,
  applyFlopFold,
  applyPreflopAllIn,
  applyPreflopCall,
  applyPreflopCheck,
  applyRiverCheck,
  applyTurnCheck,
  runOutAllInToShowdown,
  settleShowdown,
  startHand,
} from '../packages/poker-core/src/index.ts';

const unshuffledRandomInt = (maxExclusive) => maxExclusive - 1;

function unequalAllInShowdown() {
  const preflop = startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 100 },
      { seatNumber: 2, playerId: 'ben', stack: 35 },
      { seatNumber: 3, playerId: 'cy', stack: 100 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  });
  const flop = advancePreflopToFlop(
    applyPreflopCheck(applyPreflopCall(applyPreflopCall(preflop, 1), 2), 3),
  );
  return runOutAllInToShowdown(
    applyFlopCall(applyFlopAllIn(applyFlopAllIn(flop, 2), 3), 1),
  );
}

test('showdown constructs main and side pots and awards each only to its eligible winner', () => {
  const showdown = unequalAllInShowdown();
  const result = settleShowdown(showdown);

  assert.deepEqual(result.pots, [
    { amount: 105, eligibleSeatNumbers: [1, 2, 3], winnerSeatNumbers: [1] },
    { amount: 130, eligibleSeatNumbers: [1, 3], winnerSeatNumbers: [1] },
  ]);
  assert.deepEqual(result.seats.map((seat) => ({ seatNumber: seat.seatNumber, stack: seat.stack })), [
    { seatNumber: 1, stack: 235 },
    { seatNumber: 2, stack: 0 },
    { seatNumber: 3, stack: 0 },
  ]);
  assert.equal(result.pot, 0);
  assert.deepEqual(result.uncalledReturns, []);
  assert.equal(Object.isFrozen(result), true);
});

test('a short-stack heads-up winner cannot win the deep stack chips they did not match', () => {
  let state = 1;
  const deterministicRandomInt = (maxExclusive) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % maxExclusive;
  };
  const preflop = startHand({
    seats: [
      { seatNumber: 1, playerId: 'deep', stack: 1_500 },
      { seatNumber: 2, playerId: 'short', stack: 500 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: deterministicRandomInt,
  });
  const calledAllIn = applyPreflopCall(applyPreflopAllIn(preflop, 1), 2);
  const showdown = runOutAllInToShowdown(advancePreflopToFlop(calledAllIn));
  const result = settleShowdown(showdown);

  assert.deepEqual(result.pots, [{
    amount: 1_000,
    eligibleSeatNumbers: [1, 2],
    winnerSeatNumbers: [2],
  }]);
  assert.deepEqual(result.uncalledReturns, [{ seatNumber: 1, amount: 1_000 }]);
  assert.deepEqual(result.seats.map(({ seatNumber, stack }) => ({ seatNumber, stack })), [
    { seatNumber: 1, stack: 1_000 },
    { seatNumber: 2, stack: 1_000 },
  ]);
  assert.equal(result.seats.reduce((total, seat) => total + seat.stack, 0), 2_000);
});

test('a settled river advances to authoritative showdown before settlement without dealing more cards', () => {
  const preflop = startHand({
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
  const flop = advancePreflopToFlop(
    applyPreflopCheck(applyPreflopCall(applyPreflopCall(preflop, 1), 2), 3),
  );
  const turn = advanceFlopToTurn(applyFlopCheck(applyFlopCheck(applyFlopCheck(flop, 2), 3), 1));
  const river = advanceTurnToRiver(applyTurnCheck(applyTurnCheck(applyTurnCheck(turn, 2), 3), 1));
  const settledRiver = applyRiverCheck(applyRiverCheck(applyRiverCheck(river, 2), 3), 1);
  const beforeTransition = {
    communityCards: settledRiver.communityCards.map((card) => ({ ...card })),
    burnedCards: settledRiver.burnedCards.map((card) => ({ ...card })),
    remainingDeck: settledRiver.remainingDeck.map((card) => ({ ...card })),
    pot: settledRiver.pot,
  };

  const showdown = advanceRiverToShowdown(settledRiver);

  assert.equal(showdown.street, 'showdown');
  assert.deepEqual(showdown.communityCards, beforeTransition.communityCards);
  assert.deepEqual(showdown.burnedCards, beforeTransition.burnedCards);
  assert.deepEqual(showdown.remainingDeck, beforeTransition.remainingDeck);
  assert.equal(showdown.pot, beforeTransition.pot);
  assert.deepEqual(showdown.pendingActorSeats, []);
  assert.equal(settleShowdown(showdown).pot, 0);
});

test('river showdown rejects an all-in board that belongs to the automatic runout path', () => {
  const preflop = startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 25 },
      { seatNumber: 2, playerId: 'ben', stack: 25 },
      { seatNumber: 3, playerId: 'cy', stack: 25 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  });
  const flop = advancePreflopToFlop(
    applyPreflopCall(applyPreflopCall(applyPreflopAllIn(preflop, 1), 2), 3),
  );
  const turn = advanceFlopToTurn(flop);
  const allInRiver = advanceTurnToRiver(turn);

  assert.throws(() => advanceRiverToShowdown(allInRiver), /non-all-in contestant/);
});

test('showdown splits an odd tied pot clockwise from the dealer', () => {
  let state = 11;
  const deterministicRandomInt = (maxExclusive) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % maxExclusive;
  };
  const preflop = startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 11 },
      { seatNumber: 2, playerId: 'ben', stack: 11 },
      { seatNumber: 3, playerId: 'cy', stack: 11 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: deterministicRandomInt,
  });
  const flop = advancePreflopToFlop(
    applyPreflopCall(applyPreflopCall(applyPreflopAllIn(preflop, 1), 2), 3),
  );

  const result = settleShowdown(runOutAllInToShowdown(flop));

  assert.deepEqual(result.pots, [{
    amount: 33,
    eligibleSeatNumbers: [1, 2, 3],
    winnerSeatNumbers: [2, 3],
  }]);
  assert.deepEqual(result.seats.map(({ seatNumber, stack }) => ({ seatNumber, stack })), [
    { seatNumber: 1, stack: 0 },
    { seatNumber: 2, stack: 17 },
    { seatNumber: 3, stack: 16 },
  ]);
  assert.deepEqual(result.uncalledReturns, []);
});

test('showdown retains folded contributions, excludes folded cards, and returns an uncalled tier', () => {
  const preflop = startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 100 },
      { seatNumber: 2, playerId: 'ben', stack: 35 },
      { seatNumber: 3, playerId: 'cy', stack: 100 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  });
  const flop = advancePreflopToFlop(
    applyPreflopCheck(applyPreflopCall(applyPreflopCall(preflop, 1), 2), 3),
  );
  const allIn = applyFlopAllIn(applyFlopAllIn(flop, 2), 3);

  const result = settleShowdown(runOutAllInToShowdown(applyFlopFold(allIn, 1)));

  assert.deepEqual(result.pots, [
    { amount: 30, eligibleSeatNumbers: [2, 3], winnerSeatNumbers: [3] },
    { amount: 50, eligibleSeatNumbers: [2, 3], winnerSeatNumbers: [3] },
  ]);
  assert.deepEqual(result.uncalledReturns, [{ seatNumber: 3, amount: 65 }]);
  assert.deepEqual(result.seats.map(({ seatNumber, stack }) => ({ seatNumber, stack })), [
    { seatNumber: 1, stack: 90 },
    { seatNumber: 2, stack: 0 },
    { seatNumber: 3, stack: 145 },
  ]);
  assert.equal(result.seats[0].holeCards, undefined);
  assert.equal(result.seats.reduce((total, seat) => total + seat.stack, 0), 235);
});

test('showdown leaves a zero-stack undealt seat inert', () => {
  let state = 11;
  const deterministicRandomInt = (maxExclusive) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % maxExclusive;
  };
  const preflop = startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 0 },
      { seatNumber: 2, playerId: 'ben', stack: 11 },
      { seatNumber: 3, playerId: 'cy', stack: 11 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: deterministicRandomInt,
  });
  const flop = advancePreflopToFlop(applyPreflopCall(applyPreflopAllIn(preflop, 2), 3));
  const showdown = runOutAllInToShowdown(flop);

  const result = settleShowdown(showdown);

  assert.equal(showdown.dealerSeat, 2);
  assert.deepEqual(result.pots, [{
    amount: 22,
    eligibleSeatNumbers: [2, 3],
    winnerSeatNumbers: [2, 3],
  }]);
  assert.deepEqual(result.seats.map(({ seatNumber, stack }) => ({ seatNumber, stack })), [
    { seatNumber: 1, stack: 0 },
    { seatNumber: 2, stack: 11 },
    { seatNumber: 3, stack: 11 },
  ]);
});
