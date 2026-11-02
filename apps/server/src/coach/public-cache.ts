import type { ReplayFrame } from '../persistence/hand-history.js';

type Event = { sequence: number; type: string; payload: unknown; createdAt: Date };
export type PublicCoachCache = {
  frames: ReplayFrame[]; config: { bigBlind: number; dealerSeat: number };
  events: { sequence: number; type: string; payload: Record<string, unknown>; createdAt: string }[];
};
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }

/** Explicitly rebuild fields. Do not replace with `{...snapshot}` / `{...payload}`. */
export function publicCoachCache(frames: readonly ReplayFrame[], config: PublicCoachCache['config'], events: readonly Event[]): PublicCoachCache {
  return {
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
}
