import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

import { createApp } from '../apps/server/src/http-app.ts';
import { RoomRepository } from '../apps/server/src/persistence/room-repository.ts';

test('frequent refresh markers read only the room clock and latest sequence', async () => {
  let latestSequence = 7;
  let updatedAt = new Date('2026-10-01T12:00:00.000Z');
  const repository = new RoomRepository({
    room: {
      async findFirst({ select }) {
        assert.deepEqual(select, {
          status: true,
          updatedAt: true,
          snapshots: { select: { sequence: true }, orderBy: { sequence: 'desc' }, take: 1 },
        });
        return { status: 'IN_PROGRESS', updatedAt, snapshots: [{ sequence: latestSequence }] };
      },
    },
  });
  const first = await repository.findGameRefreshTag('room', 'player');
  latestSequence += 1;
  assert.notEqual(await repository.findGameRefreshTag('room', 'player'), first);
  latestSequence -= 1;
  updatedAt = new Date(updatedAt.getTime() + 1);
  assert.notEqual(await repository.findGameRefreshTag('room', 'player'), first);
});

test('unchanged authenticated table reads skip private game recovery and queued action work', async () => {
  const joinId = '0123456789abcdef';
  const token = 'A'.repeat(43);
  let tag = '"poker-first"';
  let sequence = 4;
  let recovered = 0;
  let drained = 0;
  let tagDuringRecovery;
  const app = createApp({ roomRepository: {
    async findPlayerByRoomJoinIdAndAccessToken(requestedJoinId, suppliedToken) {
      return requestedJoinId === joinId && suppliedToken === token ? { id: 'player', roomId: 'room' } : null;
    },
    async findGameRefreshTag() { return tag; },
    async drainPreActionsForRoom() { drained += 1; },
    async recoverLatestPlayerViewForPlayer() {
      recovered += 1;
      if (tagDuringRecovery) { tag = tagDuringRecovery; tagDuringRecovery = undefined; }
      return { sequence };
    },
  } });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/rooms/${joinId}/game`;
    const headers = { cookie: `poker_player_token=${token}` };
    const first = await globalThis.fetch(url, { headers });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('etag'), tag);
    assert.match(first.headers.get('cache-control'), /private, no-store/);
    assert.equal((await first.json()).sequence, 4);

    const unchanged = await globalThis.fetch(url, { headers: { ...headers, 'if-none-match': tag } });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), '');
    assert.equal(recovered, 1);
    assert.equal(drained, 1);

    tag = '"poker-second"';
    sequence = 5;
    const changed = await globalThis.fetch(url, { headers: { ...headers, 'if-none-match': '"poker-first"' } });
    assert.equal(changed.status, 200);
    assert.equal(changed.headers.get('etag'), tag);
    assert.equal((await changed.json()).sequence, 5);
    assert.equal(recovered, 2);
    assert.equal(drained, 2);

    tagDuringRecovery = '"poker-fourth"';
    tag = '"poker-third"';
    const raced = await globalThis.fetch(url, { headers: { ...headers, 'if-none-match': '"poker-second"' } });
    assert.equal(raced.status, 200);
    assert.equal(raced.headers.get('etag'), '"poker-third"');
    await raced.json();
    const afterRace = await globalThis.fetch(url, { headers: { ...headers, 'if-none-match': '"poker-third"' } });
    assert.equal(afterRace.status, 200);
    assert.equal(afterRace.headers.get('etag'), '"poker-fourth"');
    await afterRace.json();

    const unauthenticated = await globalThis.fetch(url, { headers: { 'if-none-match': tag } });
    assert.equal(unauthenticated.status, 401);
    assert.equal(recovered, 4);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('room avatars are a separate authenticated and cacheable roster read', async () => {
  const joinId = '0123456789abcdef';
  const token = 'A'.repeat(43);
  let avatarReads = 0;
  const app = createApp({ roomRepository: {
    async findPlayerByRoomJoinIdAndAccessToken(requestedJoinId, suppliedToken) {
      return requestedJoinId === joinId && suppliedToken === token ? { id: 'player', roomId: 'room' } : null;
    },
    async findRoomAvatarsForPlayer(roomId, playerId) {
      assert.equal(roomId, 'room');
      assert.equal(playerId, 'player');
      avatarReads += 1;
      return [{ id: 'player', avatarDataUrl: 'data:image/png;base64,AA==' }];
    },
  } });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/rooms/${joinId}/avatars?roster=player`;
    const denied = await globalThis.fetch(url);
    assert.equal(denied.status, 401);
    assert.equal(avatarReads, 0);
    const allowed = await globalThis.fetch(url, { headers: { cookie: `poker_player_token=${token}` } });
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers.get('cache-control'), /private, max-age=86400/);
    assert.deepEqual(await allowed.json(), { avatars: [{ id: 'player', avatarDataUrl: 'data:image/png;base64,AA==' }] });
    assert.equal(avatarReads, 1);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
