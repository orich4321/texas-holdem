import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compareFiveCardHands,
  evaluateFiveCardHand,
} from '../packages/poker-core/src/index.ts';

const card = (rank, suit) => ({ rank, suit });

const highCard = [
  card('A', 'clubs'),
  card('J', 'diamonds'),
  card('8', 'hearts'),
  card('5', 'spades'),
  card('2', 'clubs'),
];

const onePair = [
  card('Q', 'clubs'),
  card('Q', 'diamonds'),
  card('9', 'hearts'),
  card('6', 'spades'),
  card('3', 'clubs'),
];

test('one pair beats a high card hand', () => {
  assert.equal(compareFiveCardHands(onePair, highCard), 1);
  assert.equal(compareFiveCardHands(highCard, onePair), -1);
});

test('a higher pair rank wins', () => {
  const lowerPair = [
    card('10', 'clubs'), card('10', 'diamonds'), card('A', 'hearts'), card('8', 'spades'), card('3', 'clubs'),
  ];
  const higherPair = [
    card('J', 'clubs'), card('J', 'diamonds'), card('2', 'hearts'), card('4', 'spades'), card('5', 'clubs'),
  ];

  assert.equal(compareFiveCardHands(higherPair, lowerPair), 1);
});

test('one-pair kickers decide a tied pair rank', () => {
  const lowerKicker = [
    card('9', 'clubs'), card('9', 'diamonds'), card('A', 'hearts'), card('J', 'spades'), card('4', 'clubs'),
  ];
  const higherKicker = [
    card('9', 'hearts'), card('9', 'spades'), card('A', 'clubs'), card('Q', 'diamonds'), card('2', 'clubs'),
  ];

  assert.equal(compareFiveCardHands(higherKicker, lowerKicker), 1);
});

test('high-card kickers decide the comparison in descending rank order', () => {
  const lowerKicker = [
    card('A', 'clubs'), card('J', 'diamonds'), card('8', 'hearts'), card('5', 'spades'), card('2', 'clubs'),
  ];
  const higherKicker = [
    card('A', 'hearts'), card('Q', 'diamonds'), card('7', 'clubs'), card('4', 'spades'), card('3', 'clubs'),
  ];

  assert.equal(compareFiveCardHands(higherKicker, lowerKicker), 1);
});

test('the evaluator rejects inputs that are not exactly five distinct physical cards', () => {
  assert.throws(() => evaluateFiveCardHand(highCard.slice(0, 4)), /exactly five cards/i);
  assert.throws(
    () => evaluateFiveCardHand([...highCard.slice(0, 4), card('A', 'clubs')]),
    /duplicate physical card/i,
  );
});

test('the evaluator returns a value detached from and does not mutate the input cards', () => {
  const hand = onePair.map((value) => ({ ...value }));
  const before = hand.map((value) => ({ ...value }));

  const result = evaluateFiveCardHand(hand);

  assert.deepEqual(hand, before);
  assert.deepEqual(result, { category: 'one-pair', tieBreakRanks: ['Q', '9', '6', '3'] });
  assert.equal('cards' in result, false);
});

test('the evaluator rejects malformed runtime card ranks and suits', () => {
  assert.throws(
    () => evaluateFiveCardHand([card('A', 'clubs'), card('J', 'diamonds'), card('8', 'hearts'), card('5', 'spades'), card('invalid-rank', 'clubs')]),
    /invalid card rank/i,
  );
  assert.throws(
    () => evaluateFiveCardHand([card('A', 'clubs'), card('J', 'diamonds'), card('8', 'hearts'), card('5', 'spades'), card('2', 'invalid-suit')]),
    /invalid card suit/i,
  );
});

test('two-pair evaluation returns ranked pairs and a kicker without mutating input', () => {
  const hand = [
    card('K', 'clubs'), card('A', 'diamonds'), card('K', 'hearts'), card('2', 'spades'), card('A', 'clubs'),
  ];
  const before = hand.map((value) => ({ ...value }));

  assert.deepEqual(evaluateFiveCardHand(hand), {
    category: 'two-pair', tieBreakRanks: ['A', 'K', '2'],
  });
  assert.deepEqual(hand, before);
});

test('two-pair beats one-pair and high-card hands', () => {
  const twoPair = [
    card('A', 'clubs'), card('A', 'diamonds'), card('K', 'hearts'), card('K', 'spades'), card('2', 'clubs'),
  ];

  assert.equal(compareFiveCardHands(twoPair, onePair), 1);
  assert.equal(compareFiveCardHands(twoPair, highCard), 1);
});

test('a higher two-pair rank wins', () => {
  const lowerHighPair = [
    card('K', 'clubs'), card('K', 'diamonds'), card('Q', 'hearts'), card('Q', 'spades'), card('A', 'clubs'),
  ];
  const higherHighPair = [
    card('A', 'hearts'), card('A', 'spades'), card('2', 'hearts'), card('2', 'spades'), card('3', 'clubs'),
  ];

  assert.equal(compareFiveCardHands(higherHighPair, lowerHighPair), 1);
});

test('the lower pair decides when two-pair high ranks are equal', () => {
  const lowerSecondPair = [
    card('A', 'clubs'), card('A', 'diamonds'), card('J', 'hearts'), card('J', 'spades'), card('K', 'clubs'),
  ];
  const higherSecondPair = [
    card('A', 'hearts'), card('A', 'spades'), card('Q', 'hearts'), card('Q', 'spades'), card('2', 'clubs'),
  ];

  assert.equal(compareFiveCardHands(higherSecondPair, lowerSecondPair), 1);
});

test('the kicker decides when both two-pair ranks are equal', () => {
  const lowerKicker = [
    card('A', 'clubs'), card('A', 'diamonds'), card('K', 'hearts'), card('K', 'spades'), card('2', 'clubs'),
  ];
  const higherKicker = [
    card('A', 'hearts'), card('A', 'spades'), card('K', 'clubs'), card('K', 'diamonds'), card('Q', 'clubs'),
  ];

  assert.equal(compareFiveCardHands(higherKicker, lowerKicker), 1);
});

test('equivalent two-pair hands compare as tied regardless of card order or suits', () => {
  const first = [
    card('A', 'clubs'), card('A', 'diamonds'), card('K', 'hearts'), card('K', 'spades'), card('2', 'clubs'),
  ];
  const equivalent = [
    card('K', 'diamonds'), card('2', 'hearts'), card('A', 'spades'), card('K', 'clubs'), card('A', 'hearts'),
  ];

  assert.equal(compareFiveCardHands(first, first), 0);
  assert.equal(compareFiveCardHands(first, equivalent), 0);
});

test('three-of-a-kind evaluation returns the trip rank then descending kickers without mutating input', () => {
  const hand = [
    card('7', 'clubs'), card('A', 'diamonds'), card('7', 'hearts'), card('K', 'spades'), card('7', 'spades'),
  ];
  const before = hand.map((value) => ({ ...value }));

  assert.deepEqual(evaluateFiveCardHand(hand), {
    category: 'three-of-a-kind', tieBreakRanks: ['7', 'A', 'K'],
  });
  assert.deepEqual(hand, before);
});

test('three-of-a-kind beats two-pair, one-pair, and high-card hands', () => {
  const trips = [
    card('4', 'clubs'), card('4', 'diamonds'), card('A', 'hearts'), card('K', 'spades'), card('4', 'hearts'),
  ];

  assert.equal(compareFiveCardHands(trips, [
    card('A', 'clubs'), card('A', 'diamonds'), card('K', 'hearts'), card('K', 'spades'), card('2', 'clubs'),
  ]), 1);
  assert.equal(compareFiveCardHands(trips, onePair), 1);
  assert.equal(compareFiveCardHands(trips, highCard), 1);
});

test('three-of-a-kind rank then kickers decide comparison, with equivalent hands tied', () => {
  const lowerTrips = [
    card('8', 'clubs'), card('8', 'diamonds'), card('A', 'hearts'), card('K', 'spades'), card('8', 'hearts'),
  ];
  const higherTrips = [
    card('9', 'clubs'), card('9', 'diamonds'), card('2', 'hearts'), card('3', 'spades'), card('9', 'hearts'),
  ];
  const lowerKicker = [
    card('Q', 'clubs'), card('Q', 'diamonds'), card('A', 'hearts'), card('J', 'spades'), card('Q', 'hearts'),
  ];
  const higherKicker = [
    card('Q', 'spades'), card('Q', 'hearts'), card('A', 'clubs'), card('K', 'diamonds'), card('Q', 'clubs'),
  ];
  const equivalent = [
    card('Q', 'diamonds'), card('K', 'clubs'), card('Q', 'spades'), card('A', 'spades'), card('Q', 'hearts'),
  ];

  assert.equal(compareFiveCardHands(higherTrips, lowerTrips), 1);
  assert.equal(compareFiveCardHands(higherKicker, lowerKicker), 1);
  assert.equal(compareFiveCardHands(higherKicker, equivalent), 0);
});

test('straight evaluation returns its high card, treating the ace-low wheel as five-high', () => {
  const sixHighStraight = [
    card('4', 'clubs'), card('6', 'diamonds'), card('2', 'hearts'), card('5', 'spades'), card('3', 'clubs'),
  ];
  const wheel = [
    card('A', 'clubs'), card('2', 'diamonds'), card('3', 'hearts'), card('4', 'spades'), card('5', 'clubs'),
  ];

  assert.deepEqual(evaluateFiveCardHand(sixHighStraight), {
    category: 'straight', tieBreakRanks: ['6'],
  });
  assert.deepEqual(evaluateFiveCardHand(wheel), {
    category: 'straight', tieBreakRanks: ['5'],
  });
});

test('a straight beats three-of-a-kind and compares by its high card', () => {
  const sixHighStraight = [
    card('2', 'clubs'), card('3', 'diamonds'), card('4', 'hearts'), card('5', 'spades'), card('6', 'clubs'),
  ];
  const sevenHighStraight = [
    card('3', 'clubs'), card('4', 'diamonds'), card('5', 'hearts'), card('6', 'spades'), card('7', 'clubs'),
  ];
  const trips = [
    card('9', 'clubs'), card('9', 'diamonds'), card('9', 'hearts'), card('A', 'spades'), card('2', 'clubs'),
  ];

  assert.equal(compareFiveCardHands(sixHighStraight, trips), 1);
  assert.equal(compareFiveCardHands(sevenHighStraight, sixHighStraight), 1);
});


test('the first three-of-a-kind kicker decides before the second kicker', () => {
  const higherFirstKicker = [
    card('J', 'clubs'), card('J', 'diamonds'), card('A', 'hearts'), card('2', 'spades'), card('J', 'hearts'),
  ];
  const lowerFirstKicker = [
    card('J', 'spades'), card('J', 'hearts'), card('K', 'clubs'), card('Q', 'diamonds'), card('J', 'clubs'),
  ];

  assert.equal(compareFiveCardHands(higherFirstKicker, lowerFirstKicker), 1);
});

test('flush evaluation returns all ranks in descending order without mutating input', () => {
  const hand = [
    card('2', 'hearts'), card('A', 'hearts'), card('9', 'hearts'), card('K', 'hearts'), card('5', 'hearts'),
  ];
  const before = hand.map((value) => ({ ...value }));

  const result = evaluateFiveCardHand(hand);
  assert.deepEqual(result, {
    category: 'flush', tieBreakRanks: ['A', 'K', '9', '5', '2'],
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.tieBreakRanks), true);
  assert.deepEqual(hand, before);
});

test('a flush beats a straight and compares every descending rank', () => {
  const lowerFlush = [
    card('A', 'clubs'), card('J', 'clubs'), card('8', 'clubs'), card('5', 'clubs'), card('2', 'clubs'),
  ];
  const higherSecondRank = [
    card('A', 'hearts'), card('Q', 'hearts'), card('7', 'hearts'), card('4', 'hearts'), card('3', 'hearts'),
  ];
  const higherFinalRank = [
    card('A', 'diamonds'), card('K', 'diamonds'), card('9', 'diamonds'), card('5', 'diamonds'), card('3', 'diamonds'),
  ];
  const lowerFinalRank = [
    card('A', 'spades'), card('K', 'spades'), card('9', 'spades'), card('5', 'spades'), card('2', 'spades'),
  ];
  const equivalentFlush = [
    card('5', 'diamonds'), card('A', 'diamonds'), card('3', 'diamonds'), card('9', 'diamonds'), card('K', 'diamonds'),
  ];
  const straight = [
    card('2', 'clubs'), card('3', 'diamonds'), card('4', 'hearts'), card('5', 'spades'), card('6', 'clubs'),
  ];

  assert.equal(compareFiveCardHands(lowerFlush, straight), 1);
  assert.equal(compareFiveCardHands(higherSecondRank, lowerFlush), 1);
  assert.equal(compareFiveCardHands(higherFinalRank, lowerFinalRank), 1);
  assert.equal(compareFiveCardHands(higherFinalRank, equivalentFlush), 0);
});

test('full-house evaluation returns trip rank then pair rank without mutating input', () => {
  const hand = [
    card('K', 'clubs'), card('2', 'diamonds'), card('K', 'hearts'), card('2', 'spades'), card('K', 'spades'),
  ];
  const before = hand.map((value) => ({ ...value }));

  const result = evaluateFiveCardHand(hand);

  assert.deepEqual(result, { category: 'full-house', tieBreakRanks: ['K', '2'] });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.tieBreakRanks), true);
  assert.deepEqual(hand, before);
});

test('a full house beats a flush and compares trip rank before pair rank', () => {
  const lowerTrips = [
    card('Q', 'clubs'), card('Q', 'diamonds'), card('Q', 'hearts'), card('A', 'spades'), card('A', 'clubs'),
  ];
  const higherTrips = [
    card('K', 'clubs'), card('K', 'diamonds'), card('K', 'hearts'), card('2', 'spades'), card('2', 'clubs'),
  ];
  const lowerPair = [
    card('K', 'spades'), card('K', 'hearts'), card('K', 'diamonds'), card('2', 'hearts'), card('2', 'diamonds'),
  ];
  const higherPair = [
    card('K', 'clubs'), card('K', 'diamonds'), card('K', 'hearts'), card('A', 'spades'), card('A', 'clubs'),
  ];
  const flush = [
    card('A', 'clubs'), card('J', 'clubs'), card('8', 'clubs'), card('5', 'clubs'), card('2', 'clubs'),
  ];

  assert.equal(compareFiveCardHands(higherTrips, lowerTrips), 1);
  assert.equal(compareFiveCardHands(higherPair, lowerPair), 1);
  assert.equal(compareFiveCardHands(higherPair, flush), 1);
});

test('four-of-a-kind evaluation returns quad rank then kicker without mutating input', () => {
  const hand = [
    card('9', 'clubs'), card('A', 'diamonds'), card('9', 'hearts'), card('9', 'spades'), card('9', 'diamonds'),
  ];
  const before = hand.map((value) => ({ ...value }));

  const result = evaluateFiveCardHand(hand);

  assert.deepEqual(result, { category: 'four-of-a-kind', tieBreakRanks: ['9', 'A'] });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.tieBreakRanks), true);
  assert.deepEqual(hand, before);
});

test('four-of-a-kind beats a full house and compares quad rank then kicker', () => {
  const lowerQuads = [
    card('8', 'clubs'), card('8', 'diamonds'), card('8', 'hearts'), card('8', 'spades'), card('A', 'clubs'),
  ];
  const higherQuads = [
    card('9', 'clubs'), card('9', 'diamonds'), card('9', 'hearts'), card('9', 'spades'), card('2', 'clubs'),
  ];
  const lowerKicker = [
    card('K', 'clubs'), card('K', 'diamonds'), card('K', 'hearts'), card('K', 'spades'), card('2', 'clubs'),
  ];
  const higherKicker = [
    card('K', 'clubs'), card('K', 'diamonds'), card('K', 'hearts'), card('K', 'spades'), card('A', 'clubs'),
  ];
  const fullHouse = [
    card('A', 'clubs'), card('A', 'diamonds'), card('A', 'hearts'), card('K', 'spades'), card('K', 'clubs'),
  ];

  assert.equal(compareFiveCardHands(higherQuads, lowerQuads), 1);
  assert.equal(compareFiveCardHands(higherKicker, lowerKicker), 1);
  assert.equal(compareFiveCardHands(lowerQuads, fullHouse), 1);
});

test('straight-flush evaluation returns its high card, treating the ace-low wheel as five-high', () => {
  const royalFlush = [
    card('A', 'hearts'), card('K', 'hearts'), card('Q', 'hearts'), card('J', 'hearts'), card('10', 'hearts'),
  ];
  const wheel = [
    card('A', 'clubs'), card('2', 'clubs'), card('3', 'clubs'), card('4', 'clubs'), card('5', 'clubs'),
  ];
  const before = royalFlush.map((value) => ({ ...value }));

  const result = evaluateFiveCardHand(royalFlush);

  assert.deepEqual(result, { category: 'straight-flush', tieBreakRanks: ['A'] });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.tieBreakRanks), true);
  assert.deepEqual(evaluateFiveCardHand(wheel), { category: 'straight-flush', tieBreakRanks: ['5'] });
  assert.deepEqual(royalFlush, before);
});

test('a straight flush beats four-of-a-kind and compares by high card', () => {
  const sixHighStraightFlush = [
    card('2', 'clubs'), card('3', 'clubs'), card('4', 'clubs'), card('5', 'clubs'), card('6', 'clubs'),
  ];
  const sevenHighStraightFlush = [
    card('3', 'hearts'), card('4', 'hearts'), card('5', 'hearts'), card('6', 'hearts'), card('7', 'hearts'),
  ];
  const equivalentSixHigh = [
    card('6', 'spades'), card('2', 'spades'), card('5', 'spades'), card('3', 'spades'), card('4', 'spades'),
  ];
  const quads = [
    card('A', 'clubs'), card('A', 'diamonds'), card('A', 'hearts'), card('A', 'spades'), card('K', 'clubs'),
  ];

  assert.equal(compareFiveCardHands(sixHighStraightFlush, quads), 1);
  assert.equal(compareFiveCardHands(sevenHighStraightFlush, sixHighStraightFlush), 1);
  assert.equal(compareFiveCardHands(sixHighStraightFlush, equivalentSixHigh), 0);
});
