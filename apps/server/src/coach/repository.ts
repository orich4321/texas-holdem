import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { ENGINE_VERSION, type StoredCoachHand } from './types.js';
import type { FinalReport } from './analysis.js';

const statusSelect = { id: true, status: true, totalHands: true, completedHands: true, overallScore: true,
  errorCode: true, nextAttemptAt: true, completedAt: true, model: true, engineVersion: true } as const;
export const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
type Identity = { playerId: string; displayName: string; date: string; participants: number; net: number };
export type Manifest = { key: string; number: number }[];
export const COACH_CONCURRENCY = 3;
const LEASE_MS = 100_000;
const accessibleRoom = (accountId: string, joinId: string) => ({
  joinId, status: 'COMPLETED' as const, finalSummaryVisible: true,
  players: { some: { accountId } }, hiddenForAccounts: { none: { accountId } },
});

export class CoachRepository {
  constructor(readonly db: PrismaClient) {}

  async state(accountId: string, joinId: string) {
    const room = await this.db.room.findFirst({ where: accessibleRoom(accountId, joinId),
      select: { id: true, coachReports: { where: { accountId }, select: { ...statusSelect, leaseUntil: true }, take: 1 } } });
    if (!room) return null;
    const saved = room.coachReports[0];
    if (!saved) return { status: 'NOT_GENERATED' as const };
    const { leaseUntil, ...job } = saved;
    if (job.status === 'PROCESSING' && (!leaseUntil || leaseUntil.getTime() <= Date.now())) job.status = 'PENDING';
    if (!['PENDING', 'PROCESSING', 'RATE_LIMITED'].includes(job.status)) return job;
    const gate = await this.db.coachQuota.findUnique({ where: { id: 'gemini-free' }, select: { nextRequestAt: true } });
    const nextAttemptAt = new Date(Math.max(job.nextAttemptAt.getTime(), gate?.nextRequestAt.getTime() ?? 0));
    return { ...job, nextAttemptAt, queueState: job.status === 'PROCESSING' ? 'RUNNING' as const
      : ['TRANSIENT', 'INVALID_OUTPUT'].includes(job.errorCode ?? '') && job.nextAttemptAt.getTime() > Date.now() ? 'RETRY_WAIT' as const
      : nextAttemptAt.getTime() > Date.now() + 15_000 ? 'QUOTA_WAIT' as const : 'WAITING' as const };
  }

  async readReport(accountId: string, joinId: string) {
    // Ownership + current archive authorization checked on EVERY read. Hosts
    // have no special access to other participants' coaching reports.
    const job = await this.db.coachReport.findFirst({ where: { accountId, status: 'COMPLETED', room: accessibleRoom(accountId, joinId) }, select: { report: true } });
    return job?.report ?? null;
  }

  async request(accountId: string, joinId: string, model: string) {
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findFirst({ where: accessibleRoom(accountId, joinId), select: {
        id: true, createdAt: true, players: { select: { id: true, accountId: true, displayName: true, initialStack: true, currentStack: true } },
        chipAdjustments: { where: { player: { accountId }, status: 'APPLIED' }, select: { amount: true } },
        settlements: { orderBy: { createdAt: 'asc' }, select: { idempotencyKey: true } },
      } });
      if (!room || room.settlements.length === 0) return null;
      const own = room.players.find((p) => p.accountId === accountId)!;
      const existing = await tx.coachReport.findUnique({ where: { roomId_playerId: { roomId: room.id, playerId: own.id } }, select: statusSelect });
      if (existing) {
        if (existing.status === 'FAILED' && existing.nextAttemptAt <= new Date()) {
          // Same version/model/checkpoints. A completed report can NEVER be reset.
          await tx.coachReport.updateMany({ where: { id: existing.id, accountId, status: 'FAILED' }, data: { status: 'PENDING', errorCode: null, nextAttemptAt: new Date(), attempts: 0 } });
          return tx.coachReport.findUnique({ where: { id: existing.id }, select: statusSelect });
        }
        return existing;
      }
      const identity: Identity = { playerId: own.id, displayName: own.displayName, date: room.createdAt.toISOString(), participants: room.players.length,
        net: Math.round((own.currentStack - own.initialStack - room.chipAdjustments.reduce((s, a) => s + a.amount, 0)) * 10) / 10 };
      // ON CONFLICT protection is essential across devices/processes. A check
      // alone (including in a transaction) is not sufficient.
      await tx.coachReport.createMany({ skipDuplicates: true, data: [{ roomId: room.id, playerId: own.id, accountId, model, engineVersion: ENGINE_VERSION,
        totalHands: room.settlements.length, manifest: room.settlements.map((s, i) => ({ key: s.idempotencyKey, number: i + 1 })), identity: json(identity) }] });
      return tx.coachReport.findUniqueOrThrow({ where: { roomId_playerId: { roomId: room.id, playerId: own.id } }, select: statusSelect });
    });
  }

  async claim(now = new Date()) {
    return (await this.claimNext(now, false)).job;
  }

  /** Reserve the dispatch and quota atomically. A closed gate never claims or
   * demotes a queued report, nor loads its hand/snapshot data. */
  claimForDispatch(now = new Date()) { return this.claimNext(now, true); }

  private async claimNext(now: Date, reserve: boolean) {
    const token = randomUUID();
    return this.db.$transaction(async (tx) => {
      await this.lockQuota(tx, now);
      const active = await tx.coachReport.findMany({ where: { status: 'PROCESSING', leaseUntil: { gt: now } },
        select: { leaseUntil: true }, orderBy: { leaseUntil: 'asc' }, take: COACH_CONCURRENCY });
      if (active.length >= COACH_CONCURRENCY) return { job: null, retryAt: active[0].leaseUntil! };
      // The quota row serializes the global slot count across server replicas.
      // SKIP LOCKED also protects against concurrent requests changing a job.
      const candidates = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "CoachReport"
        WHERE (("status" IN ('PENDING', 'RATE_LIMITED') AND "nextAttemptAt" <= ${now})
          OR ("status" = 'PROCESSING' AND "leaseUntil" <= ${now}))
        ORDER BY "updatedAt" ASC, "createdAt" ASC, "id" ASC FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!candidates[0]) return { job: null };
      const wait = reserve ? await this.reserveLocked(tx, now) : null;
      if (wait) return { job: null, retryAt: wait };
      const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "CoachReport" SET "status" = 'PROCESSING', "leaseToken" = ${token}::uuid,
        "leaseUntil" = ${new Date(now.getTime() + LEASE_MS)}, "updatedAt" = ${now}, "errorCode" = NULL
      WHERE "id" = ${candidates[0].id}::uuid
      RETURNING "id"`;
      const job = await tx.coachReport.findUniqueOrThrow({ where: { id: rows[0].id },
        include: { room: { select: { joinId: true } } } });
      return { job: { ...job, token, manifest: job.manifest as unknown as Manifest, identity: job.identity as unknown as Identity } };
    });
  }

  async renew(id: string, token: string) {
    const now = new Date();
    const result = await this.db.coachReport.updateMany({ where: { id, leaseToken: token, status: 'PROCESSING', leaseUntil: { gt: now } },
      data: { leaseUntil: new Date(now.getTime() + LEASE_MS) } });
    return result.count === 1;
  }

  async checkpoints(reportId: string) {
    return this.db.coachHand.findMany({ where: { reportId }, orderBy: { number: 'asc' }, select: { handKey: true, complete: true } });
  }
  async loadHand(reportId: string, handKey: string): Promise<StoredCoachHand | null> {
    const saved = await this.db.coachHand.findUnique({ where: { reportId_handKey: { reportId, handKey } }, select: { data: true } });
    return saved ? saved.data as unknown as StoredCoachHand : null;
  }
  async storedHands(reportId: string): Promise<StoredCoachHand[]> {
    const saved = await this.db.coachHand.findMany({ where: { reportId, complete: true }, orderBy: { number: 'asc' }, select: { data: true } });
    return saved.map((r) => r.data as unknown as StoredCoachHand);
  }

  async save(reportId: string, token: string, hands: readonly StoredCoachHand[], usage: { inputTokens: number; outputTokens: number }) {
    return this.db.$transaction(async (tx) => {
      const owned = await tx.coachReport.updateMany({ where: { id: reportId, leaseToken: token, status: 'PROCESSING' }, data: {
        inputTokens: { increment: usage.inputTokens }, outputTokens: { increment: usage.outputTokens }, attempts: 0,
      } });
      if (!owned.count) return false;
      for (const data of hands) {
        const complete = data.analysis.evaluations.length === data.hand.decisions.length;
        await tx.coachHand.upsert({ where: { reportId_handKey: { reportId, handKey: data.hand.key } },
          create: { reportId, handKey: data.hand.key, number: data.hand.number, complete, data: json(data) }, update: { complete, data: json(data) } });
      }
      const completedHands = await tx.coachHand.count({ where: { reportId, complete: true } });
      await tx.coachReport.update({ where: { id: reportId }, data: { completedHands, status: 'PENDING', leaseToken: null, leaseUntil: null, errorCode: null, nextAttemptAt: new Date() } });
      return true;
    });
  }

  async finish(reportId: string, token: string, report: FinalReport, usage: { inputTokens: number; outputTokens: number }) {
    return this.db.coachReport.updateMany({ where: { id: reportId, leaseToken: token, status: 'PROCESSING' }, data: {
      status: 'COMPLETED', report: json(report), overallScore: report.scores.overall.score,
      completedAt: new Date(), leaseToken: null, leaseUntil: null, errorCode: null,
      inputTokens: { increment: usage.inputTokens }, outputTokens: { increment: usage.outputTokens },
    } });
  }

  async defer(reportId: string, token: string, status: 'PENDING' | 'FAILED' | 'RATE_LIMITED', errorCode: string, nextAttemptAt: Date, increment = true) {
    await this.db.coachReport.updateMany({ where: { id: reportId, leaseToken: token, status: 'PROCESSING' }, data: {
      status, errorCode, nextAttemptAt, leaseToken: null, leaseUntil: null, ...(increment ? { attempts: { increment: 1 } } : {}),
    } });
  }

  /** Atomic project-wide throttle, including replicas and concurrent cron/UI. */
  async reserveCall(now = new Date()): Promise<Date | null> {
    return this.db.$transaction(async (tx) => {
      await this.lockQuota(tx, now);
      return this.reserveLocked(tx, now);
    });
  }
  private async lockQuota(tx: Prisma.TransactionClient, now: Date) {
    await tx.coachQuota.createMany({ skipDuplicates: true, data: [{
      id: 'gemini-free', nextRequestAt: now, day: '', month: '', dailyCalls: 0, monthlyCalls: 0,
    }] });
    await tx.$queryRaw`SELECT "id" FROM "CoachQuota" WHERE "id" = 'gemini-free' FOR UPDATE`;
  }
  private async reserveLocked(tx: Prisma.TransactionClient, now: Date): Promise<Date | null> {
    const q = await tx.coachQuota.findUniqueOrThrow({ where: { id: 'gemini-free' } });
    if (q.nextRequestAt > now) return q.nextRequestAt;
    const day = now.toISOString().slice(0, 10), month = day.slice(0, 7);
    const dailyCalls = q.day === day ? q.dailyCalls : 0, monthlyCalls = q.month === month ? q.monthlyCalls : 0;
    // Conservative application caps, NOT a claim about Google's allowance.
    // Provider 429s can still impose lower limits. Never switch model/tier.
    const exhaustedUntil = monthlyCalls >= 10_000 ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
      : dailyCalls >= 500 ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)) : null;
    if (exhaustedUntil) {
      await tx.coachQuota.update({ where: { id: 'gemini-free' }, data: { nextRequestAt: exhaustedUntil } });
      return exhaustedUntil;
    }
    await tx.coachQuota.update({ where: { id: 'gemini-free' }, data: { day, month, dailyCalls: dailyCalls + 1, monthlyCalls: monthlyCalls + 1, nextRequestAt: new Date(now.getTime() + 12_000) } });
    return null;
  }
  async pauseQuota(until: Date) {
    await this.db.coachQuota.updateMany({ where: { id: 'gemini-free', nextRequestAt: { lt: until } }, data: { nextRequestAt: until } });
  }
  async nextWake() {
    const rows = await this.db.$queryRaw<{ at: Date | null }[]>`
      WITH active AS (SELECT COUNT(*) AS n, MIN("leaseUntil") AS free_at FROM "CoachReport"
        WHERE "status" = 'PROCESSING' AND "leaseUntil" > NOW()),
      queued AS (SELECT MIN(CASE WHEN "status" = 'PROCESSING' THEN "leaseUntil" ELSE "nextAttemptAt" END) AS ready_at
        FROM "CoachReport" WHERE "status" IN ('PENDING', 'RATE_LIMITED', 'PROCESSING'))
      SELECT CASE WHEN queued.ready_at IS NULL THEN NULL ELSE GREATEST(queued.ready_at,
        (SELECT "nextRequestAt" FROM "CoachQuota" WHERE "id" = 'gemini-free'),
        CASE WHEN active.n >= ${COACH_CONCURRENCY} THEN active.free_at ELSE NULL END) END AS at
      FROM queued, active`;
    return rows[0]?.at ?? null;
  }
}
