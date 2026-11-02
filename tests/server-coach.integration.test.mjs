import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { test, after, beforeEach } from 'node:test';
import { hand, decision, evaluation, narrative } from './fixtures/coach.mjs';
import { CoachRepository } from '../apps/server/src/coach/repository.ts';
import { CoachService } from '../apps/server/src/coach/service.ts';
import { CoachProviderError, createGeminiProvider } from '../apps/server/src/coach/gemini.ts';
import { decisionPayload } from '../apps/server/src/coach/authorized-data.ts';
import { unpackPublicCoachCache } from '../apps/server/src/coach/public-cache.ts';

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

async function fixture(count = 3) {
  const accounts = new AccountRepository(prisma);
  const profiles = [];
  for (let i = 0; i < count; i++) profiles.push((await accounts.createSession(randomUUID(), `coach-${randomUUID()}@example.com`)).profile);
  const rooms = new RoomRepository(prisma, undefined, undefined, undefined, keys);
  const room = await rooms.createRoom({ status: 'WAITING', host: { id: randomUUID(), accountId: profiles[0].id, displayName: 'Hero', initialStack: 500 },
    players: profiles.slice(1).map((p, i) => ({ id: randomUUID(), accountId: p.id, displayName: `Opponent ${i}`, initialStack: 500 })) });
  await rooms.startGameForHostAtomically({ joinId: room.joinId, hostPlayerId: room.hostPlayerId });
  for (let i = 0; i < count - 1; i++) {
    const { recovery: { hand } } = await rooms.recoverLatestHandForPlayer(room.id, room.hostPlayerId);
    const actor = hand.seats.find((s) => s.seatNumber === hand.currentActorSeat);
    await rooms.persistPlayerActionAtomically({ roomId: room.id, playerId: actor.playerId, action: { type: 'fold' } });
  }
  await rooms.revealShowdownCardAtomically({ roomId: room.id, playerId: room.players[1].id, cardIndex: 0 });
  await rooms.closeRoomForHost(room.joinId, room.hostPlayerId);
  const hands = await rooms.listHandsForAccount(profiles[0].id, room.joinId);
  const players = await prisma.player.findMany({ where: { roomId: room.id }, select: { id: true, accountId: true } });
  return { rooms, room, profiles, playerIds: new Map(players.map((p) => [p.accountId, p.id])), key: hands.hands[0].key, repo: new CoachRepository(prisma) };
}
const provider = (counter = { analyses: 0, summaries: 0 }) => ({
  analyze: async (hands) => { counter.analyses++; return { analyses: hands.map((h) => ({ handKey: h.key, summary: 'החלטות נבחנו בלי לדעת תוצאה.', evaluations: h.decisions.map((d) => evaluation(d.id)) })), inputTokens: 100, outputTokens: 100 }; },
  summarize: async () => { counter.summaries++; return { narrative, inputTokens: 100, outputTokens: 100 }; },
});
async function ungate() {
  await prisma.coachQuota.updateMany({ data: { nextRequestAt: new Date(0) } });
  await prisma.coachReport.updateMany({ where: { status: { in: ['PENDING', 'RATE_LIMITED'] }, nextAttemptAt: { gt: new Date() } }, data: { nextAttemptAt: new Date(0) } });
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

test('coach DB: a 7-hand report starts while a 61-hand report is running; a closed gate preserves fairness and reads no hands', { skip: !enabled }, async () => {
  const long = await fixture(), short = await fixture();
  const jobs = await Promise.all([long, short].map((f) => f.repo.request(f.profiles[0].id, f.room.joinId, config.model)));
  for (const [i, total] of [61, 7].entries()) await prisma.coachReport.update({ where: { id: jobs[i].id }, data: {
    manifest: Array.from({ length: total }, (_, n) => ({ key: `hand-${n}`, number: n + 1 })), totalHands: total,
    updatedAt: new Date(Date.now() - 10_000 + i),
  } });
  const loads = [];
  const fakeRooms = { getHandForAccount: async (account, joinId, key, number) => {
    const f = joinId === long.room.joinId ? long : short;
    assert.equal(account, f.profiles[0].id);
    loads.push(joinId);
    return { coach: hand({ key, number, ownPlayerId: f.room.hostPlayerId,
      decisions: [decision(`${key}:1`, { playerId: f.room.hostPlayerId })] }) };
  } };
  let started, release;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const normal = provider(); let first = true;
  const model = { ...normal, analyze: async (hands) => {
    if (first) { first = false; started(); await held; }
    return normal.analyze(hands);
  } };
  const service = () => new CoachService(new CoachRepository(prisma), fakeRooms, model, config);
  const running = service().runOne();
  await firstStarted;
  try {
    const waitingBefore = await prisma.coachReport.findUnique({ where: { id: jobs[1].id } });
    const readsBefore = loads.length;
    const blocked = await service().runOne();
    assert.equal(blocked.worked, false); assert.ok(blocked.retryAt instanceof Date);
    assert.equal(loads.length, readsBefore);
    const waitingAfter = await prisma.coachReport.findUnique({ where: { id: jobs[1].id } });
    assert.equal(waitingAfter.updatedAt.getTime(), waitingBefore.updatedAt.getTime());
    assert.equal(waitingAfter.status, 'PENDING');
    assert.equal((await short.repo.state(short.profiles[0].id, short.room.joinId)).queueState, 'WAITING');
    await ungate();
    await service().runOne();
    assert.equal((await short.repo.state(short.profiles[0].id, short.room.joinId)).completedHands, 4);
    assert.equal((await long.repo.state(long.profiles[0].id, long.room.joinId)).status, 'PROCESSING');
  } finally { release(); await running; }
  for (let i = 0; i < 10; i++) {
    await ungate(); await service().runOne();
    if ((await short.repo.state(short.profiles[0].id, short.room.joinId)).status === 'COMPLETED') break;
  }
  assert.equal((await short.repo.state(short.profiles[0].id, short.room.joinId)).status, 'COMPLETED');
  assert.ok((await long.repo.state(long.profiles[0].id, long.room.joinId)).completedHands < 61);
  assert.equal((await short.repo.readReport(short.profiles[0].id, short.room.joinId)).hands.length, 7);
});

test('coach DB: six reports from one table have distinct identities, three global slots and atomic shared dispatch quota', { skip: !enabled }, async () => {
  const { repo, profiles, room, playerIds } = await fixture(6);
  const jobs = await Promise.all(profiles.map((p) => repo.request(p.id, room.joinId, config.model)));
  assert.equal(new Set(jobs.map((j) => j.id)).size, 6);
  const now = new Date();
  const wave = await Promise.all(Array.from({ length: 8 }, () => new CoachRepository(prisma).claimForDispatch(now)));
  assert.equal(wave.filter((r) => r.job).length, 1);
  const running = [wave.find((r) => r.job).job];
  for (let i = 1; i < 3; i++) running.push((await repo.claimForDispatch(new Date(now.getTime() + i * 12_000))).job);
  assert.equal(new Set(running.map((j) => j.id)).size, 3);
  const capped = await repo.claimForDispatch(new Date(now.getTime() + 36_000));
  assert.equal(capped.job, null); assert.ok(capped.retryAt instanceof Date);
  assert.equal((await prisma.coachQuota.findUnique({ where: { id: 'gemini-free' } })).dailyCalls, 3);
  for (const j of running) {
    const owner = profiles.find((p) => p.id === j.accountId);
    assert.equal(j.playerId, playerIds.get(owner.id));
  }
  // Finish/resume all six; no completed report can satisfy another account.
  for (const j of running) await repo.defer(j.id, j.token, 'PENDING', 'TEST_RELEASE', new Date(0), false);
  const normal = provider();
  for (let i = 0; i < 16; i++) { await ungate(); await new CoachService(repo, { getHandForAccount: async (account, _join, key, number) => {
    const playerId = playerIds.get(account);
    return { coach: hand({ key, number, ownPlayerId: playerId, decisions: [decision(`${key}:1`, { playerId })] }) };
  } }, normal, config).runOne(); }
  for (const p of profiles) {
    const report = await repo.readReport(p.id, room.joinId);
    assert.equal(report.identity.playerId, playerIds.get(p.id));
  }
  assert.equal(await repo.readReport(randomUUID(), room.joinId), null);
});

test('coach DB: concurrent public preparation across replicas reads snapshots once, reuses fewer bytes, and still checks archive access', { skip: !enabled }, async (t) => {
  const { room, profiles, key, playerIds } = await fixture(6);
  let snapshotReads = 0, snapshotBytes = 0, cacheBytes = 0;
  // Prisma transaction clients use the same query extension, covering all replicas.
  const db = prisma.$extends({ query: {
    gameSnapshot: { async findMany({ args, query }) { snapshotReads++; const rows = await query(args); snapshotBytes += Buffer.byteLength(JSON.stringify(rows)); return rows; } },
    coachPublicHand: { async findUnique({ args, query }) { const row = await query(args); cacheBytes += Buffer.byteLength(JSON.stringify(row)); return row; } },
  } });
  const replicas = profiles.map(() => new RoomRepository(db, undefined, undefined, undefined, keys));
  const results = await Promise.all(profiles.map((p, i) => replicas[i].getHandForAccount(p.id, room.joinId, key, 1)));
  assert.equal(snapshotReads, 1);
  const firstReadBytes = snapshotBytes + cacheBytes;
  const oldTransfers = snapshotBytes * profiles.length;
  assert.ok(firstReadBytes < oldTransfers, `shared=${firstReadBytes}, repeated=${oldTransfers}`);
  const saved = await prisma.coachPublicHand.findUniqueOrThrow({ where: { roomId_handKey: { roomId: room.id, handKey: key } } });
  const decoded = unpackPublicCoachCache(saved.data, saved.data.sourceVersion);
  const shared = JSON.stringify(decoded);
  assert.ok(decoded.actions.length > 0);
  const oldCache = { config: decoded.config, frames: decoded.frames, events: decoded.events };
  const previousCacheTransfers = snapshotBytes + Buffer.byteLength(JSON.stringify(oldCache)) * (profiles.length - 1);
  assert.ok(firstReadBytes < previousCacheTransfers, `shared=${firstReadBytes}, previous=${previousCacheTransfers}`);
  for (const field of ['holeCards', 'ownCards', 'remainingDeck', 'avatarDataUrl']) assert.equal(shared.includes(field), false);
  for (const [i, result] of results.entries()) {
    assert.equal(result.coach.ownPlayerId, playerIds.get(profiles[i].id));
    assert.ok(result.coach.ownCards.every(Boolean));
    const payload = JSON.stringify(decisionPayload(result.coach));
    assert.equal(payload.includes('holeCards'), false);
  }
  const bytesBeforeWarmRead = cacheBytes;
  await replicas[0].getHandForAccount(profiles[0].id, room.joinId, key, 1);
  assert.equal(cacheBytes, bytesBeforeWarmRead);
  await replicas[0].hideGameForAccount(profiles[0].id, room.joinId);
  assert.equal(await replicas[0].getHandForAccount(profiles[0].id, room.joinId, key, 1), null);
  assert.equal(await replicas[1].getHandForAccount(randomUUID(), room.joinId, key, 1), null);
  t.diagnostic(`snapshot bytes=${snapshotBytes}; shared preparation reads=${firstReadBytes}; previous public cache=${previousCacheTransfers}; six repeated archives=${oldTransfers}`);
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
