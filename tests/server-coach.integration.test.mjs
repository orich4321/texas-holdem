import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { test, after, beforeEach } from 'node:test';
import { hand, decision, evaluation, narrative } from './fixtures/coach.mjs';
import { CoachRepository } from '../apps/server/src/coach/repository.ts';
import { CoachService } from '../apps/server/src/coach/service.ts';
import { CoachProviderError, createGeminiProvider } from '../apps/server/src/coach/gemini.ts';
import { decisionPayload } from '../apps/server/src/coach/authorized-data.ts';

const enabled = Boolean(globalThis.process.env.TEST_DATABASE_URL);
const { prisma } = enabled ? await import('../apps/server/src/persistence/prisma.ts') : {};
const { RoomRepository } = enabled ? await import('../apps/server/src/persistence/room-repository.ts') : {};
const { AccountRepository } = enabled ? await import('../apps/server/src/persistence/account-repository.ts') : {};
const keys = new Map([['coach-test', Buffer.from('coach integration test private snapshot key exceeds 32 bytes')]]);
const config = { enabled: true, model: 'gemini-3.8-flash' };
if (enabled) {
  beforeEach(async () => {
    assert.match(globalThis.process.env.TEST_DATABASE_URL, /(?:_|-)test(?:\?|$|\/)/);
    await prisma.coachHand.deleteMany(); await prisma.coachReport.deleteMany(); await prisma.coachQuota.deleteMany();
    await prisma.coachPublicHand.deleteMany();
  });
  after(async () => { await prisma.$disconnect(); });
}

async function fixture() {
  const accounts = new AccountRepository(prisma);
  const profiles = [];
  for (let i = 0; i < 3; i++) profiles.push((await accounts.createSession(randomUUID(), `coach-${randomUUID()}@example.com`)).profile);
  const rooms = new RoomRepository(prisma, undefined, undefined, undefined, keys);
  const room = await rooms.createRoom({ status: 'WAITING', host: { id: randomUUID(), accountId: profiles[0].id, displayName: 'Hero', initialStack: 500 },
    players: profiles.slice(1).map((p, i) => ({ id: randomUUID(), accountId: p.id, displayName: `Opponent ${i}`, initialStack: 500 })) });
  await rooms.startGameForHostAtomically({ joinId: room.joinId, hostPlayerId: room.hostPlayerId });
  for (let i = 0; i < 2; i++) {
    const { recovery: { hand } } = await rooms.recoverLatestHandForPlayer(room.id, room.hostPlayerId);
    const actor = hand.seats.find((s) => s.seatNumber === hand.currentActorSeat);
    await rooms.persistPlayerActionAtomically({ roomId: room.id, playerId: actor.playerId, action: { type: 'fold' } });
  }
  await rooms.revealShowdownCardAtomically({ roomId: room.id, playerId: room.players[1].id, cardIndex: 0 });
  await rooms.closeRoomForHost(room.joinId, room.hostPlayerId);
  const hands = await rooms.listHandsForAccount(profiles[0].id, room.joinId);
  return { rooms, room, profiles, key: hands.hands[0].key, repo: new CoachRepository(prisma) };
}
const provider = (counter = { analyses: 0, summaries: 0 }) => ({
  analyze: async (hands) => { counter.analyses++; return { analyses: hands.map((h) => ({ handKey: h.key, summary: 'החלטות נבחנו בלי לדעת תוצאה.', evaluations: h.decisions.map((d) => evaluation(d.id)) })), inputTokens: 100, outputTokens: 100 }; },
  summarize: async () => { counter.summaries++; return { narrative, inputTokens: 100, outputTokens: 100 }; },
});
async function ungate() {
  await prisma.coachQuota.updateMany({ data: { nextRequestAt: new Date(0) } });
  await prisma.coachReport.updateMany({ where: { status: { in: ['PENDING', 'RATE_LIMITED'] } }, data: { nextAttemptAt: new Date(0) } });
}

test('coach DB: real signed history, partial reveals and shared cache do not disclose private cards', { skip: !enabled }, async () => {
  const { rooms, room, profiles, key } = await fixture();
  const own = await rooms.getHandForAccount(profiles[0].id, room.joinId, key, 1);
  const revealed = own.coach.players.find((p) => p.playerId === room.players[1].id);
  assert.ok(revealed.holeCards[0]); assert.equal(revealed.holeCards[1], null);
  const raw = await rooms.recoverLatestHandForPlayer(room.id, room.hostPlayerId);
  const actual = raw.recovery.hand.seats.find((s) => s.playerId === revealed.playerId).holeCards;
  assert.deepEqual(revealed.holeCards, [actual[0], null]);
  const modelPayload = JSON.stringify(decisionPayload(own.coach));
  assert.equal(modelPayload.includes('holeCards'), false);
  assert.equal(modelPayload.includes(JSON.stringify(actual[1])), false);
  const cache = await prisma.coachPublicHand.findUniqueOrThrow({ where: { roomId_handKey: { roomId: room.id, handKey: key } } });
  assert.equal(JSON.stringify(cache.data).includes('holeCards'), false);
  assert.equal(JSON.stringify(cache.data).includes('remainingDeck'), false);
  const another = await rooms.getHandForAccount(profiles[1].id, room.joinId, key, 1);
  assert.deepEqual(another.coach.ownCards, actual);
  assert.deepEqual(another.coach.players.find((p) => p.playerId === room.hostPlayerId).holeCards, [null, null]);
  assert.equal(await rooms.getHandForAccount(randomUUID(), room.joinId, key, 1), null);
});
test('coach DB: ten simultaneous requests create one job, atomic leases exclude another worker', { skip: !enabled }, async () => {
  const { room, profiles, repo } = await fixture();
  const results = await Promise.all(Array.from({ length: 10 }, () => repo.request(profiles[0].id, room.joinId, config.model)));
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(await prisma.coachReport.count({ where: { roomId: room.id } }), 1);
  assert.ok(await repo.nextWake() instanceof Date);
  const leases = await Promise.all([repo.claim(), new CoachRepository(prisma).claim()]);
  assert.equal(leases.filter(Boolean).length, 1);
  const lease = leases.find(Boolean);
  await prisma.coachReport.update({ where: { id: lease.id }, data: { leaseUntil: new Date(0) } });
  const resumed = await new CoachRepository(prisma).claim();
  assert.ok(resumed); assert.notEqual(resumed.token, lease.token);
  assert.equal(await repo.save(lease.id, lease.token, [], { inputTokens: 0, outputTokens: 0 }), false);
  await prisma.coachReport.update({ where: { id: resumed.id }, data: { engineVersion: 'old-engine', leaseUntil: new Date(0) } });
  const counter = { analyses: 0, summaries: 0 };
  await new CoachService(repo, {}, provider(counter), config).runOne();
  assert.equal((await repo.state(profiles[0].id, room.joinId)).errorCode, 'ENGINE_VERSION_REQUIRES_REVIEW');
  assert.deepEqual(counter, { analyses: 0, summaries: 0 });
  assert.equal(await repo.nextWake(), null);
});
test('coach DB: completed report survives restart/version change; read and create remain account scoped', { skip: !enabled }, async () => {
  const { room, profiles, repo, rooms } = await fixture();
  await repo.request(profiles[0].id, room.joinId, config.model);
  const counter = { analyses: 0, summaries: 0 };
  const service = new CoachService(repo, rooms, provider(counter), config);
  await service.runOne(); await ungate(); await service.runOne();
  assert.deepEqual(counter, { analyses: 1, summaries: 1 });
  const report = await new CoachRepository(prisma).readReport(profiles[0].id, room.joinId);
  assert.equal(report.version, 'coach-v1.0.0');
  assert.equal(await repo.readReport(profiles[1].id, room.joinId), null);
  assert.equal(await repo.request(randomUUID(), room.joinId, config.model), null);
  await Promise.all(Array.from({ length: 10 }, () => repo.request(profiles[0].id, room.joinId, 'different-model')));
  await new CoachService(new CoachRepository(prisma), rooms, provider(counter), { enabled: true, model: 'different-model' }).runOne();
  assert.deepEqual(counter, { analyses: 1, summaries: 1 });
  assert.deepEqual(await repo.readReport(profiles[0].id, room.joinId), report);
  assert.equal((await rooms.listGamesForAccount(profiles[0].id)).find((g) => g.joinId === room.joinId).coach.status, 'COMPLETED');
  await rooms.hideGameForAccount(profiles[0].id, room.joinId);
  assert.equal(await repo.readReport(profiles[0].id, room.joinId), null);
  assert.equal(await repo.state(profiles[0].id, room.joinId), null);
});
test('coach DB: 429 during long hand resumes saved decision batches without repeating them', { skip: !enabled }, async () => {
  const { room, profiles, repo, key } = await fixture();
  await repo.request(profiles[0].id, room.joinId, config.model);
  const source = hand({ key, ownPlayerId: room.hostPlayerId, decisions: Array.from({ length: 12 }, (_, i) => decision(`${key}:${i}`, { playerId: room.hostPlayerId })) });
  let loads = 0, calls = 0;
  const fakeRooms = { getHandForAccount: async () => { loads++; return { coach: source }; } };
  const normal = provider();
  const model = { ...normal, analyze: async (hands) => { calls++; if (calls === 2) throw new CoachProviderError('RATE_LIMITED'); return normal.analyze(hands); } };
  const service = new CoachService(repo, fakeRooms, model, config);
  await service.runOne(); await ungate();
  const job = await repo.state(profiles[0].id, room.joinId);
  assert.equal((await repo.loadHand(job.id, key)).analysis.evaluations.length, 8);
  await service.runOne();
  assert.equal((await repo.state(profiles[0].id, room.joinId)).status, 'RATE_LIMITED');
  assert.equal((await repo.loadHand(job.id, key)).analysis.evaluations.length, 8);
  await ungate(); await new CoachService(new CoachRepository(prisma), fakeRooms, model, config).runOne();
  assert.equal((await repo.loadHand(job.id, key)).analysis.evaluations.length, 12);
  assert.equal(loads, 1);
  assert.equal((await repo.state(profiles[0].id, room.joinId)).completedHands, 1);
  await ungate(); await service.runOne();
  assert.equal((await repo.state(profiles[0].id, room.joinId)).status, 'COMPLETED');
});
test('coach DB: project quota is atomic across replicas, respects day/month caps and RLS is enabled', { skip: !enabled }, async () => {
  const repo = new CoachRepository(prisma), now = new Date('2026-11-02T12:00:00Z');
  const reservations = await Promise.all(Array.from({ length: 10 }, () => repo.reserveCall(now)));
  assert.equal(reservations.filter((r) => r === null).length, 1);
  await prisma.coachQuota.update({ where: { id: 'gemini-free' }, data: { dailyCalls: 500, nextRequestAt: new Date(0) } });
  assert.equal((await repo.reserveCall(now)).toISOString(), '2026-11-03T00:00:00.000Z');
  await prisma.coachQuota.update({ where: { id: 'gemini-free' }, data: { monthlyCalls: 10000, nextRequestAt: new Date(0) } });
  assert.equal((await repo.reserveCall(now)).toISOString(), '2026-12-01T00:00:00.000Z');
  const tables = await prisma.$queryRaw`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('CoachReport','CoachHand','CoachQuota','CoachPublicHand')`;
  assert.equal(tables.length, 4); assert.ok(tables.every((t) => t.relrowsecurity));
});

test('coach DB: 61 mixed hands resume a rejected request through the real SDK, durable queue and final report', { skip: !enabled }, async (t) => {
  const { room, profiles, repo } = await fixture();
  const model = 'gemini-3.5-flash-lite';
  const job = await repo.request(profiles[0].id, room.joinId, model);
  const manifest = Array.from({ length: 61 }, (_, index) => ({ key: `hand-${index}`, number: index + 1 }));
  await prisma.coachReport.update({ where: { id: job.id }, data: { manifest, totalHands: 61 } });
  const successfulKeys = [];
  let failOnce = true;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = input instanceof globalThis.Request ? input : new globalThis.Request(input, init);
    const body = await request.json();
    if (failOnce) {
      failOnce = false;
      return new globalThis.Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Rejected schema.' } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    assert.equal(JSON.stringify(body.generationConfig.responseJsonSchema).includes('maxItems'), false);
    const payload = JSON.parse(body.contents[0].parts[0].text);
    assert.equal(JSON.stringify(payload).includes('holeCards'), false);
    const output = payload.hands ? { hands: payload.hands.map((h) => {
      successfulKeys.push(h.handKey);
      return { handKey: h.handKey, summary: 'בדיקה מלאכותית.', evaluations: h.decisions.map((d) => evaluation(d.id)) };
    }) } : narrative;
    return new globalThis.Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: {
      role: 'model', parts: [{ text: JSON.stringify(output) }],
    } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const rooms = { getHandForAccount: async (_account, _room, key) => {
    const index = Number(key.slice(5));
    return { coach: hand({ key, number: index + 1, ownPlayerId: room.hostPlayerId,
      decisions: Array.from({ length: [6, 1, 1, 0][index % 4] }, (_, sequence) => decision(`${key}:${sequence + 1}`)),
    }) };
  } };
  const sdk = createGeminiProvider('synthetic-test-key');
  const settings = { enabled: true, model };
  await new CoachService(repo, rooms, sdk, settings).runOne();
  const failed = await repo.state(profiles[0].id, room.joinId);
  assert.equal(failed.status, 'FAILED'); assert.equal(failed.errorCode, 'CONFIGURATION'); assert.equal(failed.completedHands, 0);
  await prisma.coachReport.update({ where: { id: job.id }, data: { nextAttemptAt: new Date(0) } });
  await repo.request(profiles[0].id, room.joinId, model);
  for (let checkpoint = 0; checkpoint < 65; checkpoint++) {
    await ungate();
    await new CoachService(new CoachRepository(prisma), rooms, sdk, settings).runOne();
    const state = await repo.state(profiles[0].id, room.joinId);
    assert.notEqual(state.status, 'FAILED');
    if (state.status === 'COMPLETED') break;
  }
  const completed = await repo.state(profiles[0].id, room.joinId);
  assert.equal(completed.status, 'COMPLETED'); assert.equal(completed.completedHands, 61);
  const saved = await repo.readReport(profiles[0].id, room.joinId);
  assert.equal(saved.hands.length, 61);
  assert.equal(new Set(successfulKeys).size, successfulKeys.length);
  assert.equal(successfulKeys.length, manifest.filter((_, index) => index % 4 !== 3).length);
  for (const h of saved.hands) assert.equal(h.analysis.evaluations.length, h.decisions.length);
  assert.equal(await repo.readReport(profiles[1].id, room.joinId), null);
});
