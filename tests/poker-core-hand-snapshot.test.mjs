import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { test } from 'node:test';

import { serializeStartedHand, startHand } from '../packages/poker-core/src/index.ts';

const seats = [
  { seatNumber: 1, playerId: 'ada', stack: 100 },
  { seatNumber: 2, playerId: 'ben', stack: 100 },
  { seatNumber: 3, playerId: 'cy', stack: 100 },
];
const deterministicRandomInt = () => 0;

test('a private authoritative hand snapshot is JSON-safe without exposing recovery authority', async () => {
  const started = startHand({ seats, dealerSeat: 1, smallBlind: 5, bigBlind: 10, randomInt: deterministicRandomInt });
  const snapshot = serializeStartedHand(started);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  const publicSurface = await import('../packages/poker-core/src/public.ts');
  const serverSurface = await import('../packages/poker-core/src/server.ts');
  assert.equal('startHand' in publicSurface, false, 'browser entry must not deal or expose private hands');
  assert.equal('Deck' in publicSurface, false, 'browser entry must not construct a deck');
  assert.equal('serializeStartedHand' in publicSurface, false);
  assert.equal('hydrateStartedHandForVerifiedServerRecovery' in publicSurface, false);
  assert.equal(typeof serverSurface.startHand, 'function', 'dealing belongs on the explicit server-only entry');
});

test('snapshots can be structurally altered as inert JSON but cannot grant public authority', async () => {
  const started = startHand({ seats, dealerSeat: 1, smallBlind: 5, bigBlind: 10, randomInt: deterministicRandomInt });
  const invalidActor = JSON.parse(JSON.stringify(serializeStartedHand(started)));
  invalidActor.hand.currentActorSeat = 99;
  assert.equal(invalidActor.hand.currentActorSeat, 99);
  const packageManifest = JSON.parse(readFileSync(new URL('../packages/poker-core/package.json', import.meta.url), 'utf8'));
  assert.deepEqual(packageManifest.exports, {
    '.': { development: './src/public.ts', default: './dist/public.js' },
    './server': { development: './src/server.ts', default: './dist/server.js' },
  });
});
