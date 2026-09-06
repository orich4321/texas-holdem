import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  advanceFlopToTurn,
  advancePreflopToFlop,
  advanceTurnToRiver,
  applyFlopCheck,
  applyPreflopCall,
  applyPreflopCheck,
  applyTurnCall,
  applyTurnCheck,
  applyTurnRaise,
  getTurnLegalActions,
  startHand,
} from '../packages/poker-core/src/index.ts';

const unshuffledRandomInt = (maxExclusive) => maxExclusive - 1;

function settledTurnHand() {
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
  return advanceFlopToTurn(applyFlopCheck(applyFlopCheck(applyFlopCheck(flop, 2), 3), 1));
}

test('turn exposes checks, applies a full raise and calls it before the river transition', () => {
  const turn = settledTurnHand();
  assert.equal(turn.street, 'turn');
  assert.equal(getTurnLegalActions(turn).canCheck, true);

  const opened = applyTurnRaise(turn, 2, 20);
  const called = applyTurnCall(opened, 3);
  const settled = applyTurnCall(called, 1);

  assert.equal(settled.pot, 90);
  assert.deepEqual(settled.pendingActorSeats, []);
  const river = advanceTurnToRiver(settled);
  assert.equal(river.street, 'river');
  assert.equal(river.pot, 90);
  assert.equal(river.currentActorSeat, 2);
  assert.equal(river.communityCards.length, 5);
  assert.equal(river.remainingDeck.length, 38);
});

test('turn check advances only the pending actor and cannot be used out of turn', () => {
  const turn = settledTurnHand();
  assert.throws(() => applyTurnCheck(turn, 3), /active actor/i);
  const checked = applyTurnCheck(turn, 2);
  assert.equal(checked.currentActorSeat, 3);
  assert.deepEqual(checked.pendingActorSeats, [1, 3]);
});
