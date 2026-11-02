import { projectHandHistory, type ReplayFrame } from '../persistence/hand-history.js';
import { prepareCoachActions } from './authorized-data.js';
import type { CoachHand } from './types.js';
import { gzipSync, gunzipSync } from 'node:zlib';

export const PUBLIC_COACH_CACHE_VERSION = 2;

type Event = { sequence: number; type: string; payload: unknown; createdAt: Date };
export type PublicCoachCache = {
  version: number; sourceVersion: string;
  frames: ReplayFrame[]; config: { bigBlind: number; dealerSeat: number };
  events: { sequence: number; type: string; payload: Record<string, unknown>; createdAt: string }[];
  actions: CoachHand['actions'];
};
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }

/** Explicitly rebuild fields. Do not replace with `{...snapshot}` / `{...payload}`. */
export function publicCoachCache(frames: readonly ReplayFrame[], config: PublicCoachCache['config'], events: readonly Event[], sourceVersion = ''): PublicCoachCache {
  const publicData = {
    version: PUBLIC_COACH_CACHE_VERSION, sourceVersion,
    config: { bigBlind: config.bigBlind, dealerSeat: config.dealerSeat },
    frames: frames.map((f) => ({ sequence: f.sequence, street: f.street, board: f.board.map((c) => ({ rank: c.rank, suit: c.suit })), pot: f.pot,
      currentBet: f.currentBet, minimumIncrement: f.minimumIncrement, raiseLockedSeats: f.raiseLockedSeats?.map(Number),
      seats: f.seats.map((s) => ({ playerId: s.playerId, seatNumber: s.seatNumber, stack: s.stack, currentBet: s.currentBet, totalCommitted: s.totalCommitted, isFolded: s.isFolded })) })),
    events: events.map((e) => {
      const p = object(e.payload), a = object(p.action);
      return { sequence: e.sequence, type: e.type, createdAt: e.createdAt.toISOString(), payload: {
        ...(typeof p.actorPlayerId === 'string' ? { actorPlayerId: p.actorPlayerId } : {}),
        ...(typeof p.playerId === 'string' ? { playerId: p.playerId } : {}),
        ...(p.cardIndex === 0 || p.cardIndex === 1 ? { cardIndex: p.cardIndex } : {}),
        ...(typeof p.amount === 'number' ? { amount: p.amount } : {}),
        ...(typeof a.type === 'string' ? { action: { type: a.type, ...(typeof a.raiseTo === 'number' ? { raiseTo: a.raiseTo } : {}) } } : {}),
      } };
    }),
  };
  const safeEvents = publicData.events.map((e) => ({ ...e, createdAt: new Date(e.createdAt) }));
  return { ...publicData, actions: prepareCoachActions(projectHandHistory({}, new Set(), safeEvents).actions, publicData.frames) };
}

// JSONB otherwise transfers the same repeated seat/frame geometry over the
// pooler for every cold replica. Only the already-sanitized public data is packed.
export function packPublicCoachCache(data: PublicCoachCache) {
  return { version: PUBLIC_COACH_CACHE_VERSION, sourceVersion: data.sourceVersion, encoding: 'gzip-base64',
    payload: gzipSync(JSON.stringify(data)).toString('base64') };
}
export function unpackPublicCoachCache(value: unknown, sourceVersion: string): PublicCoachCache | null {
  const envelope = object(value);
  if (envelope.version !== PUBLIC_COACH_CACHE_VERSION || envelope.sourceVersion !== sourceVersion
    || envelope.encoding !== 'gzip-base64' || typeof envelope.payload !== 'string' || envelope.payload.length > 6 * 1024 * 1024) return null;
  try {
    const data = JSON.parse(gunzipSync(Buffer.from(envelope.payload, 'base64'), { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8')) as PublicCoachCache;
    return data.version === PUBLIC_COACH_CACHE_VERSION && data.sourceVersion === sourceVersion
      && Array.isArray(data.frames) && Array.isArray(data.events) && Array.isArray(data.actions) && data.config?.bigBlind > 0 ? data : null;
  } catch { return null; } // Corrupt/obsolete cache rebuilds from verified history.
}

/** Only card-free public data belongs here. Authorization is checked BEFORE
 * every lookup. Bounded bytes/entries/TTL; failed loads are never cached. */
export class SharedCoachCache {
  private readonly entries = new Map<string, { data: PublicCoachCache; bytes: number; until: number }>();
  private readonly loading = new Map<string, Promise<PublicCoachCache>>();
  private bytes = 0;
  constructor(private readonly maxBytes = 4 * 1024 * 1024, private readonly maxEntries = 64, private readonly ttlMs = 5 * 60_000) {}

  async get(key: string, load: () => Promise<PublicCoachCache>): Promise<PublicCoachCache> {
    const cached = this.entries.get(key);
    if (cached && cached.until > Date.now()) {
      this.entries.delete(key); this.entries.set(key, cached);
      return structuredClone(cached.data);
    }
    if (cached) { this.entries.delete(key); this.bytes -= cached.bytes; }
    let task = this.loading.get(key);
    if (!task) {
      task = load().then((data) => {
        const bytes = Buffer.byteLength(JSON.stringify(data));
        if (bytes <= this.maxBytes) {
          while (this.entries.size && (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes)) {
            const first = this.entries.keys().next().value!;
            this.bytes -= this.entries.get(first)!.bytes; this.entries.delete(first);
          }
          this.entries.set(key, { data, bytes, until: Date.now() + this.ttlMs }); this.bytes += bytes;
        }
        return data;
      }).finally(() => { this.loading.delete(key); });
      this.loading.set(key, task);
    }
    return structuredClone(await task);
  }
}
