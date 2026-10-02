import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

import { projectHandHistory, projectHandReplay } from '../apps/server/src/persistence/hand-history.ts';
import { buildGameRecap } from '../apps/server/src/persistence/game-recap.ts';
import { RoomRepository } from '../apps/server/src/persistence/room-repository.ts';
import { signPrivateHandSnapshot } from '../apps/server/src/persistence/private-hand-snapshot.ts';
import { applyPreflopFold, finishUncontestedHand, startHand } from '../packages/poker-core/src/index.ts';
import { createApp } from '../apps/server/src/http-app.ts';

const card = (rank, suit) => ({ rank, suit });
const result = {
  board: [card('A', 'spades')],
  players: [
    { playerId: 'self', playerName: 'אני', seatNumber: 1, folded: true, holeCards: [card('K', 'hearts'), card('Q', 'hearts')] },
    { playerId: 'showdown-a', playerName: 'שחקן א', seatNumber: 2, holeCards: [card('J', 'spades'), card('10', 'spades')] },
    { playerId: 'showdown-b', playerName: 'שחקן ב', seatNumber: 3, holeCards: [card('2', 'clubs'), card('3', 'clubs')] },
    { playerId: 'folded', playerName: 'שחקן ג', seatNumber: 4, folded: true, holeCards: [card('A', 'hearts'), card('A', 'diamonds')] },
  ],
  pots: [{ amount: 20, winnerSeatNumbers: [2], payouts: [{ seatNumber: 2, amount: 20 }] }],
  privateDeck: [card('9', 'spades')],
};

test('history reveals showdown cards even when folded=false was omitted, but masks unrevealed folded cards', () => {
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

test('replay opens the board in order but shows every eventually public hole card from the deal', () => {
  const finished = { ...result, board: [card('A', 'spades'), card('2', 'diamonds'), card('7', 'clubs')],
    stacks: [{ playerId: 'self', stack: 90 }, { playerId: 'showdown-a', stack: 110 }, { playerId: 'showdown-b', stack: 80 }, { playerId: 'folded', stack: 100 }] };
  const events = [
    { sequence: 0, type: 'GAME_STARTED', payload: {}, createdAt: new Date() },
    { sequence: 1, type: 'PLAYER_ACTION', payload: { actorPlayerId: 'self', action: { type: 'check' } }, createdAt: new Date() },
    { sequence: 2, type: 'PLAYER_ACTION', payload: { actorPlayerId: 'showdown-a', action: { type: 'check' } }, createdAt: new Date() },
    { sequence: 3, type: 'SHOWDOWN_CARD_REVEALED', payload: { playerId: 'folded', cardIndex: 1 }, createdAt: new Date() },
  ];
  const seats = [
    { playerId: 'self', seatNumber: 1, stack: 90, currentBet: 0, totalCommitted: 10, isFolded: true },
    { playerId: 'showdown-a', seatNumber: 2, stack: 90, currentBet: 0, totalCommitted: 10, isFolded: false },
    { playerId: 'showdown-b', seatNumber: 3, stack: 80, currentBet: 0, totalCommitted: 20, isFolded: false },
    { playerId: 'folded', seatNumber: 4, stack: 100, currentBet: 0, totalCommitted: 0, isFolded: true },
  ];
  const frame = (sequence, street, board, reveals = []) => ({ sequence, street, board, pot: 40, seats,
    allInCardsPublic: false, reveals });
  const replay = projectHandReplay(finished, new Set(['self']), events, [
    frame(0, 'preflop', []), frame(1, 'preflop', []), frame(2, 'showdown', finished.board),
    frame(3, 'showdown', finished.board, [{ playerId: 'folded', cardIndexes: [1] }]),
  ]);
  assert.deepEqual(replay.map((step) => step.kind), ['deal', 'action', 'action', 'showdown', 'result', 'reveal']);
  assert.equal(replay[2].board.length, 0);
  assert.equal(replay[3].board.length, 3);
  assert.deepEqual(replay[0].players[1].holeCards, finished.players[1].holeCards);
  assert.deepEqual(replay[0].players[2].holeCards, finished.players[2].holeCards);
  assert.deepEqual(replay[0].players[3].holeCards, [null, finished.players[3].holeCards[1]]);
  assert.deepEqual(replay[4].players[1].holeCards, finished.players[1].holeCards);
  assert.deepEqual(replay[4].players[3].holeCards, [null, finished.players[3].holeCards[1]]);
  assert.deepEqual(replay[5].players[3].holeCards, [null, finished.players[3].holeCards[1]]);
  assert.equal(replay[4].pot, 0);
  assert.equal(replay[4].players[1].stack, 110);
  assert.equal(JSON.stringify(replay).includes('privateDeck'), false);

  const allIn = projectHandReplay(finished, new Set(['self']), events.slice(0, 2), [
    frame(0, 'preflop', []), { ...frame(1, 'preflop', []), allInCardsPublic: true },
  ]);
  assert.deepEqual(allIn[0].players[1].holeCards, finished.players[1].holeCards);
  assert.deepEqual(allIn[1].players[1].holeCards, finished.players[1].holeCards);
  assert.deepEqual(allIn[1].players[3].holeCards, [null, null]);

  const uncontested = { ...finished, players: [finished.players[0], finished.players[1], { ...finished.players[2], folded: true }, finished.players[3]] };
  const privateReplay = projectHandReplay(uncontested, new Set(['self']), events.slice(0, 2), [frame(0, 'preflop', [])]);
  assert.deepEqual(privateReplay[0].players[0].holeCards, finished.players[0].holeCards);
  assert.deepEqual(privateReplay[0].players[1].holeCards, [null, null]);
  assert.deepEqual(privateReplay[0].players[2].holeCards, [null, null]);
  assert.deepEqual(privateReplay[0].players[3].holeCards, [null, null]);
});

test('evening recap counts seated hands and split-pot winners without double-counting a hand', () => {
  const recap = buildGameRecap([
    { result: { players: [{ playerId: 'a', seatNumber: 1, holeCards: [card('A', 'spades'), card('K', 'spades')] },
      { playerId: 'b', seatNumber: 2, holeCards: [card('Q', 'clubs'), card('J', 'clubs')] }],
    pots: [{ amount: 60, payouts: [{ seatNumber: 1, amount: 30 }, { seatNumber: 2, amount: 30 }] },
      { amount: 20, payouts: [{ seatNumber: 1, amount: 20 }] }] } },
    { result: { players: [{ playerId: 'a', seatNumber: 1, holeCards: [card('2', 'spades'), card('3', 'spades')] }],
      pots: [{ amount: 10, payouts: [{ seatNumber: 1, amount: 10 }] }] } },
  ], ['a', 'b', 'spectator']);
  assert.deepEqual(recap.largestPot, { handNumber: 1, amount: 80 });
  assert.deepEqual(recap.biggestWin, { handNumber: 1, playerId: 'a', amount: 50 });
  assert.deepEqual(recap.playerStats, [
    { playerId: 'a', handsPlayed: 2, handsWon: 2 },
    { playerId: 'b', handsPlayed: 1, handsWon: 1 },
    { playerId: 'spectator', handsPlayed: 0, handsWon: 0 },
  ]);
});

test('account history reads verified snapshots but returns only the account-visible replay', async () => {
  const roomId = 'history-room';
  const keyId = 'history-test';
  const key = Buffer.from('a private signing key long enough for historical replay');
  const initial = startHand({ seats: [{ seatNumber: 1, playerId: 'self', stack: 100 }, { seatNumber: 2, playerId: 'other', stack: 100 }],
    dealerSeat: 1, smallBlind: 1, bigBlind: 2, randomInt: () => 0 });
  const ended = finishUncontestedHand(applyPreflopFold(initial, 1));
  const eventTime = new Date('2026-10-01T00:00:00Z');
  const stored = { board: [], players: ended.seats.map((seat) => ({ playerId: seat.playerId,
    playerName: seat.playerId, seatNumber: seat.seatNumber, folded: seat.isFolded === true, holeCards: seat.holeCards })),
    pots: [{ amount: 3, payouts: [{ seatNumber: 2, amount: 3 }] }],
    stacks: [{ playerId: 'self', stack: 99 }, { playerId: 'other', stack: 101 }] };
  const db = {
    room: { findFirst: async () => ({ id: roomId, players: [{ id: 'self' }], settlements: [{ result: stored, createdAt: eventTime }] }) },
    gameEvent: { findFirst: async ({ where }) => where.sequence?.lte !== undefined ? { sequence: 0 } : null,
      findMany: async () => [
        { sequence: 0, type: 'GAME_STARTED', payload: {}, createdAt: eventTime },
        { sequence: 1, type: 'PLAYER_ACTION', payload: { actorPlayerId: 'self', action: { type: 'fold' } }, createdAt: eventTime },
      ] },
    gameSnapshot: { findMany: async () => [
      { sequence: 0, state: signPrivateHandSnapshot(initial, { roomId, sequence: 0, keyId }, key) },
      { sequence: 1, state: signPrivateHandSnapshot(ended, { roomId, sequence: 1, keyId }, key) },
    ] },
  };
  const history = await new RoomRepository(db, undefined, undefined, undefined, new Map([[keyId, key]]))
    .getHandForAccount('account-self', '0123456789abcdef', 'hand-0');
  assert.deepEqual(history.replay.map((step) => step.kind), ['deal', 'action', 'result']);
  assert.deepEqual(history.replay[0].players.find((seat) => seat.playerId === 'other').holeCards, [null, null]);
  assert.deepEqual(history.replay[2].players.find((seat) => seat.playerId === 'other').holeCards, [null, null]);
  assert.equal(JSON.stringify(history).includes('remainingDeck'), false);
  assert.equal(JSON.stringify(history).includes('signature'), false);
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

test('active games include only current memberships and preserve the current host route', async () => {
  let query;
  const db = { room: { async findMany(args) {
    query = args;
    return [
      { joinId: 'room-a', status: 'IN_PROGRESS', hostPlayerId: 'player-a', players: [{ id: 'player-a' }], _count: { settlements: 28 } },
      { joinId: 'room-b', status: 'WAITING', hostPlayerId: 'other', players: [{ id: 'player-b' }], _count: { settlements: 0 } },
    ];
  } } };
  const games = await new RoomRepository(db).listActiveGamesForAccount('account-self');
  assert.deepEqual(query.where, {
    status: { in: ['WAITING', 'IN_PROGRESS'] },
    players: { some: { accountId: 'account-self', leftAt: null } },
  });
  assert.deepEqual(query.select.players, { where: { accountId: 'account-self', leftAt: null }, select: { id: true } });
  assert.deepEqual(games, [
    { joinId: 'room-a', status: 'IN_PROGRESS', handCount: 28, isHost: true },
    { joinId: 'room-b', status: 'WAITING', handCount: 0, isHost: false },
  ]);
});

test('active game list requires account authentication and returns only account-scoped rooms', async () => {
  const calls = [];
  const app = createApp({
    accountRepository: { async findIdentityBySession(token) { return token === 'A'.repeat(43) ? { id: 'account-self' } : null; } },
    roomRepository: { async listActiveGamesForAccount(id) { calls.push(id); return [{ joinId: 'room-a', isHost: true }]; } },
  });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${server.address().port}/auth/active-games`;
    assert.equal((await globalThis.fetch(url)).status, 401);
    const response = await globalThis.fetch(url, { headers: { cookie: `poker_account_token=${'A'.repeat(43)}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual((await response.json()).games, [{ joinId: 'room-a', isHost: true }]);
    assert.deepEqual(calls, ['account-self']);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
