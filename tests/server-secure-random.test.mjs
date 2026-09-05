import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { createSecureRandomInt } from '../apps/server/src/secure-random.ts';
import { startServerHand } from '../apps/server/src/hand-start.ts';

const root = resolve(import.meta.dirname, '..');

test('secure random adapter delegates its max-exclusive bound to the crypto boundary', () => {
  const requestedBounds = [];
  const secureRandomInt = createSecureRandomInt((maxExclusive) => {
    requestedBounds.push(maxExclusive);
    return 3;
  });

  assert.equal(secureRandomInt(10), 3);
  assert.deepEqual(requestedBounds, [10]);
});

test('secure random adapter uses node crypto and never Math.random', async () => {
  const source = await readFile(resolve(root, 'apps/server/src/secure-random.ts'), 'utf8');

  assert.match(source, /from 'node:crypto'/);
  assert.doesNotMatch(source, /Math\.random/);
});

test('the server-only hand-start boundary delegates dealing to the crypto random adapter', () => {
  const hand = startServerHand({
    seats: [
      { seatNumber: 1, playerId: 'ada', stack: 100 },
      { seatNumber: 2, playerId: 'ben', stack: 100 },
    ],
    dealerSeat: 1,
    smallBlind: 5,
    bigBlind: 10,
  });

  assert.equal(hand.street, 'preflop');
  assert.equal(hand.seats.filter((seat) => seat.holeCards).length, 2);
});
