import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyPreflopAllIn, applyPreflopCall, applyPreflopCheck, applyPreflopFold, applyPreflopRaise, getPreflopLegalActions, startHand } from '../packages/poker-core/src/index.ts';

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

test('preflop call commits the full amount owed and advances to the next eligible actor', () => {
  const hand = startedThreePlayerHand();

  const calledHand = applyPreflopCall(hand, 1);

  assert.notEqual(calledHand, hand);
  assert.equal(calledHand.currentActorSeat, 2);
  assert.equal(calledHand.currentBet, 10);
  assert.equal(calledHand.pot, 25);
  assert.deepEqual(calledHand.seats.map((seat) => ({ seatNumber: seat.seatNumber, stack: seat.stack, currentBet: seat.currentBet })), [
    { seatNumber: 1, stack: 90, currentBet: 10 },
    { seatNumber: 2, stack: 95, currentBet: 5 },
    { seatNumber: 3, stack: 90, currentBet: 10 },
  ]);
  assert.equal(hand.seats[0].stack, 100);
  assert.equal(hand.pot, 15);
});

test('preflop call permits a short all-in call and skips the all-in actor afterward', () => {
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

  const calledHand = applyPreflopCall(hand, 1);

  assert.equal(calledHand.currentActorSeat, 2);
  assert.equal(calledHand.currentBet, 10);
  assert.equal(calledHand.pot, 22);
  assert.deepEqual(calledHand.seats.map((seat) => ({ seatNumber: seat.seatNumber, stack: seat.stack, currentBet: seat.currentBet })), [
    { seatNumber: 1, stack: 0, currentBet: 7 },
    { seatNumber: 2, stack: 95, currentBet: 5 },
    { seatNumber: 3, stack: 90, currentBet: 10 },
  ]);
  assert.equal(hand.seats[0].stack, 7);
  assert.equal(hand.pot, 15);
});

test('preflop call rejects malformed pots without changing the hand', () => {
  for (const pot of [-20, Number.MAX_SAFE_INTEGER, Number.NaN]) {
    const hand = startedThreePlayerHand();
    hand.pot = pot;

    assert.throws(() => applyPreflopCall(hand, 1), /safe|pot/);
    assert.equal(hand.pot, pot);
    assert.equal(hand.currentActorSeat, 1);
    assert.equal(hand.seats[0].stack, 100);
    assert.equal(hand.seats[0].currentBet, 0);
  }
});

test('preflop fold marks only the active eligible actor as folded and advances action', () => {
  const hand = startedThreePlayerHand();

  const foldedHand = applyPreflopFold(hand, 1);

  assert.notEqual(foldedHand, hand);
  assert.equal(foldedHand.currentActorSeat, 2);
  assert.equal(foldedHand.pot, 15);
  assert.equal(foldedHand.currentBet, 10);
  assert.deepEqual(foldedHand.seats.map((seat) => ({ seatNumber: seat.seatNumber, stack: seat.stack, currentBet: seat.currentBet, isFolded: seat.isFolded })), [
    { seatNumber: 1, stack: 100, currentBet: 0, isFolded: true },
    { seatNumber: 2, stack: 95, currentBet: 5, isFolded: false },
    { seatNumber: 3, stack: 90, currentBet: 10, isFolded: false },
  ]);
  assert.equal(hand.currentActorSeat, 1);
  assert.equal(hand.seats[0].isFolded, undefined);
  assert.throws(() => applyPreflopFold(hand, 2), /active actor/);
});

test('preflop fold rejects malformed pots without changing the hand', () => {
  for (const pot of [-20, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    const hand = startedThreePlayerHand();
    hand.pot = pot;

    assert.throws(() => applyPreflopFold(hand, 1), /safe|pot/);
    assert.equal(hand.pot, pot);
    assert.equal(hand.currentActorSeat, 1);
    assert.equal(hand.seats[0].isFolded, undefined);
  }
});

test('heads-up preflop fold is advertised because it can immediately concede the pot', () => {
  const hand = startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 100 },
      { seatNumber: 2, playerId: 'ben', stack: 100 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  });

  assert.equal(getPreflopLegalActions(hand).canFold, true);
  const folded = applyPreflopFold(hand, 1);
  assert.equal(folded.seats[0].isFolded, true);
  assert.equal(folded.currentActorSeat, 2);
});

test('preflop full raise commits to its total target, updates the current bet, and advances action', () => {
  const hand = startedThreePlayerHand();

  const raisedHand = applyPreflopRaise(hand, 1, 20);

  assert.notEqual(raisedHand, hand);
  assert.equal(raisedHand.currentActorSeat, 2);
  assert.equal(raisedHand.currentBet, 20);
  assert.equal(raisedHand.minimumRaiseIncrement, 10);
  assert.equal(raisedHand.pot, 35);
  assert.deepEqual(raisedHand.seats.map((seat) => ({ seatNumber: seat.seatNumber, stack: seat.stack, currentBet: seat.currentBet })), [
    { seatNumber: 1, stack: 80, currentBet: 20 },
    { seatNumber: 2, stack: 95, currentBet: 5 },
    { seatNumber: 3, stack: 90, currentBet: 10 },
  ]);
  assert.equal(hand.currentBet, 10);
  assert.equal(hand.pot, 15);
  assert.equal(hand.seats[0].stack, 100);
});

test('preflop raise rejects non-full, over-stack, and malformed targets without changing the hand', () => {
  for (const raiseTo of [19, 101, -20, Number.NaN, Number.POSITIVE_INFINITY]) {
    const hand = startedThreePlayerHand();

    assert.throws(() => applyPreflopRaise(hand, 1, raiseTo), /raise|safe integer|target/i);
    assert.equal(hand.currentActorSeat, 1);
    assert.equal(hand.currentBet, 10);
    assert.equal(hand.pot, 15);
    assert.equal(hand.seats[0].stack, 100);
    assert.equal(hand.seats[0].currentBet, 0);
  }
});

test('preflop raise charges only the additional commitment when a blind raises', () => {
  const hand = applyPreflopCall(startedThreePlayerHand(), 1);

  const raisedHand = applyPreflopRaise(hand, 2, 20);

  assert.equal(raisedHand.currentActorSeat, 3);
  assert.equal(raisedHand.currentBet, 20);
  assert.equal(raisedHand.pot, 40);
  assert.deepEqual(raisedHand.seats.map((seat) => ({ seatNumber: seat.seatNumber, stack: seat.stack, currentBet: seat.currentBet })), [
    { seatNumber: 1, stack: 90, currentBet: 10 },
    { seatNumber: 2, stack: 80, currentBet: 20 },
    { seatNumber: 3, stack: 90, currentBet: 10 },
  ]);
  assert.equal(hand.pot, 25);
  assert.equal(hand.seats[1].stack, 95);
});

test('preflop raise rejects malformed or overflowing pots before changing the hand', () => {
  for (const pot of [-1, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    const hand = startedThreePlayerHand();
    hand.pot = pot;

    assert.throws(() => applyPreflopRaise(hand, 1, 20), /safe pot|safe integers/);
    assert.equal(hand.currentActorSeat, 1);
    assert.equal(hand.currentBet, 10);
    assert.equal(hand.pot, pot);
    assert.equal(hand.seats[0].stack, 100);
    assert.equal(hand.seats[0].currentBet, 0);
  }
});

test('preflop all-in permits a short raise without changing the minimum full-raise increment', () => {
  const hand = startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 15 },
      { seatNumber: 2, playerId: 'ben', stack: 100 },
      { seatNumber: 3, playerId: 'cy', stack: 100 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  });

  const allInHand = applyPreflopAllIn(hand, 1);

  assert.equal(allInHand.currentActorSeat, 2);
  assert.equal(allInHand.currentBet, 15);
  assert.equal(allInHand.minimumRaiseIncrement, 10);
  assert.equal(allInHand.pot, 30);
  assert.deepEqual(allInHand.seats.map((seat) => ({ seatNumber: seat.seatNumber, stack: seat.stack, currentBet: seat.currentBet })), [
    { seatNumber: 1, stack: 0, currentBet: 15 },
    { seatNumber: 2, stack: 95, currentBet: 5 },
    { seatNumber: 3, stack: 90, currentBet: 10 },
  ]);
  assert.equal(getPreflopLegalActions(allInHand).minRaiseTo, 25);
  assert.equal(hand.currentBet, 10);
  assert.equal(hand.minimumRaiseIncrement, 10);
  assert.equal(hand.pot, 15);
});

test('preflop all-in rejects a non-raising stack and malformed pots without changing the hand', () => {
  const shortCallHand = startHand({
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
  assert.throws(() => applyPreflopAllIn(shortCallHand, 1), /must be a raise/);
  assert.equal(shortCallHand.seats[0].stack, 7);

  const malformedPotHand = startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 15 },
      { seatNumber: 2, playerId: 'ben', stack: 100 },
      { seatNumber: 3, playerId: 'cy', stack: 100 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  });
  malformedPotHand.pot = Number.MAX_SAFE_INTEGER;
  assert.throws(() => applyPreflopAllIn(malformedPotHand, 1), /safe pot|safe integers/);
  assert.equal(malformedPotHand.currentActorSeat, 1);
  assert.equal(malformedPotHand.pot, Number.MAX_SAFE_INTEGER);
  assert.equal(malformedPotHand.seats[0].stack, 15);
});

test('coverage only: a short all-in preserves a larger prior full-raise increment', () => {
  const hand = startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 100 },
      { seatNumber: 2, playerId: 'ben', stack: 100 },
      { seatNumber: 3, playerId: 'cy', stack: 33 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  });

  const fullRaise = applyPreflopRaise(hand, 1, 30);
  const calledRaise = applyPreflopCall(fullRaise, 2);
  const allInHand = applyPreflopAllIn(calledRaise, 3);

  assert.equal(fullRaise.minimumRaiseIncrement, 20);
  assert.equal(allInHand.currentBet, 33);
  assert.equal(allInHand.minimumRaiseIncrement, 20);
  assert.equal(getPreflopLegalActions(allInHand).minRaiseTo, 53);
});

test('preflop all-in permits a full raise, consumes the actor stack, and reopens the raise increment', () => {
  const hand = startedThreePlayerHand();

  const allInHand = applyPreflopAllIn(hand, 1);

  assert.equal(allInHand.currentActorSeat, 2);
  assert.equal(allInHand.currentBet, 100);
  assert.equal(allInHand.minimumRaiseIncrement, 90);
  assert.equal(allInHand.pot, 115);
  assert.deepEqual(allInHand.seats.map((seat) => ({ seatNumber: seat.seatNumber, stack: seat.stack, currentBet: seat.currentBet })), [
    { seatNumber: 1, stack: 0, currentBet: 100 },
    { seatNumber: 2, stack: 95, currentBet: 5 },
    { seatNumber: 3, stack: 90, currentBet: 10 },
  ]);
  assert.equal(getPreflopLegalActions(allInHand).minRaiseTo, null);
  assert.equal(hand.currentBet, 10);
  assert.equal(hand.minimumRaiseIncrement, 10);
  assert.equal(hand.pot, 15);
});
