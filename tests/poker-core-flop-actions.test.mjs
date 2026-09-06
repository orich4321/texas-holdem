import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  advanceFlopToTurn,
  applyFlopAllIn,
  applyFlopCall,
  advancePreflopToFlop,
  applyFlopCheck,
  applyFlopFold,
  applyFlopRaise,
  applyPreflopCall,
  applyPreflopCheck,
  getFlopLegalActions,
  startHand,
} from '../packages/poker-core/src/index.ts';

const unshuffledRandomInt = (maxExclusive) => maxExclusive - 1;

function settledFlopHand(stacks = [100, 100, 100]) {
  const started = startHand({
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

  assert.throws(() => advanceFlopToTurn(duplicate), /authoritative private/i);
  assert.throws(() => advanceFlopToTurn(malformed), /authoritative private/i);
  assert.throws(() => advanceFlopToTurn(forgedPot), /authoritative private/i);
  assert.throws(() => advanceFlopToTurn(forgedBets), /authoritative private/i);
  assert.equal(settled.remainingDeck[0].rank, 'Q');
  assert.equal(settled.communityCards.length, 3);
});

test('flop call commits only chips owed, then permits the turn transition when settled', () => {
  const opened = applyFlopRaise(settledFlopHand(), 2, 20);
  const called = applyFlopCall(opened, 3);
  const settled = applyFlopCall(called, 1);

  assert.equal(opened.currentBet, 20);
  assert.equal(opened.pot, 50);
  assert.equal(called.pot, 70);
  assert.equal(settled.pot, 90);
  assert.deepEqual(settled.pendingActorSeats, []);
  assert.equal(advanceFlopToTurn(settled).street, 'turn');
});

test('flop fold removes only the active actor from pending action and preserves committed chips', () => {
  const flop = settledFlopHand();
  const opened = applyFlopRaise(flop, 2, 20);
  const folded = applyFlopFold(opened, 3);

  assert.equal(folded.seats[2].isFolded, true);
  assert.equal(folded.pot, 50);
  assert.deepEqual(folded.pendingActorSeats, [1]);
  assert.equal(folded.currentActorSeat, 1);
  assert.equal(flop.seats[2].isFolded, undefined);
});

test('flop all-in accepts short and full raises without corrupting the raise increment', () => {
  const shortAllIn = applyFlopAllIn(applyFlopRaise(settledFlopHand(), 2, 20), 3);

  assert.equal(shortAllIn.currentBet, 90);
  assert.equal(shortAllIn.minimumRaiseIncrement, 70);
  assert.equal(shortAllIn.seats[2].stack, 0);
  assert.equal(shortAllIn.pot, 140);
  assert.equal(getFlopLegalActions(shortAllIn).actorSeat, 1);
});

test('a short all-in locks prior actors until a later full raise reopens betting', () => {
  const flop = settledFlopHand([35, 100, 100]);
  const checked = applyFlopCheck(flop, 2);
  const opened = applyFlopRaise(checked, 3, 20);
  const shortAllIn = applyFlopAllIn(opened, 1);
  const fullReraise = applyFlopRaise(shortAllIn, 2, 45);

  assert.deepEqual(shortAllIn.raiseLockedSeats, [3]);
  assert.equal(fullReraise.currentActorSeat, 3);
  assert.equal(getFlopLegalActions(fullReraise).canRaise, true);
});

test('a raise-locked flop actor cannot bypass short-all-in re-raise restrictions', () => {
  const flop = settledFlopHand([35, 100, 100]);
  const checked = applyFlopCheck(flop, 2);
  const shortAllIn = applyFlopAllIn(applyFlopRaise(checked, 3, 20), 1);
  const called = applyFlopCall(shortAllIn, 2);

  assert.equal(getFlopLegalActions(called).canRaise, false);
  assert.throws(() => applyFlopAllIn(called, 3), /locked|raise/i);
});

test('turn transition rejects a rehydrated flop hand even when its forged pot remains arithmetically consistent', () => {
  const flop = settledFlopHand();
  const settled = applyFlopCheck(applyFlopCheck(applyFlopCheck(flop, 2), 3), 1);
  const copied = {
    ...settled,
    street: settled.street,
    bigBlindAmount: settled.bigBlindAmount,
    streetPot: 0,
    pendingActorSeats: [...settled.pendingActorSeats],
    communityCards: [...settled.communityCards],
    remainingDeck: [...settled.remainingDeck],
    burnedCards: [...settled.burnedCards],
    pot: 0,
  };

  assert.throws(() => advanceFlopToTurn(copied), /authoritative|private/i);
});

test('authoritative flop state is deeply immutable before the turn transition', () => {
  const flop = settledFlopHand();
  const settled = applyFlopCheck(applyFlopCheck(applyFlopCheck(flop, 2), 3), 1);

  assert.throws(() => { settled.pot = 0; }, /read only|assign/i);
  assert.throws(() => { settled.seats[0].currentBet = 0; }, /read only|assign/i);
  assert.equal(advanceFlopToTurn(settled).pot, 30);
});
