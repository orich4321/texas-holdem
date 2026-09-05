import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startHand } from '../packages/poker-core/src/index.ts';

const unshuffledRandomInt = (maxExclusive) => maxExclusive - 1;

test('a three-player hand posts blinds and opens preflop action left of the big blind', () => {
  const seats = [
    { seatNumber: 1, playerId: 'ada', stack: 100 },
    { seatNumber: 2, playerId: 'ben', stack: 100 },
    { seatNumber: 3, playerId: 'cy', stack: 100 },
  ];

  const hand = startHand({ seats, dealerSeat: 1, smallBlind: 5, bigBlind: 10, randomInt: unshuffledRandomInt });

  assert.deepEqual(hand, {
    dealerSeat: 1,
    smallBlindSeat: 2,
    bigBlindSeat: 3,
    currentActorSeat: 1,
    currentBet: 10,
    pot: 15,
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 100, currentBet: 0, holeCards: [{ rank: '4', suit: 'clubs' }, { rank: '7', suit: 'clubs' }] },
      { seatNumber: 2, playerId: 'ben', stack: 95, currentBet: 5, holeCards: [{ rank: '2', suit: 'clubs' }, { rank: '5', suit: 'clubs' }] },
      { seatNumber: 3, playerId: 'cy', stack: 90, currentBet: 10, holeCards: [{ rank: '3', suit: 'clubs' }, { rank: '6', suit: 'clubs' }] },
    ],
  });
  assert.deepEqual(seats, [
    { seatNumber: 1, playerId: 'ada', stack: 100 },
    { seatNumber: 2, playerId: 'ben', stack: 100 },
    { seatNumber: 3, playerId: 'cy', stack: 100 },
  ]);
});

test('a heads-up hand makes the dealer the small blind and opens preflop action on the dealer', () => {
  const seats = [
    { seatNumber: 4, playerId: 'ada', stack: 100 },
    { seatNumber: 9, playerId: 'ben', stack: 100 },
  ];

  const hand = startHand({ seats, dealerSeat: 4, smallBlind: 5, bigBlind: 10, randomInt: unshuffledRandomInt });

  assert.deepEqual(hand, {
    dealerSeat: 4,
    smallBlindSeat: 4,
    bigBlindSeat: 9,
    currentActorSeat: 4,
    currentBet: 10,
    pot: 15,
    seats: [
      { seatNumber: 4, playerId: 'ada', stack: 95, currentBet: 5, holeCards: [{ rank: '2', suit: 'clubs' }, { rank: '4', suit: 'clubs' }] },
      { seatNumber: 9, playerId: 'ben', stack: 90, currentBet: 10, holeCards: [{ rank: '3', suit: 'clubs' }, { rank: '5', suit: 'clubs' }] },
    ],
  });
  assert.deepEqual(seats, [
    { seatNumber: 4, playerId: 'ada', stack: 100 },
    { seatNumber: 9, playerId: 'ben', stack: 100 },
  ]);
});

test('startHand deals two deterministic hole cards clockwise from the small blind', () => {
  const hand = startHand({
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

  assert.deepEqual(hand.seats.map(({ playerId, holeCards }) => ({ playerId, holeCards })), [
    { playerId: 'ada', holeCards: [{ rank: '4', suit: 'clubs' }, { rank: '7', suit: 'clubs' }] },
    { playerId: 'ben', holeCards: [{ rank: '2', suit: 'clubs' }, { rank: '5', suit: 'clubs' }] },
    { playerId: 'cy', holeCards: [{ rank: '3', suit: 'clubs' }, { rank: '6', suit: 'clubs' }] },
  ]);
  assert.equal(new Set(hand.seats.flatMap((seat) => seat.holeCards).map(({ rank, suit }) => `${rank}-${suit}`)).size, 6);
});

test('startHand rejects an unaffordable blind before consuming injected randomness', () => {
  let randomCalls = 0;

  assert.throws(() => startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 100 },
      { seatNumber: 2, playerId: 'ben', stack: 4 },
      { seatNumber: 3, playerId: 'cy', stack: 100 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: (maxExclusive) => {
      randomCalls += 1;
      return maxExclusive - 1;
    },
  }), /enough chips to post their blind/i);
  assert.equal(randomCalls, 0);
});

test('startHand skips a zero-stack seat for dealer, blinds, action, and hole-card dealing', () => {
  const hand = startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 0 },
      { seatNumber: 2, playerId: 'ben', stack: 100 },
      { seatNumber: 3, playerId: 'cy', stack: 100 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  });

  assert.deepEqual(hand, {
    dealerSeat: 2,
    smallBlindSeat: 2,
    bigBlindSeat: 3,
    currentActorSeat: 2,
    currentBet: 10,
    pot: 15,
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 0, currentBet: 0 },
      { seatNumber: 2, playerId: 'ben', stack: 95, currentBet: 5, holeCards: [{ rank: '2', suit: 'clubs' }, { rank: '4', suit: 'clubs' }] },
      { seatNumber: 3, playerId: 'cy', stack: 90, currentBet: 10, holeCards: [{ rank: '3', suit: 'clubs' }, { rank: '5', suit: 'clubs' }] },
    ],
  });
});

test('startHand rejects malformed runtime values and unsafe chip arithmetic without mutating valid inputs', () => {
  assert.throws(() => startHand(null), /input must be an object/i);
  assert.throws(() => startHand({
    seats: [null, { seatNumber: 2, playerId: 'ben', stack: 100 }, { seatNumber: 3, playerId: 'cy', stack: 100 }],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  }), /seat must be an object/i);
  assert.throws(() => startHand({
    seats: [{ seatNumber: 1, playerId: {}, stack: 100 }, { seatNumber: 2, playerId: 'ben', stack: 100 }, { seatNumber: 3, playerId: 'cy', stack: 100 }],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  }), /player IDs/i);
  assert.throws(() => startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: Number.MAX_SAFE_INTEGER },
      { seatNumber: 2, playerId: 'ben', stack: Number.MAX_SAFE_INTEGER },
      { seatNumber: 3, playerId: 'cy', stack: Number.MAX_SAFE_INTEGER },
    ],
    dealerSeat: 1,
    smallBlind: Number.MAX_SAFE_INTEGER - 1,
    bigBlind: Number.MAX_SAFE_INTEGER,
    randomInt: unshuffledRandomInt,
  }), /safe integer/i);
});
