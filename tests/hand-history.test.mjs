import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

import { projectHandHistory } from '../apps/server/src/persistence/hand-history.ts';
import { createApp } from '../apps/server/src/http-app.ts';

const card = (rank, suit) => ({ rank, suit });
const result = {
  board: [card('A', 'spades')],
  players: [
    { playerId: 'self', playerName: 'אני', seatNumber: 1, folded: true, holeCards: [card('K', 'hearts'), card('Q', 'hearts')] },
    { playerId: 'showdown-a', playerName: 'שחקן א', seatNumber: 2, folded: false, holeCards: [card('J', 'spades'), card('10', 'spades')] },
    { playerId: 'showdown-b', playerName: 'שחקן ב', seatNumber: 3, folded: false, holeCards: [card('2', 'clubs'), card('3', 'clubs')] },
    { playerId: 'folded', playerName: 'שחקן ג', seatNumber: 4, folded: true, holeCards: [card('A', 'hearts'), card('A', 'diamonds')] },
  ],
  pots: [{ amount: 20, winnerSeatNumbers: [2], payouts: [{ seatNumber: 2, amount: 20 }] }],
  privateDeck: [card('9', 'spades')],
};

test('history reveals own cards and showdown cards, but masks folded opponents unless individually revealed', () => {
  const events = [
    { sequence: 8, type: 'PLAYER_ACTION', payload: { actorPlayerId: 'self', action: { type: 'fold' } }, createdAt: new Date('2026-10-01T00:00:00Z') },
    { sequence: 10, type: 'SHOWDOWN_CARD_REVEALED', payload: { playerId: 'folded', cardIndex: 1 }, createdAt: new Date('2026-10-01T00:00:01Z') },
  ];
  const view = projectHandHistory(result, new Set(['self']), events);
  assert.deepEqual(view.players[0].holeCards, result.players[0].holeCards);
  assert.deepEqual(view.players[1].holeCards, result.players[1].holeCards);
  assert.deepEqual(view.players[2].holeCards, result.players[2].holeCards);
  assert.deepEqual(view.players[3].holeCards, [null, result.players[3].holeCards[1]]);
  assert.equal(JSON.stringify(view).includes('privateDeck'), false);
  assert.equal(view.actions.length, 1);

  const uncontested = projectHandHistory({ ...result, players: [result.players[0], result.players[1], { ...result.players[2], folded: true }] }, new Set(['self']), []);
  assert.deepEqual(uncontested.players[1].holeCards, [null, null]);
});

test('history API requires an account session and uses its account ID for every read', async () => {
  const calls = [];
  const app = createApp({
    accountRepository: { async findIdentityBySession(token) { return token === 'A'.repeat(43) ? { id: 'owner' } : null; } },
    roomRepository: {
      async listGamesForAccount(id) { calls.push(['games', id]); return [{ joinId: 'room' }]; },
      async listHandsForAccount(id, joinId) { calls.push(['hands', id, joinId]); return joinId === 'room' ? { hands: [] } : null; },
      async getHandForAccount(id, joinId, key) { calls.push(['hand', id, joinId, key]); return joinId === 'room' && key === 'hand-2' ? { players: [] } : null; },
    },
  });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}/auth/history`;
    const anonymous = await globalThis.fetch(base);
    assert.equal(anonymous.status, 401);
    const headers = { cookie: `poker_account_token=${'A'.repeat(43)}` };
    assert.equal((await globalThis.fetch(base, { headers })).status, 200);
    assert.equal((await globalThis.fetch(`${base}/room`, { headers })).status, 200);
    assert.equal((await globalThis.fetch(`${base}/room/hands/hand-2`, { headers })).status, 200);
    assert.equal((await globalThis.fetch(`${base}/other/hands/hand-2`, { headers })).status, 404);
    assert.deepEqual(calls, [['games', 'owner'], ['hands', 'owner', 'room'], ['hand', 'owner', 'room', 'hand-2'], ['hand', 'owner', 'other', 'hand-2']]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
