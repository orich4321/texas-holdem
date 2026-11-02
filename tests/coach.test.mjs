import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { buildAuthorizedCoachHand, decisionPayload, positionFor } from '../apps/server/src/coach/authorized-data.ts';
import { publicCoachCache } from '../apps/server/src/coach/public-cache.ts';
import { calculateStatistics } from '../apps/server/src/coach/statistics.ts';
import { buildFinalReport, calculateScores, validateBatch, validateNarrative } from '../apps/server/src/coach/analysis.ts';
import { coachConfiguration } from '../apps/server/src/coach/gemini.ts';
import { retryDelay } from '../apps/server/src/coach/service.ts';
import { createApp } from '../apps/server/src/http-app.ts';
import { hand, action, decision, evaluation, narrative } from './fixtures/coach.mjs';

const metric = (hands, key) => calculateStatistics(hands, 'hero').metrics.find((m) => m.key === key);
test('coach: forced blinds do not become VPIP; voluntary and all-in raises count exactly', () => {
  const hs = [hand(), hand({ actions: [action(1, 'hero', 'fold')] }), hand({ actions: [action(1, 'hero', 'call')] }),
    hand({ actions: [action(1, 'hero', 'all-in', { amount: 30, raiseTo: 30 })] })];
  assert.deepEqual([metric(hs, 'vpip').occurrences, metric(hs, 'vpip').opportunities, metric(hs, 'vpip').value], [2, 3, 66.67]);
  assert.deepEqual([metric(hs, 'pfr').occurrences, metric(hs, 'pfr').opportunities], [1, 3]);
});
test('coach: 3-bet denominator counts actual opportunities, not hands or locked/short all-in calls', () => {
  const hs = [hand({ actions: [action(1, 'opponent', 'raise'), action(2, 'hero', 'raise', { raiseTo: 20, amount: 20, toCall: 6 })] }),
    hand({ actions: [action(1, 'opponent', 'raise'), action(2, 'hero', 'call', { amount: 6, toCall: 6 })] }),
    hand({ actions: [action(1, 'opponent', 'raise'), action(2, 'hero', 'all-in', { amount: 4, toCall: 6, canRaise: false })] }),
    hand({ actions: [action(1, 'hero', 'fold')] })];
  assert.deepEqual([metric(hs, 'threeBet').occurrences, metric(hs, 'threeBet').opportunities, metric(hs, 'threeBet').value], [1, 2, 50]);
  assert.equal(metric(hs, 'callOpen').opportunities, 3);
});
test('coach: fold to 3-bet, squeeze and steals use relevant previous actions and positions', () => {
  const fold3 = hand({ actions: [action(1, 'hero', 'raise'), action(2, 'opponent', 'raise', { raiseTo: 20 }), action(3, 'hero', 'fold', { toCall: 14 })] });
  assert.equal(metric([fold3], 'foldToThreeBet').value, 100);
  const sq = hand({ actions: [action(1, 'opponent', 'raise'), action(2, 'other', 'call', { amount: 6 }), action(3, 'hero', 'raise', { amount: 20, raiseTo: 20, toCall: 6 })] });
  assert.equal(metric([sq], 'squeeze').value, 100);
  assert.equal(metric([hand({ actions: [action(1, 'hero', 'raise')] })], 'steal').value, 100);
  assert.equal(metric([hand({ actions: [action(1, 'opponent', 'call'), action(2, 'hero', 'raise')] })], 'steal').value, null);
});
test('coach: c-bet, turn continuation, folds to c-bet and check-raise are opportunity based', () => {
  const hs = [hand({ actions: [action(1, 'hero', 'raise'), action(2, 'opponent', 'call'),
    action(3, 'hero', 'raise', { street: 'flop', amount: 8, raiseTo: 8, toCall: 0 }), action(4, 'opponent', 'call', { street: 'flop', amount: 8 }),
    action(5, 'hero', 'check', { street: 'turn', toCall: 0 }), action(6, 'opponent', 'raise', { street: 'turn', raiseTo: 10, amount: 10, toCall: 0 }),
    action(7, 'hero', 'raise', { street: 'turn', raiseTo: 30, amount: 30, toCall: 10 })] })];
  assert.equal(metric(hs, 'flopCbet').value, 100);
  assert.equal(metric(hs, 'turnCbet').value, 0);
  assert.equal(metric(hs, 'checkRaise').value, 100);
  const fold = hand({ actions: [action(1, 'opponent', 'raise'), action(2, 'hero', 'call'), action(3, 'opponent', 'raise', { street: 'flop', toCall: 0 }), action(4, 'hero', 'fold', { street: 'flop', toCall: 6 })] });
  assert.equal(metric([fold], 'foldToCbet').value, 100);
});
test('coach: missing opportunities are N/A and never zero percent or infinite AF', () => {
  assert.equal(metric([hand()], 'threeBet').value, null);
  assert.equal(metric([hand()], 'af').value, null);
  assert.equal(metric([hand()], 'vpip').reliability, 'none');
});
test('coach: side-pot wins, changing blinds and opponent outcomes are not confused', () => {
  const first = hand({ net: 10, bigBlind: 2, sawFlop: true, wentToShowdown: true, won: true,
    players: [{ playerId: 'hero', seatNumber: 1 }, { playerId: 'opponent', seatNumber: 2, outcome: { net: -10, sawFlop: true, wentToShowdown: true, won: false } }] });
  const stats = calculateStatistics([first, hand({ net: -4, bigBlind: 4 })], 'hero');
  assert.equal(stats.pokerNet, 6); assert.equal(stats.bb100, 200);
  assert.equal(metric([first], 'wsd').value, 100);
  assert.equal(calculateStatistics([first], 'opponent').wins, 0);
  assert.equal(calculateStatistics([first], 'opponent').pokerNet, -10);
});

test('coach: decisions contain only pre-action board, own cards and incremental paid amounts', () => {
  const seats = (stack, bet) => [{ playerId: 'hero', seatNumber: 1, stack, currentBet: bet, totalCommitted: bet, isFolded: false }, { playerId: 'opponent', seatNumber: 2, stack: 94, currentBet: 6, totalCommitted: 6, isFolded: false }];
  const safe = { key: 'hand-0', board: [{ rank: '7', suit: 'hearts' }], players: hand().players.map((p) => ({ ...p, holeCards: p.playerId === 'hero' ? hand().ownCards : [null, null] })), uncalledReturns: [], pots: [], actions: [action(1, 'hero', 'raise', { amount: 20, raiseTo: 20 })] };
  const source = buildAuthorizedCoachHand(safe, [{ sequence: 0, street: 'preflop', board: [], pot: 8, seats: seats(98, 2) },
    { sequence: 1, street: 'flop', board: safe.board, pot: 26, seats: seats(80, 20) }], { bigBlind: 2, dealerSeat: 1 }, 'hero', 1);
  assert.equal(source.decisions[0].action.amount, 18);
  assert.equal(source.decisions[0].pot, 8);
  assert.deepEqual(source.decisions[0].board, []);
  const payload = JSON.stringify(decisionPayload(source));
  assert.equal(payload.includes('"players"'), false);
  assert.equal(payload.includes('hearts'), false);
  assert.equal(payload.includes('holeCards'), false);
  assert.equal(payload.includes('net'), false);
});
test('coach: shared public cache strips every hole card, deck, avatar and unrecognized event field', () => {
  const frame = { sequence: 1, street: 'preflop', board: [], pot: 3, remainingDeck: ['SECRET'], seats: [{ playerId: 'hero', seatNumber: 1, stack: 10, currentBet: 2, totalCommitted: 2, isFolded: false, holeCards: ['PRIVATE'], avatarDataUrl: 'PICTURE' }] };
  const cache = JSON.stringify(publicCoachCache([frame], { bigBlind: 2, dealerSeat: 1 }, [{ sequence: 1, type: 'PLAYER_ACTION', payload: { actorPlayerId: 'hero', action: { type: 'call', hidden: 'OTHER' }, holeCards: ['SECRET2'], deck: ['DECK'] }, createdAt: new Date() }]));
  for (const secret of ['SECRET', 'PRIVATE', 'PICTURE', 'OTHER', 'DECK', 'holeCards', 'remainingDeck']) assert.equal(cache.includes(secret), false);
});
test('coach: model allowlist drops future accidentally added private fields at every level', () => {
  const secret = 'DO_NOT_SEND_TO_MODEL';
  const d = decision('hand-0:1', { hiddenOpponentCards: secret, board: [{ rank: 'A', suit: 'hearts', secret }],
    ownCards: [{ rank: 'K', suit: 'clubs', secret }, null], action: { ...action(1, 'hero', 'call'), secret },
    seats: [{ playerId: 'opponent', seatNumber: 2, stack: 30, currentBet: 2, totalCommitted: 2, isFolded: false, holeCards: secret }],
    priorActions: [{ ...action(0, 'opponent', 'raise'), secret }] });
  assert.equal(JSON.stringify(decisionPayload(hand({ decisions: [d], remainingDeck: secret }))).includes(secret), false);
});
test('coach: positions follow actual seats and heads-up dealer is small blind', () => {
  assert.equal(positionFor([{ seatNumber: 1 }, { seatNumber: 3 }], 3, 3), 'BTN/SB');
  assert.equal(positionFor([{ seatNumber: 1 }, { seatNumber: 3 }], 3, 1), 'BB');
  assert.equal(positionFor([1, 3, 5, 6, 8, 9].map((seatNumber) => ({ seatNumber })), 6, 5), 'CO');
});
test('coach: output validation rejects invented hands, actions, duplicate or omitted decisions and domains', () => {
  const h = hand({ decisions: [decision()] });
  const valid = { hands: [{ handKey: h.key, summary: 'החלטה עם מידע מוגבל.', evaluations: [evaluation('hand-0:1')] }] };
  assert.equal(validateBatch(valid, [h]).length, 1);
  assert.throws(() => validateBatch({ hands: [{ ...valid.hands[0], handKey: 'hand-999' }] }, [h]));
  assert.throws(() => validateBatch({ hands: [{ ...valid.hands[0], evaluations: [] }] }, [h]));
  assert.throws(() => validateBatch({ hands: [{ ...valid.hands[0], evaluations: [evaluation('hand-0:99')] }] }, [h]));
  assert.throws(() => validateBatch({ hands: [{ ...valid.hands[0], evaluations: [evaluation('hand-0:1', { dimensions: ['postflop'] })] }] }, [h]));
  assert.throws(() => validateNarrative({ ...narrative, improvements: [{ title: 'בדיקה', explanation: 'בעיה', exercise: 'תרגיל', decisionIds: ['hand-999:9'] }] }, [{ hand: h, analysis: valid.hands[0] }]));
});
test('coach: scoring is transparent, confidence weighted and independent of win/loss', () => {
  const es = Array.from({ length: 5 }, (_, i) => evaluation(`hand-0:${i}`, { rating: i === 0 ? 'major_mistake' : 'good' }));
  assert.equal(calculateScores(es).overall.score, 77);
  assert.equal(calculateScores(es.slice(0, 2)).overall.score, null);
  assert.equal(calculateScores(es.map((e) => ({ ...e, confidence: 'low' }))).overall.score, null);
  const stored = [{ hand: hand({ net: 1000, decisions: es.map((e) => decision(e.decisionId)) }), analysis: { handKey: 'hand-0', summary: 'סקירה', evaluations: es } }];
  const a = buildFinalReport(stored, { playerId: 'hero', displayName: 'אורי', date: '', participants: 2, net: 1000 }, narrative, 'test');
  const b = buildFinalReport(stored.map((s) => ({ ...s, hand: { ...s.hand, net: -1000 } })), { ...a.identity, net: -1000 }, narrative, 'test');
  assert.deepEqual(a.scores, b.scores);
});
test('coach: opponent sample counts come from code; invented/small samples are rejected', () => {
  const h = hand({ decisions: [decision()], actions: Array.from({ length: 34 }, (_, i) => action(i, 'opponent', 'call')) });
  const stored = [{ hand: h, analysis: { handKey: h.key, summary: 'סקירה', evaluations: [evaluation('hand-0:1')] } }];
  const value = { ...narrative, opponents: [{ playerId: 'opponent', explanation: 'תשלומים גלויים חוזרים; אין מידע על הקלפים שלו.' }] };
  assert.equal(validateNarrative(value, stored).opponents[0].evidenceCount, 34);
  assert.throws(() => validateNarrative(value, [{ ...stored[0], hand: { ...h, actions: h.actions.slice(0, 3) } }]));
  assert.throws(() => validateNarrative({ ...value, opponents: [{ ...value.opponents[0], evidenceCount: 999 }] }, stored));
});
test('coach: all model calls are disabled without explicit free-project confirmation; no paid fallback', () => {
  assert.equal(coachConfiguration({}).enabled, false);
  const env = { AI_COACH_ENABLED: 'true', GEMINI_API_KEY: 'test-key', GEMINI_FREE_TIER_CONFIRMED: 'true' };
  assert.equal(coachConfiguration(env).enabled, true);
  assert.equal(coachConfiguration({ ...env, GEMINI_COACH_MODEL: 'gemini-pro-paid' }).enabled, false);
  assert.equal(coachConfiguration({ ...env, GEMINI_FREE_TIER_CONFIRMED: 'false' }).enabled, false);
  assert.ok(retryDelay(2, true) > retryDelay(1, true));
});
test('coach HTTP: unauthenticated, foreign-game and spoofed-player requests are denied server-side', async () => {
  let calls = 0;
  const app = createApp({ roomRepository: {}, accountRepository: { findIdentityBySession: async (token) => token === 'valid' ? { id: 'self' } : null },
    coachService: { state: async (account, game) => account === 'self' && game === 'allowed' ? { status: 'NOT_GENERATED', available: true } : null,
      request: async (account) => { assert.equal(account, 'self'); calls++; return { status: 'PENDING' }; },
      repository: { readReport: async () => null } }, isOriginAllowed: () => true });
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await globalThis.fetch(`${url}/auth/history/allowed/coach`)).status, 401);
    const headers = { Cookie: 'poker_account_token=valid', 'Content-Type': 'application/json' };
    assert.equal((await globalThis.fetch(`${url}/auth/history/foreign/coach`, { method: 'POST', headers, body: '{}' })).status, 404);
    assert.equal((await globalThis.fetch(`${url}/auth/history/allowed/coach`, { method: 'POST', headers, body: '{"playerId":"other"}' })).status, 400);
    assert.equal((await globalThis.fetch(`${url}/auth/history/allowed/coach`, { method: 'POST', headers, body: '{}' })).status, 202);
    assert.equal((await globalThis.fetch(`${url}/auth/history/foreign/coach/report`, { headers })).status, 404);
    assert.equal((await globalThis.fetch(`${url}/internal/coach/run`)).status, 401);
    assert.equal(calls, 1);
  } finally { server.close(); await once(server, 'close'); }
});
