import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toPlayerView } from '../packages/poker-core/src/index.ts';

const aliceCards = [
  { rank: 'A', suit: 'spades' },
  { rank: 'K', suit: 'spades' },
];

const tableState = {
  tableId: 'table-1',
  dealerSeat: 2,
  street: 'flop',
  communityCards: [
    { rank: '2', suit: 'clubs' },
    { rank: '7', suit: 'diamonds' },
    { rank: 'J', suit: 'hearts' },
  ],
  pot: 60,
  seats: [
    {
      seatNumber: 1,
      player: { id: 'alice', name: 'Alice' },
      stack: 940,
      currentBet: 20,
      isFolded: false,
      holeCards: aliceCards,
    },
    {
      seatNumber: 2,
      player: { id: 'bob', name: 'Bob' },
      stack: 940,
      currentBet: 20,
      isFolded: false,
      holeCards: [
        { rank: 'Q', suit: 'hearts' },
        { rank: 'Q', suit: 'clubs' },
      ],
    },
  ],
};

test('player view includes public table state and requesting player hole cards', () => {
  const view = toPlayerView(tableState, 'alice');

  assert.equal(view.tableId, 'table-1');
  assert.equal(view.street, 'flop');
  assert.deepEqual(view.communityCards, tableState.communityCards);
  assert.deepEqual(view.holeCards, aliceCards);
});

test('player view is isolated from authoritative table state mutations', () => {
  const view = toPlayerView(tableState, 'alice');
  const originalHoleCards = tableState.seats[0].holeCards.map((card) => ({ ...card }));
  const originalCommunityCards = tableState.communityCards.map((card) => ({ ...card }));
  const originalSeatsLength = tableState.seats.length;
  const originalPlayer = { ...tableState.seats[1].player };
  const originalStack = tableState.seats[1].stack;

  view.holeCards[0].rank = '2';
  view.holeCards.push({ rank: '3', suit: 'clubs' });
  view.communityCards[0].suit = 'spades';
  view.communityCards.push({ rank: '4', suit: 'diamonds' });
  view.seats.push({
    seatNumber: 3,
    player: { id: 'carol', name: 'Carol' },
    stack: 1_000,
    currentBet: 0,
    isFolded: false,
  });
  view.seats[1].player.name = 'Mutated Bob';
  view.seats[1].stack = 0;

  assert.deepEqual(tableState.seats[0].holeCards, originalHoleCards);
  assert.deepEqual(tableState.communityCards, originalCommunityCards);
  assert.equal(tableState.seats.length, originalSeatsLength);
  assert.deepEqual(tableState.seats[1].player, originalPlayer);
  assert.equal(tableState.seats[1].stack, originalStack);
});

test('player view never exposes opponent hole cards', () => {
  const view = toPlayerView(tableState, 'alice');

  assert.equal(JSON.stringify(view).includes('"Q"'), false);
  assert.deepEqual(view.seats, [
    {
      seatNumber: 1,
      player: { id: 'alice', name: 'Alice' },
      stack: 940,
      currentBet: 20,
      isFolded: false,
    },
    {
      seatNumber: 2,
      player: { id: 'bob', name: 'Bob' },
      stack: 940,
      currentBet: 20,
      isFolded: false,
    },
  ]);
});

test('player view rejects a player who is not seated', () => {
  assert.throws(
    () => toPlayerView(tableState, 'carol'),
    /Player "carol" is not seated at table "table-1"/,
  );
});
