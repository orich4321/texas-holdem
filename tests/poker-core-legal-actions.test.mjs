import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getPreflopLegalActions, startHand } from '../packages/poker-core/src/index.ts';

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

test('preflop legal actions calculate the actor toCall and withhold check while chips are owed', () => {
  const hand = startedThreePlayerHand();

  assert.deepEqual(getPreflopLegalActions(hand), {
    actorSeat: 1,
    toCall: 10,
    canCheck: false,
  });
  assert.equal(hand.seats[0].currentBet, 0);
});

test('preflop legal actions expose check exactly when the current actor has matched the current bet', () => {
  const hand = startedThreePlayerHand();
  hand.currentActorSeat = 3;

  assert.deepEqual(getPreflopLegalActions(hand), {
    actorSeat: 3,
    toCall: 0,
    canCheck: true,
  });
});
