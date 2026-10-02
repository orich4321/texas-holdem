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

async function withServer(repository, run, extras = {}) {
  const server = createServer(createApp({ roomRepository: repository, isOriginAllowed: () => true, ...extras }));
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

test('the project owner can reclaim only the explicitly approved incident room from their verified account', async () => {
  const incidentJoinId = '5347f61f0f84b694';
  const ownerToken = 'O'.repeat(43);
  const calls = [];
  const repository = {
    async recoverHostForAccount(joinId, accountId) { calls.push({ joinId, accountId }); return { hostPlayerId: 'ori-seat' }; },
  };
  const accountRepository = {
    async findBySession(token) {
      if (token === ownerToken) return { id: 'ori-account', username: 'orich4321', displayName: 'אורי', avatarDataUrl: null };
      if (token === guestToken) return { id: 'guest-account', username: 'guest', displayName: 'אורח', avatarDataUrl: null };
      return null;
    },
  };
  await withServer(repository, async (baseUrl) => {
    const owner = await globalThis.fetch(`${baseUrl}/rooms/${incidentJoinId}/owner-recovery`, { method: 'POST', headers: { cookie: `poker_account_token=${ownerToken}` } });
    assert.equal(owner.status, 201);
    assert.deepEqual(await owner.json(), { hostPlayerId: 'ori-seat' });
    for (const [path, token] of [[joinId, ownerToken], [incidentJoinId, guestToken], [incidentJoinId, undefined]]) {
      const response = await globalThis.fetch(`${baseUrl}/rooms/${path}/owner-recovery`, { method: 'POST', headers: token ? { cookie: `poker_account_token=${token}` } : {} });
      assert.equal(response.status, 403);
    }
  }, { accountRepository });
  assert.deepEqual(calls, [{ joinId: incidentJoinId, accountId: 'ori-account' }]);
});

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
    async advanceRabbitRunoutForHostAtomically(input) { attempted.push(['rabbit-runout', input]); },
  };

  await withServer(repository, async (baseUrl) => {
    for (const path of [
      `/rooms/${joinId}/start`,
      `/rooms/${joinId}/game/next-hand`,
      `/rooms/${joinId}/game/continue`,
      `/rooms/${joinId}/game/final-hand`,
      `/rooms/${joinId}/game/final-summary/reveal`,
      `/rooms/${joinId}/game/finish`,
      `/rooms/${joinId}/game/runout/next`,
      `/rooms/${joinId}/game/runout/uncontested`,
      `/rooms/${joinId}/players/${targetPlayerId}/remove`,
      `/rooms/${joinId}/lobby/players/${targetPlayerId}/remove`,
      `/rooms/${joinId}/lobby/players/${targetPlayerId}/restore`,
      `/rooms/${joinId}/management/blinds`,
      `/rooms/${joinId}/management/players/${targetPlayerId}/removal`,
      `/rooms/${joinId}/management/players/${targetPlayerId}/chips`,
      `/rooms/${joinId}/management/players/${targetPlayerId}/rebuy/decline`,
      `/rooms/${joinId}/management/transfer-host`,
    ]) {
      const response = await globalThis.fetch(`${baseUrl}${path}`, { method: 'POST', headers: { cookie: `poker_player_token=${guestToken}` } });
      assert.equal(response.status, 403);
    }
    assert.deepEqual(attempted, []);
  });
});

test('waiting-room removal resolves the host from their session and rejects invalid targets', async () => {
  const calls = [];
  const repository = {
    async findPlayerByRoomJoinIdAndAccessToken(requestedJoinId, token) {
      return requestedJoinId === joinId && token === hostToken ? { id: 'host-id', roomId: room.id } : null;
    },
    async findRoomByJoinId() { return room; },
    async removeWaitingPlayerForHostAtomically(input) { calls.push(input); return { removedPlayerId: input.targetPlayerId }; },
  };
  await withServer(repository, async (baseUrl) => {
    const path = `/rooms/${joinId}/lobby/players/${targetPlayerId}/remove`;
    const forbidden = await globalThis.fetch(`${baseUrl}${path}`, { method: 'POST', headers: { cookie: `poker_player_token=${guestToken}` } });
    assert.equal(forbidden.status, 403);
    const invalid = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/lobby/players/not-a-uuid/remove`, { method: 'POST', headers: { cookie: `poker_player_token=${hostToken}` } });
    assert.equal(invalid.status, 400);
    const removed = await globalThis.fetch(`${baseUrl}${path}`, { method: 'POST', headers: { cookie: `poker_player_token=${hostToken}` } });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { removedPlayerId: targetPlayerId });
  });
  assert.deepEqual(calls, [{ joinId, hostPlayerId: 'host-id', targetPlayerId }]);
});

test('only the host can list and restore removed waiting-room seats', async () => {
  const calls = [];
  const repository = {
    async findPlayerByRoomJoinIdAndAccessToken(requestedJoinId, token) {
      if (requestedJoinId !== joinId) return null;
      if (token === hostToken) return { id: 'host-id', roomId: room.id };
      if (token === guestToken) return { id: 'guest-id', roomId: room.id };
      return null;
    },
    async findRoomByJoinId() { return room; },
    async listRemovedWaitingPlayersForHost(requestedJoinId, hostId) {
      calls.push(['list', requestedJoinId, hostId]);
      return [{ id: targetPlayerId, displayName: 'אורח' }];
    },
    async restoreWaitingPlayerForHostAtomically(input) {
      calls.push(['restore', input]);
      return { restoredPlayerId: input.targetPlayerId };
    },
  };
  await withServer(repository, async (baseUrl) => {
    const listUrl = `${baseUrl}/rooms/${joinId}/lobby/removed-players`;
    const restoreUrl = `${baseUrl}/rooms/${joinId}/lobby/players/${targetPlayerId}/restore`;
    assert.equal((await globalThis.fetch(listUrl, { headers: { cookie: `poker_player_token=${guestToken}` } })).status, 403);
    assert.equal((await globalThis.fetch(restoreUrl, { method: 'POST', headers: { cookie: `poker_player_token=${guestToken}` } })).status, 403);
    const listed = await globalThis.fetch(listUrl, { headers: { cookie: `poker_player_token=${hostToken}` } });
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), { players: [{ id: targetPlayerId, displayName: 'אורח' }] });
    const restored = await globalThis.fetch(restoreUrl, { method: 'POST', headers: { cookie: `poker_player_token=${hostToken}` } });
    assert.equal(restored.status, 200);
    assert.deepEqual(await restored.json(), { restoredPlayerId: targetPlayerId });
  });
  assert.deepEqual(calls, [
    ['list', joinId, 'host-id'],
    ['restore', { joinId, hostPlayerId: 'host-id', targetPlayerId }],
  ]);
});

test('participants see final standings, but only the authenticated host can download the detailed JSON', async () => {
  const summary = { version: 3, room: { joinId }, standings: [{ displayName: 'אורח', initialStack: 500, finalStack: 700, net: 200 }], hands: [{ hand: 'private-hand' }], events: [{ payload: { holeCards: ['private-card'] } }] };
  const repository = {
    async findPlayerByRoomJoinIdAndAccessToken(requestedJoinId, token) {
      if (requestedJoinId !== joinId) return null;
      if (token === guestToken) return { id: 'guest-id', roomId: room.id };
      if (token === hostToken) return { id: 'host-id', roomId: room.id };
      return null;
    },
    async findRoomByJoinId() { return room; },
    async getFinalSummaryForPlayer(roomId, playerId) {
      assert.equal(roomId, room.id);
      assert.ok(['guest-id', 'host-id'].includes(playerId));
      return summary;
    },
  };
  await withServer(repository, async (baseUrl) => {
    const unauthenticated = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/final-summary`);
    assert.equal(unauthenticated.status, 401);
    const unauthenticatedDownload = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/final-summary/download`);
    assert.equal(unauthenticatedDownload.status, 403);
    const participant = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/final-summary`, { headers: { cookie: `poker_player_token=${guestToken}` } });
    assert.equal(participant.status, 200);
    assert.deepEqual(await participant.json(), { version: 3, room: summary.room, standings: summary.standings, handCount: 1 });
    const guestDownload = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/final-summary/download`, { headers: { cookie: `poker_player_token=${guestToken}` } });
    assert.equal(guestDownload.status, 403);
    const hostDownload = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/final-summary/download`, { headers: { cookie: `poker_player_token=${hostToken}` } });
    assert.equal(hostDownload.status, 200);
    assert.match(hostDownload.headers.get('content-disposition'), /attachment/);
    assert.deepEqual(await hostDownload.json(), summary);
  });
});

test('the authenticated owner alone can schedule a final hand, reveal its summary, finish, or remove a player', async () => {
  const calls = [];
  const repository = {
    async findPlayerByRoomJoinIdAndAccessToken(requestedJoinId, token) {
      return requestedJoinId === joinId && token === hostToken ? { id: 'host-id', roomId: room.id } : null;
    },
    async findRoomByJoinId() { return room; },
    async scheduleFinalHandForHost(joinId, hostPlayerId, enabled) { calls.push(['final', { joinId, hostPlayerId, enabled }]); return { nextHandIsFinal: enabled }; },
    async revealFinalSummaryForHost(joinId, hostPlayerId) { calls.push(['summary', { joinId, hostPlayerId }]); return { finalSummaryVisible: true }; },
    async closeRoomForHost(joinId, hostPlayerId) { calls.push(['finish', { joinId, hostPlayerId }]); return { status: 'COMPLETED', finalSummaryVisible: true, abandonedHand: false }; },
    async removePlayerBetweenHandsForHostAtomically(input) { calls.push(['remove', input]); },
  };
  await withServer(repository, async (baseUrl) => {
    const finalHand = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/game/final-hand`, { method: 'POST', headers: { cookie: `poker_player_token=${hostToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    assert.equal(finalHand.status, 201);
    const summary = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/game/final-summary/reveal`, { method: 'POST', headers: { cookie: `poker_player_token=${hostToken}` } });
    assert.equal(summary.status, 201);
    assert.deepEqual(await summary.json(), { finalSummaryVisible: true });
    const finish = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/game/finish`, { method: 'POST', headers: { cookie: `poker_player_token=${hostToken}` } });
    assert.equal(finish.status, 200);
    assert.deepEqual(await finish.json(), { status: 'COMPLETED', finalSummaryVisible: true, abandonedHand: false });
    const removal = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/players/${targetPlayerId}/remove`, { method: 'POST', headers: { cookie: `poker_player_token=${hostToken}` } });
    assert.equal(removal.status, 201);
  });
  assert.deepEqual(calls, [
    ['final', { joinId, hostPlayerId: 'host-id', enabled: true }],
    ['summary', { joinId, hostPlayerId: 'host-id' }],
    ['finish', { joinId, hostPlayerId: 'host-id' }],
    ['remove', { joinId, hostPlayerId: 'host-id', targetPlayerId }],
  ]);
});

test('all-in and rabbit runouts return the updated host view immediately, and turn tools use the authenticated player', async () => {
  const calls = [];
  const updatedView = { playerId: 'host-id', street: 'showdown', communityCards: [{ rank: 'A', suit: 'spades' }] };
  const repository = {
    async findPlayerByRoomJoinIdAndAccessToken(requestedJoinId, token) {
      if (requestedJoinId !== joinId || token !== hostToken) return null;
      return { id: 'host-id', roomId: room.id };
    },
    async findRoomByJoinId() { return room; },
    async advanceAllInRunoutForHostAtomically(input) { calls.push(['all-in', input]); return { views: [updatedView] }; },
    async advanceRabbitRunoutForHostAtomically(input) { calls.push(['rabbit', input]); return { views: [updatedView] }; },
    async useTimeCardAtomically(roomId, playerId) { calls.push(['card', { roomId, playerId }]); return { ...updatedView, timeCardsRemaining: 2 }; },
    async expireTurnForParticipant(roomId, playerId) { calls.push(['expire', { roomId, playerId }]); return null; },
  };
  await withServer(repository, async (baseUrl) => {
    const headers = { cookie: `poker_player_token=${hostToken}` };
    const allIn = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/game/runout/next`, { method: 'POST', headers });
    assert.equal(allIn.status, 201);
    assert.deepEqual(await allIn.json(), updatedView);
    const rabbit = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/game/runout/uncontested`, { method: 'POST', headers });
    assert.equal(rabbit.status, 201);
    assert.deepEqual(await rabbit.json(), updatedView);
    const card = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/game/turn/time-card`, { method: 'POST', headers });
    assert.equal(card.status, 201);
    assert.equal((await card.json()).timeCardsRemaining, 2);
    const expiry = await globalThis.fetch(`${baseUrl}/rooms/${joinId}/game/turn/expire`, { method: 'POST', headers });
    assert.equal(expiry.status, 200);
    assert.deepEqual(await expiry.json(), { expired: false });
  });
  assert.deepEqual(calls, [
    ['all-in', { joinId, hostPlayerId: 'host-id' }],
    ['rabbit', { joinId, hostPlayerId: 'host-id' }],
    ['card', { roomId: room.id, playerId: 'host-id' }],
    ['expire', { roomId: room.id, playerId: 'host-id' }],
  ]);
});

test('only the host can continue a completed game and must explicitly choose whether the next hand is final', async () => {
  const calls = [];
  const repository = {
    async findPlayerByRoomJoinIdAndAccessToken(requestedJoinId, token) {
      if (requestedJoinId !== joinId) return null;
      if (token === hostToken) return { id: 'host-id', roomId: room.id };
      if (token === guestToken) return { id: 'guest-id', roomId: room.id };
      return null;
    },
    async findRoomByJoinId() { return room; },
    async startNextHandForHostAtomically(input) { calls.push(input); return { finalHand: input.finalHand }; },
  };
  await withServer(repository, async (baseUrl) => {
    const path = `${baseUrl}/rooms/${joinId}/game/continue`;
    const guest = await globalThis.fetch(path, { method: 'POST', headers: { cookie: `poker_player_token=${guestToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ finalHand: true }) });
    assert.equal(guest.status, 403);
    const missingChoice = await globalThis.fetch(path, { method: 'POST', headers: { cookie: `poker_player_token=${hostToken}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(missingChoice.status, 400);
    const host = await globalThis.fetch(path, { method: 'POST', headers: { cookie: `poker_player_token=${hostToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ finalHand: false }) });
    assert.equal(host.status, 201);
    assert.deepEqual(await host.json(), { roomId: joinId, status: 'IN_PROGRESS', finalHand: false });
  });
  assert.deepEqual(calls, [{ joinId, hostPlayerId: 'host-id', finalHand: false }]);
});
