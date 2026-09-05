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
