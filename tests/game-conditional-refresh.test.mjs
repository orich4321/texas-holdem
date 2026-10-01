import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

import { createApp } from '../apps/server/src/http-app.ts';

test('unchanged authenticated table reads skip private game recovery and queued action work', async () => {
  const joinId = '0123456789abcdef';
  const token = 'A'.repeat(43);
  let tag = '"poker-first"';
  let sequence = 4;
  let recovered = 0;
  let drained = 0;
  const app = createApp({ roomRepository: {
    async findPlayerByRoomJoinIdAndAccessToken(requestedJoinId, suppliedToken) {
      return requestedJoinId === joinId && suppliedToken === token ? { id: 'player', roomId: 'room' } : null;
    },
    async findGameRefreshTag() { return tag; },
    async drainPreActionsForRoom() { drained += 1; },
    async recoverLatestPlayerViewForPlayer() { recovered += 1; return { sequence }; },
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

    const unauthenticated = await globalThis.fetch(url, { headers: { 'if-none-match': tag } });
    assert.equal(unauthenticated.status, 401);
    assert.equal(recovered, 2);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
