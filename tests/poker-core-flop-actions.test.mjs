import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  advanceFlopToTurn,
  advancePreflopToFlop,
  applyFlopCheck,
  applyPreflopCall,
  applyPreflopCheck,
  getFlopLegalActions,
  startHand,
} from '../packages/poker-core/src/index.ts';

const unshuffledRandomInt = (maxExclusive) => maxExclusive - 1;

function settledFlopHand() {
  const started = startHand({
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
  return advancePreflopToFlop(
    applyPreflopCheck(applyPreflopCall(applyPreflopCall(started, 1), 2), 3),
  );
}

function settledHeadsUpFlopHand() {
  const started = startHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 100 },
      { seatNumber: 2, playerId: 'ben', stack: 100 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
    randomInt: unshuffledRandomInt,
  });
  return advancePreflopToFlop(applyPreflopCheck(applyPreflopCall(started, 1), 2));
}

test('flop exposes a free check to the first postflop actor and advances clockwise', () => {
  const flop = settledFlopHand();

  assert.deepEqual(getFlopLegalActions(flop), {
    actorSeat: 2,
    toCall: 0,
    canCheck: true,
    canCall: false,
    canFold: true,
    callAmount: 0,
    canRaise: true,
    minRaiseTo: 10,
    maxRaiseTo: 90,
  });

  const checked = applyFlopCheck(flop, 2);
  assert.equal(checked.currentActorSeat, 3);
  assert.deepEqual(checked.pendingActorSeats, [1, 3]);
  assert.equal(checked.pot, 30);
  assert.equal(flop.currentActorSeat, 2);
});

test('three settled flop checks advance to turn, reset bets, and burn exactly one card', () => {
  const flop = settledFlopHand();
  const checkedBySmallBlind = applyFlopCheck(flop, 2);
  const checkedByBigBlind = applyFlopCheck(checkedBySmallBlind, 3);
  const settled = applyFlopCheck(checkedByBigBlind, 1);

  assert.deepEqual(settled.pendingActorSeats, []);
  assert.throws(() => getFlopLegalActions(settled), /settled/i);

  const turn = advanceFlopToTurn(settled);
  assert.equal(turn.street, 'turn');
  assert.equal(turn.currentActorSeat, 2);
  assert.equal(turn.currentBet, 0);
  assert.equal(turn.minimumRaiseIncrement, 10);
  assert.equal(turn.pot, 30);
  assert.deepEqual(turn.communityCards, [
    { rank: '9', suit: 'clubs' },
    { rank: '10', suit: 'clubs' },
    { rank: 'J', suit: 'clubs' },
    { rank: 'K', suit: 'clubs' },
  ]);
  assert.equal(turn.remainingDeck.length, 40);
  assert.equal(JSON.stringify(turn).includes('remainingDeck'), false);
});

test('flop check rejects an out-of-turn actor and does not mutate the hand', () => {
  const flop = settledFlopHand();

  assert.throws(() => applyFlopCheck(flop, 3), /active actor/i);
  assert.equal(flop.currentActorSeat, 2);
  assert.deepEqual(flop.pendingActorSeats, [1, 2, 3]);
});

test('heads-up flop still exposes fold alongside a free check', () => {
  const flop = settledHeadsUpFlopHand();

  assert.equal(getFlopLegalActions(flop).canCheck, true);
  assert.equal(getFlopLegalActions(flop).canFold, true);
});

test('turn transition rejects forged duplicate or malformed private cards without mutating the flop', () => {
  const flop = settledFlopHand();
  const settled = applyFlopCheck(applyFlopCheck(applyFlopCheck(flop, 2), 3), 1);
  const privateState = { street: settled.street, bigBlindAmount: settled.bigBlindAmount, streetPot: settled.streetPot, pendingActorSeats: [...settled.pendingActorSeats], communityCards: [...settled.communityCards], burnedCards: [...settled.burnedCards] };
  const duplicate = { ...settled, ...privateState, remainingDeck: [settled.communityCards[0], ...settled.remainingDeck.slice(1)] };
  const malformed = { ...settled, ...privateState, remainingDeck: [{ rank: 'X', suit: 'void' }, ...settled.remainingDeck.slice(1)] };
  const forgedPot = { ...settled, ...privateState, remainingDeck: [...settled.remainingDeck], pot: 999_999 };
  const forgedBets = { ...settled, ...privateState, remainingDeck: [...settled.remainingDeck], currentBet: -1, seats: settled.seats.map((seat) => ({ ...seat, currentBet: -1 })) };

  assert.throws(() => advanceFlopToTurn(duplicate), /52 distinct valid cards/i);
  assert.throws(() => advanceFlopToTurn(malformed), /52 distinct valid cards/i);
  assert.throws(() => advanceFlopToTurn(forgedPot), /valid private deck and betting state/i);
  assert.throws(() => advanceFlopToTurn(forgedBets), /flop betting must be settled/i);
  assert.equal(settled.remainingDeck[0].rank, 'Q');
  assert.equal(settled.communityCards.length, 3);
});
