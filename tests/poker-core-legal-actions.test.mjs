import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPreflopCheck, getPreflopLegalActions, startHand } from '../packages/poker-core/src/index.ts';

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
    canCall: true,
    canFold: true,
    callAmount: 10,
    canRaise: true,
    minRaiseTo: 20,
    maxRaiseTo: 100,
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
    canCall: false,
    canFold: true,
    callAmount: 0,
    canRaise: true,
    minRaiseTo: 20,
    maxRaiseTo: 100,
  });
});

test('preflop legal actions expose a call for the full amount owed when the actor can cover it', () => {
  const hand = startedThreePlayerHand();

  assert.deepEqual(getPreflopLegalActions(hand), {
    actorSeat: 1,
    toCall: 10,
    canCheck: false,
    canCall: true,
    canFold: true,
    callAmount: 10,
    canRaise: true,
    minRaiseTo: 20,
    maxRaiseTo: 100,
  });
});

test('preflop legal actions cap a legal call at the actor stack for a short all-in call', () => {
  const hand = startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 7 },
      { seatNumber: 2, playerId: 'ben', stack: 100 },
      { seatNumber: 3, playerId: 'cy', stack: 100 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  });

  assert.deepEqual(getPreflopLegalActions(hand), {
    actorSeat: 1,
    toCall: 10,
    canCheck: false,
    canCall: true,
    canFold: true,
    callAmount: 7,
    canRaise: false,
    minRaiseTo: null,
    maxRaiseTo: null,
  });
  assert.equal(hand.seats[0].stack, 7);
});

test('preflop legal actions always expose fold to the current actor, including when checking is free', () => {
  const hand = startedThreePlayerHand();
  hand.currentActorSeat = 3;

  const legalActions = getPreflopLegalActions(hand);

  assert.equal(legalActions.canFold, true);
  assert.equal(hand.seats[2].currentBet, 10);
});

test('preflop legal actions expose the first full raise range as total bet targets', () => {
  const hand = startedThreePlayerHand();

  const legalActions = getPreflopLegalActions(hand);

  assert.equal(legalActions.canRaise, true);
  assert.equal(legalActions.minRaiseTo, 20);
  assert.equal(legalActions.maxRaiseTo, 100);
  assert.equal(hand.seats[0].stack, 100);
  assert.equal(hand.seats[0].currentBet, 0);
});

test('preflop check is accepted only for the active actor with nothing to call', () => {
  const hand = startedThreePlayerHand();
  hand.currentActorSeat = 3;

  const checkedHand = applyPreflopCheck(hand, 3);

  assert.notEqual(checkedHand, hand);
  assert.equal(checkedHand.currentActorSeat, 1);
  assert.equal(checkedHand.currentBet, 10);
  assert.equal(checkedHand.pot, 15);
  assert.deepEqual(checkedHand.seats, hand.seats);
  assert.equal(hand.currentActorSeat, 3);
  assert.throws(() => applyPreflopCheck(hand, 1), /active actor/);
  hand.currentActorSeat = 1;
  assert.throws(() => applyPreflopCheck(hand, 1), /cannot check while chips are owed/);
});

test('preflop check rejects an active actor without chips', () => {
  const hand = startedThreePlayerHand();
  hand.currentActorSeat = 3;
  hand.seats[2].stack = 0;

  assert.throws(() => applyPreflopCheck(hand, 3), /eligible actor/);
  assert.equal(hand.currentActorSeat, 3);
  assert.equal(hand.seats[2].stack, 0);
});
