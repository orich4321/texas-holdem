import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  advancePreflopToFlop,
  applyFlopAllIn,
  applyFlopCall,
  applyPreflopCall,
  applyPreflopCheck,
  runOutAllInToShowdown,
  startHand,
} from '../packages/poker-core/src/index.ts';

const unshuffledRandomInt = (maxExclusive) => maxExclusive - 1;

function allInFlop() {
  const preflop = startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 10 },
      { seatNumber: 2, playerId: 'ben', stack: 10 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  });
  return advancePreflopToFlop(applyPreflopCall(preflop, 1));
}

test('a settled all-in flop automatically burns/deals turn and river to an authoritative showdown entry', () => {
  const flop = allInFlop();
  const showdown = runOutAllInToShowdown(flop);

  assert.equal(showdown.street, 'showdown');
  assert.deepEqual(showdown.communityCards, [
    { rank: '7', suit: 'clubs' },
    { rank: '8', suit: 'clubs' },
    { rank: '9', suit: 'clubs' },
    { rank: 'J', suit: 'clubs' },
    { rank: 'K', suit: 'clubs' },
  ]);
  assert.equal(showdown.burnedCards.length, 3);
  assert.equal(showdown.remainingDeck.length, 40);
  assert.deepEqual(showdown.pendingActorSeats, []);
  assert.equal(Object.isFrozen(showdown), true);
  assert.equal(JSON.stringify(showdown).includes('remainingDeck'), false);
});

test('runout refuses an unsettled hand or one with a player who can still act', () => {
  const flop = allInFlop();
  assert.throws(() => runOutAllInToShowdown({ ...flop, pendingActorSeats: [1] }), /authoritative|private/i);

  const actionable = startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 100 },
      { seatNumber: 2, playerId: 'ben', stack: 100 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  });
  assert.throws(() => runOutAllInToShowdown(actionable), /postflop|all-in|settled/i);
});

test('runout permits a settled unequal all-in commitment for later side-pot settlement without mutating its input', () => {
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
  const shortAllIn = applyFlopAllIn(flop, 2);
  const deepAllIn = applyFlopAllIn(shortAllIn, 3);
  const settled = applyFlopCall(deepAllIn, 1);
  const sourceBoard = settled.communityCards.map((card) => ({ ...card }));
  const sourceDeck = settled.remainingDeck.map((card) => ({ ...card }));

  assert.deepEqual(settled.seats.map((seat) => ({ stack: seat.stack, currentBet: seat.currentBet })), [
    { stack: 0, currentBet: 90 },
    { stack: 0, currentBet: 25 },
    { stack: 0, currentBet: 90 },
  ]);
  assert.deepEqual(settled.pendingActorSeats, []);

  const showdown = runOutAllInToShowdown(settled);
  assert.equal(showdown.street, 'showdown');
  assert.equal(showdown.communityCards.length, 5);
  assert.equal(showdown.burnedCards.length, 3);
  assert.equal(new Set([
    ...showdown.seats.flatMap((seat) => seat.holeCards),
    ...showdown.communityCards,
    ...showdown.burnedCards,
    ...showdown.remainingDeck,
  ].map((card) => `${card.rank}-${card.suit}`)).size, 52);
  assert.deepEqual(settled.communityCards, sourceBoard);
  assert.deepEqual(settled.remainingDeck, sourceDeck);
});
