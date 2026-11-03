import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPlayerView } from '../apps/web/app/r/[joinId]/table-client.tsx';
import { createTableRefresh } from '../apps/web/app/table-refresh.ts';
import { ServerGameLifecycle } from '../apps/server/src/game-lifecycle.ts';
import { startHand } from '../packages/poker-core/src/index.ts';
import { signPrivateHandSnapshot, hydrateSignedPrivateHandSnapshot } from '../apps/server/src/persistence/private-hand-snapshot.ts';
import { Buffer } from 'node:buffer';

const card = { rank: 'A', suit: 'spades' };
function settledView() {
  return { playerId: 'hero', sequence: 10, street: 'showdown', dealerSeat: 1, smallBlindSeat: 1, bigBlindSeat: 2,
    bigBlind: 2, currentActorSeat: 1, pot: 999.8, toCall: 0, communityCards: [card, card, card, card, card], holeCards: [card, card],
    seats: [{ playerName: 'Hero', isSittingOut: false }], exposedHands: [],
    showdown: { winners: [{ seatNumber: 1, playerName: 'Hero', chipsWon: 999.8 }],
      pots: [{ amount: 999.8, eligibleSeatNumbers: [1, 2], winnerSeatNumbers: [1], payouts: [{ seatNumber: 1, amount: 999.8 }] }],
      uncalledReturns: [] } };
}

test('table accepts authoritative fractional showdown pots after jackpot contributions', () => {
  assert.equal(isPlayerView(settledView()), true);
  const split = settledView();
  split.showdown.pots[0] = { amount: 0.3, eligibleSeatNumbers: [1, 2], winnerSeatNumbers: [1, 2],
    payouts: [{ seatNumber: 1, amount: 0.1 }, { seatNumber: 2, amount: 0.2 }] };
  assert.equal(isPlayerView(split), true);
});

test('fractional validation still rejects unsupported precision, nonfinite amounts and nonconserving payouts', () => {
  for (const amount of [999.81, -1, Infinity, NaN, '999.8']) {
    const invalid = settledView(); invalid.showdown.pots[0].amount = amount;
    assert.equal(isPlayerView(invalid), false);
  }
  const invalid = settledView(); invalid.showdown.pots[0].payouts[0].amount = 999.7;
  assert.equal(isPlayerView(invalid), false);
});

test('real signed tenths-chip all-in settles, passes the browser guard for both players, and is not mistaken for a pending runout', () => {
  const seats = [{ seatNumber: 1, playerId: 'a', playerName: 'א', stack: 4999 },
    { seatNumber: 2, playerId: 'b', playerName: 'ב', stack: 4999 }];
  const hand = startHand({ seats, dealerSeat: 1, smallBlind: 10, bigBlind: 20, randomInt: () => 0 });
  const key = Buffer.from('private test key for a signed fractional hand');
  const context = { roomId: 'room', sequence: 0, keyId: 'test', chipScale: 10 };
  const signed = signPrivateHandSnapshot(hand, context, key);
  const verified = hydrateSignedPrivateHandSnapshot(signed, context, new Map([['test', key]]));
  const game = ServerGameLifecycle.fromVerifiedRecoveredHand({ seats, dealerSeat: 1, smallBlind: 10, bigBlind: 20 }, verified);
  game.applyAction('a', { type: 'all-in' });
  game.applyAction('b', { type: 'call' });
  for (let stage = 0; stage < 4; stage++) game.advanceAllInRunout();
  for (const player of seats) {
    const result = game.viewFor(player.playerId);
    assert.equal(result.street, 'showdown'); assert.equal(result.allInRunout, undefined);
    assert.equal(result.showdown.pots.reduce((total, pot) => total + pot.amount, 0), 999.8);
    assert.equal(isPlayerView({ ...result, seats: result.seats.map((seat) => ({ ...seat, isSittingOut: false })) }), true);
  }
});

function transport(fetcher, overrides = {}) {
  const events = [];
  let sequence = -1;
  const refresh = createTableRefresh({ url: '/server/rooms/existing/game', fetcher, validate: isPlayerView,
    currentSequence: () => sequence,
    onView: (view) => { sequence = view.sequence; events.push(['view', view.sequence]); },
    onUnchanged: () => events.push(['connected']), onUnauthorized: () => events.push(['unauthorized']),
    onWaiting: () => events.push(['waiting']), onError: (kind) => events.push(['error', kind]), ...overrides });
  return { ...refresh, events };
}
const response = (value, status = 200, tag = '"same"') => new globalThis.Response(status === 304 ? null : JSON.stringify(value), { status, headers: { etag: tag } });

test('a failed refresh followed by 304 restores connected state without downloading the hand again', async () => {
  let calls = 0;
  const live = transport(async (url, options) => {
    assert.equal(url, '/server/rooms/existing/game'); assert.equal(options.credentials, 'include');
    calls++;
    if (calls === 1) return response(settledView());
    assert.equal(options.headers['If-None-Match'], '"same"');
    if (calls === 2) throw new Error('temporary network loss');
    return response(null, 304);
  });
  try {
    await live.refresh(); await live.refresh(); await live.refresh();
    assert.deepEqual(live.events, [['view', 10], ['error', 'NETWORK'], ['connected']]);
  } finally { live.dispose(); }
});

test('a hung refresh times out, coalesces duplicate reads, and allows the next authoritative state', async () => {
  let calls = 0;
  const live = transport(async (_url, options) => {
    if (++calls === 1) return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return response(settledView());
  }, { timeoutMs: 15 });
  try {
    const first = live.refresh();
    assert.equal(live.refresh(), first);
    await first; await live.refresh();
    assert.equal(calls, 2);
    assert.deepEqual(live.events, [['error', 'NETWORK'], ['view', 10]]);
  } finally { live.dispose(); }
});

test('background disposal suppresses late callbacks; invalid state and expired auth never create or join a player', async () => {
  let release;
  const disposed = transport(async () => new Promise((resolve) => { release = resolve; }));
  const pending = disposed.refresh(); disposed.dispose(); release(response(settledView())); await pending;
  assert.deepEqual(disposed.events, []);
  let calls = 0;
  const live = transport(async () => ++calls === 1 ? response({ unrelated: true }) : response({}, 401));
  try {
    await live.refresh(); await live.refresh();
    assert.deepEqual(live.events, [['error', 'INVALID_STATE'], ['unauthorized']]);
  } finally { live.dispose(); }
});
