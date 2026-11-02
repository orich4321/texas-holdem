import type { Prisma } from '@prisma/client';
import type { StartedHand } from '@texas-holdem/poker-core/server';
import { chipUnits } from '../chip-amounts.js';

export const JACKPOT_ID = 'seven-deuce-offsuit';
export type JackpotPayment = { playerId: string; amount: number };
export type HandJackpot = { contributionPerPlayer: number; contributions: JackpotPayment[]; payouts: JackpotPayment[] };

export function isSevenDeuceOffsuit(cards: StartedHand['seats'][number]['holeCards']): boolean {
  return Boolean(cards && cards[0].suit !== cards[1].suit
    && ((cards[0].rank === '2' && cards[1].rank === '7') || (cards[0].rank === '7' && cards[1].rank === '2')));
}

export function jackpotWinners(hand: StartedHand, pots: readonly { winnerSeatNumbers: readonly number[] }[]) {
  const winners = new Set(pots.flatMap((pot) => pot.winnerSeatNumbers));
  const dealer = hand.seats.findIndex((seat) => seat.seatNumber === hand.dealerSeat);
  // Standard clockwise odd-chip priority, starting to the left of the dealer.
  return Array.from({ length: hand.seats.length }, (_, index) => hand.seats[(dealer + index + 1) % hand.seats.length])
    .filter((seat) => !seat.isFolded && winners.has(seat.seatNumber) && isSevenDeuceOffsuit(seat.holeCards));
}

/** Caller already holds its room lock. Every global operation takes the pool lock next. */
export async function contributeJackpot(tx: Prisma.TransactionClient, roomId: string, handSequence: number, players: readonly { id: string; currentStack: number }[]) {
  if (players.length < 2 || players.some((player) => chipUnits(player.currentStack) <= 1)) throw new Error('Not enough chips to deal');
  await tx.jackpotPool.update({ where: { id: JACKPOT_ID }, data: { balanceUnits: { increment: players.length } } });
  await tx.jackpotHand.create({ data: { roomId, handSequence,
    contributions: players.map((player) => ({ playerId: player.id, amountUnits: 1 })), payouts: [],
  } });
  for (const player of players) {
    await tx.player.update({ where: { id: player.id }, data: { currentStack: (chipUnits(player.currentStack) - 1) / 10 } });
  }
  return players.map((player) => ({ ...player, currentStack: (chipUnits(player.currentStack) - 1) / 10 }));
}

/** Called in the very same transaction as poker settlement, including fold wins and side pots. */
export async function settleJackpot(tx: Prisma.TransactionClient, roomId: string, sequence: number, hand: StartedHand, pots: readonly { winnerSeatNumbers: readonly number[] }[]): Promise<HandJackpot | undefined> {
  if (hand.street !== 'showdown') throw new Error('Jackpot requires a completed hand');
  const round = await tx.jackpotHand.findFirst({ where: { roomId, handSequence: { lte: sequence } }, orderBy: { handSequence: 'desc' } });
  if (!round) return undefined; // Pre-feature hands remain in their original chip denomination.
  if (round.settledAt) throw new Error('Jackpot hand is already settled');
  const winners = jackpotWinners(hand, pots);
  const payouts: { playerId: string; amountUnits: number }[] = [];
  if (winners.length) {
    // UPDATE obtains a cross-room PostgreSQL row lock; the next winner sees the reset balance.
    const pool = await tx.jackpotPool.update({ where: { id: JACKPOT_ID }, data: { balanceUnits: { increment: 0 } }, select: { balanceUnits: true } });
    const share = Math.floor(pool.balanceUnits / winners.length);
    const remainder = pool.balanceUnits % winners.length;
    payouts.push(...winners.map((seat, index) => ({ playerId: seat.playerId, amountUnits: share + (index < remainder ? 1 : 0) })));
    await tx.jackpotPool.update({ where: { id: JACKPOT_ID }, data: { balanceUnits: 0 } });
  }
  const settled = await tx.jackpotHand.update({ where: { roomId_handSequence: { roomId, handSequence: round.handSequence } }, data: { settledAt: new Date(), payouts } });
  return publicHandJackpot(settled);
}

export function publicHandJackpot(round: { contributions: unknown; payouts: unknown }): HandJackpot {
  const payments = (value: unknown): JackpotPayment[] => (Array.isArray(value) ? value : []).map((entry: { playerId: string; amountUnits: number }) => ({ playerId: entry.playerId, amount: entry.amountUnits / 10 }));
  return { contributionPerPlayer: 0.1, contributions: payments(round.contributions), payouts: payments(round.payouts) };
}

export async function readHandJackpot(tx: Prisma.TransactionClient, roomId: string, sequence: number) {
  const round = await tx.jackpotHand.findFirst({ where: { roomId, handSequence: { lte: sequence } }, orderBy: { handSequence: 'desc' }, select: { contributions: true, payouts: true } });
  return round ? publicHandJackpot(round) : undefined;
}
