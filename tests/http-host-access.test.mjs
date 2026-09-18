import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

import { createApp } from '../apps/server/src/http-app.ts';

const joinId = '0123456789abcdef';
const hostToken = 'H'.repeat(43);
const guestToken = 'G'.repeat(43);
const targetPlayerId = '018f7b16-690c-4d1f-9d0b-a8c4a14ae001';
const room = {
  id: 'room-db-id',
  joinId,
  hostPlayerId: 'host-id',
  status: 'IN_PROGRESS',
  players: [{ id: 'host-id', displayName: 'מארח' }, { id: 'guest-id', displayName: 'אורח' }],
};

async function withServer(repository, run) {
  const server = createServer(createApp({ roomRepository: repository, isOriginAllowed: () => true }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('the host route API derives authority from the opaque session, not the known host URL', async () => {
  const repository = {
    async findPlayerByRoomJoinIdAndAccessToken(requestedJoinId, token) {
      if (requestedJoinId !== joinId) return null;
      if (token === hostToken) return { id: 'host-id', roomId: room.id };
      if (token === guestToken) return { id: 'guest-id', roomId: room.id };
      return null;
    },
    async findRoomByJoinId() { return room; },
  };

  await withServer(repository, async (baseUrl) => {
    const host = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/host-access`, { headers: { cookie: `poker_player_token=${hostToken}` } });
    assert.equal(host.status, 200);
    assert.deepEqual(await host.json(), { joinId, isHost: true });

    for (const token of [guestToken, 'Z'.repeat(43)]) {
      const response = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/host-access`, { headers: { cookie: `poker_player_token=${token}` } });
      assert.equal(response.status, 403);
    }
  });
});

test('a second authenticated player cannot invoke host-only HTTP controls by calling their URLs directly', async () => {
  const attempted = [];
  const repository = {
    async findPlayerByRoomJoinIdAndAccessToken(requestedJoinId, token) {
      if (requestedJoinId !== joinId || token !== guestToken) return null;
      return { id: 'guest-id', roomId: room.id };
    },
    async findRoomByJoinId() { return room; },
    async startGameForHostAtomically(input) { attempted.push(['start', input]); },
    async startNextHandForHostAtomically(input) { attempted.push(['next-hand', input]); },
    async advanceAllInRunoutForHostAtomically(input) { attempted.push(['runout', input]); },
  };

  await withServer(repository, async (baseUrl) => {
    for (const path of [
      `/rooms/${joinId}/start`,
      `/rooms/${joinId}/game/next-hand`,
      `/rooms/${joinId}/game/final-hand`,
      `/rooms/${joinId}/game/runout/next`,
      `/rooms/${joinId}/players/${targetPlayerId}/remove`,
      `/rooms/${joinId}/management/blinds`,
      `/rooms/${joinId}/management/players/${targetPlayerId}/removal`,
      `/rooms/${joinId}/management/players/${targetPlayerId}/chips`,
      `/rooms/${joinId}/management/transfer-host`,
    ]) {
      const response = await globalThis.fetch(`${baseUrl}${path}`, { method: 'POST', headers: { cookie: `poker_player_token=${guestToken}` } });
      assert.equal(response.status, 403);
    }
    assert.deepEqual(attempted, []);
  });
});

test('a completed-game JSON summary is scoped to an authenticated participant', async () => {
  const summary = { version: 1, room: { joinId }, standings: [], hands: [], events: [] };
  const repository = {
    async findPlayerByRoomJoinIdAndAccessToken(requestedJoinId, token) {
      return requestedJoinId === joinId && token === guestToken ? { id: 'guest-id', roomId: room.id } : null;
    },
    async getFinalSummaryForPlayer(roomId, playerId) {
      assert.deepEqual({ roomId, playerId }, { roomId: room.id, playerId: 'guest-id' });
      return summary;
    },
  };
  await withServer(repository, async (baseUrl) => {
    const unauthenticated = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/final-summary`);
    assert.equal(unauthenticated.status, 401);
    const participant = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/final-summary`, { headers: { cookie: `poker_player_token=${guestToken}` } });
    assert.equal(participant.status, 200);
    assert.deepEqual(await participant.json(), summary);
  });
});

test('the authenticated owner alone can schedule a final hand or a player removal', async () => {
  const calls = [];
  const repository = {
    async findPlayerByRoomJoinIdAndAccessToken(requestedJoinId, token) {
      return requestedJoinId === joinId && token === hostToken ? { id: 'host-id', roomId: room.id } : null;
    },
    async findRoomByJoinId() { return room; },
    async scheduleFinalHandForHost(joinId, hostPlayerId, enabled) { calls.push(['final', { joinId, hostPlayerId, enabled }]); return { nextHandIsFinal: enabled }; },
    async removePlayerBetweenHandsForHostAtomically(input) { calls.push(['remove', input]); },
  };
  await withServer(repository, async (baseUrl) => {
    const finalHand = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/game/final-hand`, { method: 'POST', headers: { cookie: `poker_player_token=${hostToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    assert.equal(finalHand.status, 201);
    const removal = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/players/${targetPlayerId}/remove`, { method: 'POST', headers: { cookie: `poker_player_token=${hostToken}` } });
    assert.equal(removal.status, 201);
  });
  assert.deepEqual(calls, [
    ['final', { joinId, hostPlayerId: 'host-id', enabled: true }],
    ['remove', { joinId, hostPlayerId: 'host-id', targetPlayerId }],
  ]);
});
