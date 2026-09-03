import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Deck } from '../packages/poker-core/src/index.ts';

test('a new deck contains each of the 52 standard cards exactly once', () => {
  const deck = new Deck();
  const cards = deck.deal(52);

  assert.equal(deck.remaining, 0);
  assert.equal(cards.length, 52);
  assert.equal(new Set(cards.map(({ rank, suit }) => `${rank}-${suit}`)).size, 52);
});

test('an injected random integer function shuffles reproducibly without losing cards', () => {
  const firstDeck = new Deck();
  const secondDeck = new Deck();
  const originalOrder = new Deck().deal(52);
  const randomInt = () => 0;

  firstDeck.shuffle(randomInt);
  secondDeck.shuffle(randomInt);
  const firstOrder = firstDeck.deal(52);
  const secondOrder = secondDeck.deal(52);

  assert.notDeepEqual(firstOrder, originalOrder);
  assert.deepEqual(firstOrder, secondOrder);
  assert.equal(new Set(firstOrder.map(({ rank, suit }) => `${rank}-${suit}`)).size, 52);
});

test('dealing one or many cards updates remaining cards without duplicates', () => {
  const deck = new Deck();

  const firstCard = deck.deal();
  const nextCards = deck.deal(2);

  assert.equal(deck.remaining, 49);
  assert.equal(new Set([firstCard, ...nextCards].map(({ rank, suit }) => `${rank}-${suit}`)).size, 3);
});

test('dealing too many cards fails without changing the deck', () => {
  const deck = new Deck();
  const firstCard = deck.deal();

  assert.throws(() => deck.deal(52), /Cannot deal 52 cards: only 51 remaining/);
  assert.equal(deck.remaining, 51);
  assert.notDeepEqual(deck.deal(), firstCard);
});

test('shuffle rejects a random integer result outside its requested range', () => {
  const deck = new Deck();
  const originalOrder = new Deck().deal(52);

  assert.throws(() => deck.shuffle(() => 52), /randomInt must return an integer from 0 to 51/);
  assert.deepEqual(deck.deal(52), originalOrder);
});

test('shuffle rejects a negative random integer result without changing the deck', () => {
  const deck = new Deck();
  const originalOrder = new Deck().deal(52);

  assert.throws(() => deck.shuffle(() => -1), /randomInt must return an integer from 0 to 51/);
  assert.deepEqual(deck.deal(52), originalOrder);
});

test('shuffle leaves the deck unchanged when a later random integer result is invalid', () => {
  const deck = new Deck();
  const originalOrder = new Deck().deal(52);
  const randomResults = [0, 0, 50];

  assert.throws(
    () => deck.shuffle(() => randomResults.shift()),
    /randomInt must return an integer from 0 to 49/,
  );
  assert.deepEqual(deck.deal(52), originalOrder);
});

test('shuffle rejects a non-integer random result without changing the deck', () => {
  const deck = new Deck();
  const originalOrder = new Deck().deal(52);

  assert.throws(() => deck.shuffle(() => 0.5), /randomInt must return an integer from 0 to 51/);
  assert.deepEqual(deck.deal(52), originalOrder);
});
