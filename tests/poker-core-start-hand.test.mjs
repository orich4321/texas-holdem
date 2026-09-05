import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startHand } from '../packages/poker-core/src/index.ts';

test('a three-player hand posts blinds and opens preflop action left of the big blind', () => {
  const seats = [
    { seatNumber: 1, playerId: 'ada', stack: 100 },
    { seatNumber: 2, playerId: 'ben', stack: 100 },
    { seatNumber: 3, playerId: 'cy', stack: 100 },
  ];

  const hand = startHand({
    seats,
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
  });

  assert.deepEqual(hand, {
    dealerSeat: 1,
    smallBlindSeat: 2,
    bigBlindSeat: 3,
    currentActorSeat: 1,
    currentBet: 10,
    pot: 15,
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 100, currentBet: 0 },
      { seatNumber: 2, playerId: 'ben', stack: 95, currentBet: 5 },
      { seatNumber: 3, playerId: 'cy', stack: 90, currentBet: 10 },
    ],
  });
  assert.deepEqual(seats, [
    { seatNumber: 1, playerId: 'ada', stack: 100 },
    { seatNumber: 2, playerId: 'ben', stack: 100 },
    { seatNumber: 3, playerId: 'cy', stack: 100 },
  ]);
});

test('startHand rejects malformed runtime values and unsafe chip arithmetic without mutating valid inputs', () => {
  assert.throws(() => startHand(null), /input must be an object/i);
  assert.throws(() => startHand({
    seats: [null, { seatNumber: 2, playerId: 'ben', stack: 100 }, { seatNumber: 3, playerId: 'cy', stack: 100 }],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
  }), /seat must be an object/i);
  assert.throws(() => startHand({
    seats: [{ seatNumber: 1, playerId: {}, stack: 100 }, { seatNumber: 2, playerId: 'ben', stack: 100 }, { seatNumber: 3, playerId: 'cy', stack: 100 }],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
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
  }), /safe integer/i);
});
