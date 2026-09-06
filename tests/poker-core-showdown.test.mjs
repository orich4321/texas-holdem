import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  advancePreflopToFlop,
  applyFlopAllIn,
  applyFlopCall,
  applyPreflopCall,
  applyPreflopCheck,
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
