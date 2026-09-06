import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  advanceFlopToTurn,
  advancePreflopToFlop,
  advanceTurnToRiver,
  applyFlopCheck,
  applyPreflopCall,
  applyPreflopCheck,
  applyRiverAllIn,
  applyRiverCall,
  applyRiverCheck,
  applyRiverFold,
  applyRiverRaise,
  applyTurnCheck,
  getRiverLegalActions,
  startHand,
} from '../packages/poker-core/src/index.ts';

const unshuffledRandomInt = (maxExclusive) => maxExclusive - 1;

function settledRiverHand(stacks = [100, 100, 100]) {
  const preflop = startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: stacks[0] },
      { seatNumber: 2, playerId: 'ben', stack: stacks[1] },
      { seatNumber: 3, playerId: 'cy', stack: stacks[2] },
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
  return advanceTurnToRiver(applyTurnCheck(applyTurnCheck(applyTurnCheck(turn, 2), 3), 1));
}

test('river projects and applies a full raise followed by calls to settlement', () => {
  const river = settledRiverHand();
  assert.equal(river.street, 'river');
  assert.equal(getRiverLegalActions(river).canCheck, true);

  const opened = applyRiverRaise(river, 2, 20);
  const called = applyRiverCall(opened, 3);
  const settled = applyRiverCall(called, 1);

  assert.equal(settled.pot, 90);
  assert.deepEqual(settled.pendingActorSeats, []);
  assert.throws(() => getRiverLegalActions(settled), /settled/i);
});

test('river check/fold retains committed chips and short all-in retains the full-raise increment', () => {
  const river = settledRiverHand();
  const checked = applyRiverCheck(river, 2);
  const folded = applyRiverFold(checked, 3);
  const settled = applyRiverCheck(folded, 1);
  assert.equal(settled.seats.find((seat) => seat.seatNumber === 3).isFolded, true);
  assert.deepEqual(settled.pendingActorSeats, []);

  const shortRiver = settledRiverHand([100, 14, 100]);
  const shortAllIn = applyRiverAllIn(shortRiver, 2);
  assert.equal(shortAllIn.currentBet, 4);
  assert.equal(shortAllIn.minimumRaiseIncrement, 10);
  assert.deepEqual(shortAllIn.pendingActorSeats, [1, 3]);
});

test('river full all-in reopens action and river entrypoints reject another street', () => {
  const river = settledRiverHand();
  assert.throws(() => getRiverLegalActions({ ...river, street: 'turn' }), /safe flop betting state/i);

  const allIn = applyRiverAllIn(river, 2);
  assert.equal(allIn.currentBet, 90);
  assert.equal(allIn.minimumRaiseIncrement, 90);
  assert.equal(allIn.pot, 120);
  assert.equal(allIn.seats.find((seat) => seat.seatNumber === 2).stack, 0);
  assert.deepEqual(allIn.pendingActorSeats, [1, 3]);
});
