import { buildFinalReport, validateBatch, validateNarrative } from './analysis.js';
import { CoachProviderError, coachConfiguration, type CoachProvider } from './gemini.js';
import { CoachRepository } from './repository.js';
import type { RoomRepository } from '../persistence/room-repository.js';
import { ENGINE_VERSION, type CoachHand, type StoredCoachHand } from './types.js';

export function retryDelay(attempt: number, rateLimited = false) {
  return Math.min(rateLimited ? 6 * 60 * 60_000 : 15 * 60_000, (rateLimited ? 60_000 : 10_000) * 2 ** Math.min(attempt, 12));
}

export class CoachService {
  constructor(readonly repository: CoachRepository, readonly rooms: RoomRepository, private readonly provider?: CoachProvider,
    readonly config = coachConfiguration()) {}

  async state(accountId: string, joinId: string) {
    const state = await this.repository.state(accountId, joinId);
    return state ? { ...state, available: this.config.enabled, privacyNotice: 'ליצירת הדוח נשלחים ל־Google רק הקלפים שלך ומצבי החלטה מורשים. במסלול החינמי Google עשויה להשתמש בתוכן לשיפור שירותיה. אין לשלוח מידע אישי נוסף.' } : null;
  }
  request(accountId: string, joinId: string) { return this.repository.request(accountId, joinId, this.config.model); }

  /** One durable checkpoint per run. No DB transaction/connection held during
   * network inference. Request lifetime is independent of the browser tab.
   */
  async runOne(): Promise<{ worked: boolean; retryAt?: Date }> {
    if (!this.config.enabled || !this.provider) return { worked: false };
    const job = await this.repository.claim();
    if (!job) return { worked: false };
    try {
      if (job.engineVersion !== ENGINE_VERSION) {
        await this.repository.defer(job.id, job.token, 'FAILED', 'ENGINE_VERSION_REQUIRES_REVIEW', new Date(Date.now() + 24 * 60 * 60_000));
        return { worked: true };
      }
      if (!await this.repository.state(job.accountId, job.room.joinId)) {
        await this.repository.defer(job.id, job.token, 'FAILED', 'GAME_ACCESS_REVOKED', new Date(Date.now() + 60_000));
        return { worked: true };
      }
      const checkpoints = await this.repository.checkpoints(job.id);
      const done = new Set(checkpoints.filter((c) => c.complete).map((c) => c.handKey));
      const pending = job.manifest.filter((h) => !done.has(h.key));
      if (pending.length === 0) {
        const wait = await this.repository.reserveCall();
        if (wait) { await this.waitForGate(job.id, job.token, wait); return { worked: true, retryAt: wait }; }
        const stored = await this.repository.storedHands(job.id);
        const result = await this.provider.summarize(stored, job.playerId, job.model);
        const narrative = validateNarrative({ ...result.narrative,
          opponents: result.narrative.opponents.map(({ playerId, explanation }) => ({ playerId, explanation })),
        }, stored);
        const report = buildFinalReport(stored, job.identity, narrative, job.model);
        await this.repository.finish(job.id, job.token, report, result);
        return { worked: true };
      }
      const stored: StoredCoachHand[] = [];
      const parts: CoachHand[] = [];
      let remaining = 8;
      for (const next of pending.slice(0, 4)) {
        let saved = await this.repository.loadHand(job.id, next.key);
        if (!saved) {
          const safe = await this.rooms.getHandForAccount(job.accountId, job.room.joinId, next.key, next.number);
          if (!safe?.coach) throw new CoachProviderError('INVALID_OUTPUT');
          saved = { hand: safe.coach, analysis: { handKey: next.key, summary: '', evaluations: [] } };
        }
        const already = new Set(saved.analysis.evaluations.map((e) => e.decisionId));
        const decisions = saved.hand.decisions.filter((d) => !already.has(d.id)).slice(0, remaining);
        stored.push(saved);
        if (!decisions.length) {
          saved.analysis.summary = !saved.hand.dealt ? 'השחקן לא קיבל קלפים ביד זו.' : saved.hand.warnings.length
            ? 'הארכיון חלקי ואין אפשרות להעריך החלטות שלא נשמר להן מצב אמין.'
            : 'לא הייתה החלטה לבחירה ביד זו (למשל אול אין כפוי מהבליינד).';
          continue;
        }
        parts.push({ ...saved.hand, decisions }); remaining -= decisions.length;
        if (remaining === 0) break;
      }
      if (parts.length) {
        const wait = await this.repository.reserveCall();
        if (wait) { await this.waitForGate(job.id, job.token, wait); return { worked: true, retryAt: wait }; }
        const result = await this.provider.analyze(parts, job.model);
        const validated = validateBatch({ hands: result.analyses }, parts);
        for (const analysis of validated) {
          const saved = stored.find((s) => s.hand.key === analysis.handKey)!;
          saved.analysis = { handKey: analysis.handKey, summary: analysis.summary, evaluations: [...saved.analysis.evaluations, ...analysis.evaluations] };
        }
        await this.repository.save(job.id, job.token, stored, result);
      } else await this.repository.save(job.id, job.token, stored, { inputTokens: 0, outputTokens: 0 });
      return { worked: true };
    } catch (error) {
      const kind = error instanceof CoachProviderError ? error.kind : 'TRANSIENT';
      const until = new Date(Date.now() + retryDelay(job.attempts, kind === 'RATE_LIMITED'));
      if (kind === 'RATE_LIMITED') await this.repository.pauseQuota(until);
      const failed = kind === 'CONFIGURATION' || (kind !== 'RATE_LIMITED' && job.attempts >= 3);
      await this.repository.defer(job.id, job.token, failed ? 'FAILED' : kind === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'PENDING', kind, until);
      return { worked: true, retryAt: until };
    }
  }

  async runWindow(milliseconds = 180_000) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline - 65_000) {
      const result = await this.runOne();
      if (!result.worked) break;
      if (result.retryAt) {
        const delay = result.retryAt.getTime() - Date.now();
        if (delay > 15_000 || Date.now() + delay > deadline - 65_000) break;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  private async waitForGate(id: string, token: string, until: Date) {
    const spacing = until.getTime() - Date.now() <= 15_000;
    await this.repository.defer(id, token, spacing ? 'PENDING' : 'RATE_LIMITED', spacing ? 'REQUEST_SPACING' : 'FREE_TIER_WAIT', until, false);
  }
}
