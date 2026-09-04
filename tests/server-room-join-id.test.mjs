import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { createRoomJoinId } from '../apps/server/src/persistence/room-join-id.ts';

test('room join IDs are opaque random hexadecimal identifiers', () => {
  const joinId = createRoomJoinId(() => Buffer.from('0011223344556677', 'hex'));

  assert.equal(joinId, '0011223344556677');
  assert.match(joinId, /^[a-f0-9]{16}$/);
});
