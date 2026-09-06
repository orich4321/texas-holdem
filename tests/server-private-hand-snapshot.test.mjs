import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { startHand } from '../packages/poker-core/src/index.ts';
import { hydrateSignedPrivateHandSnapshot, signPrivateHandSnapshot } from '../apps/server/src/persistence/private-hand-snapshot.ts';
import { createPrivateSnapshotKeyring } from '../apps/server/src/persistence/private-snapshot-keyring.ts';

const key = Buffer.from('a server-only snapshot signing key with adequate length', 'utf8');
const context = { roomId: 'room-db-id', sequence: 0, keyId: 'test-current' };
const keyring = new Map([[context.keyId, key]]);
const seats = [{ seatNumber: 1, playerId: 'ada', stack: 100 }, { seatNumber: 2, playerId: 'ben', stack: 100 }, { seatNumber: 3, playerId: 'cy', stack: 100 }];
const newHand = () => startHand({ seats, dealerSeat: 1, smallBlind: 5, bigBlind: 10, randomInt: () => 0 });

test('server private envelope authenticates a context-bound JSON round-trip before restoring authority', () => {
  const signed = signPrivateHandSnapshot(newHand(), context, key);
  const restored = hydrateSignedPrivateHandSnapshot(JSON.parse(JSON.stringify(signed)), context, keyring);
  assert.equal(restored.hand.street, 'preflop');
  assert.equal(restored.hand.remainingDeck.length, 46);
});

test('server private envelope rejects snapshot tampering, wrong room/sequence, and unknown keys before hydration', () => {
  const signed = JSON.parse(JSON.stringify(signPrivateHandSnapshot(newHand(), context, key)));
  signed.snapshot.hand.seats[0].stack = 999999;
  assert.throws(() => hydrateSignedPrivateHandSnapshot(signed, context, keyring), /invalid signed/i);
  const valid = signPrivateHandSnapshot(newHand(), context, key);
  assert.throws(() => hydrateSignedPrivateHandSnapshot(valid, { roomId: 'other-room', sequence: 0 }, keyring), /invalid signed/i);
  assert.throws(() => hydrateSignedPrivateHandSnapshot(valid, { roomId: context.roomId, sequence: 1 }, keyring), /invalid signed/i);
  assert.throws(() => hydrateSignedPrivateHandSnapshot(valid, context, new Map()), /invalid signed/i);
});

test('snapshot signature is recursively canonical for object keys but binds array order and requires byte keys', () => {
  const signed = JSON.parse(JSON.stringify(signPrivateHandSnapshot(newHand(), context, key)));
  const reordered = { signature: signed.signature, snapshot: { hand: { ...signed.snapshot.hand, seats: [...signed.snapshot.hand.seats] }, version: 1 }, sequence: 0, roomId: context.roomId, keyId: context.keyId, version: 1 };
  assert.equal(hydrateSignedPrivateHandSnapshot(reordered, context, keyring).hand.street, 'preflop');
  const arrayTamper = JSON.parse(JSON.stringify(signed));
  [arrayTamper.snapshot.hand.remainingDeck[0], arrayTamper.snapshot.hand.remainingDeck[1]] = [arrayTamper.snapshot.hand.remainingDeck[1], arrayTamper.snapshot.hand.remainingDeck[0]];
  assert.throws(() => hydrateSignedPrivateHandSnapshot(arrayTamper, context, keyring), /invalid signed/i);
  assert.throws(() => signPrivateHandSnapshot(newHand(), context, key.toString('utf8')), /key/i);
});

test('server snapshot keyring accepts only an explicit current 32-byte base64 key', () => {
  const encoded = key.toString('base64');
  const keyring = createPrivateSnapshotKeyring({ PRIVATE_SNAPSHOT_KEY_ID: 'current-2026', PRIVATE_SNAPSHOT_KEY_BASE64: encoded });
  assert.deepEqual(keyring, new Map([['current-2026', key]]));
  assert.throws(() => createPrivateSnapshotKeyring({ PRIVATE_SNAPSHOT_KEY_BASE64: encoded }), /key ID/i);
  assert.throws(() => createPrivateSnapshotKeyring({ PRIVATE_SNAPSHOT_KEY_ID: 'current-2026', PRIVATE_SNAPSHOT_KEY_BASE64: 'not base64 !!!' }), /base64/i);
  assert.throws(() => createPrivateSnapshotKeyring({ PRIVATE_SNAPSHOT_KEY_ID: 'current-2026', PRIVATE_SNAPSHOT_KEY_BASE64: Buffer.alloc(31).toString('base64') }), /32 bytes/i);
});
