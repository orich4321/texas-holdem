import type { Action, CoachHand, Decision, Street } from './types.js';
import type { ReplayFrame } from '../persistence/hand-history.js';

export function positionFor(seats: readonly { seatNumber: number }[], dealer: number, seat: number): string {
  const clockwise = seats.map((s) => s.seatNumber).sort((a, b) => a - b);
  const dealerIndex = clockwise.indexOf(dealer);
  const offset = (clockwise.indexOf(seat) - dealerIndex + clockwise.length) % clockwise.length;
  if (offset === 0) return clockwise.length === 2 ? 'BTN/SB' : 'BTN';
  if (clockwise.length === 2 || offset === 2) return 'BB';
  if (offset === 1) return 'SB';
  if (offset === clockwise.length - 1) return 'CO';
  if (offset === clockwise.length - 2 && clockwise.length >= 6) return 'HJ';
  return `UTG${offset > 3 ? `+${offset - 3}` : ''}`;
}

type SafeHistory = {
  key: string; board: { rank: string; suit: string }[];
  players: CoachHand['players']; actions: Action[];
  pots: { payouts: { seatNumber: number; amount: number }[]; winnerSeatNumbers: number[] }[];
  uncalledReturns: { seatNumber: number; amount: number }[];
};

/** This function accepts ONLY the existing account-safe projector, plus public
 * monetary frames from HMAC-verified snapshots. Never a deck/settlement JSON.
 * The coach's decision payload deliberately excludes ALL opponent hole cards,
 * including cards eventually shown. No later board/outcome can enter a decision.
 */
export function buildAuthorizedCoachHand(history: SafeHistory, frames: readonly ReplayFrame[], config: { bigBlind: number; dealerSeat: number }, ownPlayerId: string, number: number): CoachHand {
  const ordered = [...frames].sort((a, b) => a.sequence - b.sequence);
  const first = ordered[0];
  const own = history.players.find((s) => s.playerId === ownPlayerId);
  const ownCards = own?.holeCards ?? [null, null];
  const position = own ? positionFor(history.players, config.dealerSeat, own.seatNumber) : 'N/A';
  const decisions: Decision[] = [];
  const actions: CoachHand['actions'] = [];
  for (const eventAction of history.actions) {
    const before = ordered.filter((f) => f.sequence < eventAction.sequence).at(-1);
    if (!before || !['preflop', 'flop', 'turn', 'river'].includes(before.street)) continue;
    const actor = before.seats.find((s) => s.playerId === eventAction.playerId);
    if (!actor) continue;
    const currentBet = before.currentBet ?? Math.max(0, ...before.seats.map((s) => s.currentBet));
    const afterActor = ordered.find((f) => f.sequence === eventAction.sequence)?.seats.find((s) => s.playerId === eventAction.playerId);
    if (!afterActor) continue; // no reliable incremental payment without both verified states
    const paid = Math.round((actor.stack - afterActor.stack) * 10) / 10;
    const target = Math.round((actor.currentBet + paid) * 10) / 10;
    const action: Action = { ...eventAction, amount: Math.max(0, paid),
      type: paid > 0 && paid === actor.stack ? 'all-in' : eventAction.type,
      raiseTo: paid > 0 && target > currentBet ? target : 0 };
    const toCall = Math.round(Math.min(actor.stack, Math.max(0, currentBet - actor.currentBet)) * 10) / 10;
    const street = before.street as Street;
    const canRaise = actor.stack > toCall && !before.raiseLockedSeats?.includes(actor.seatNumber) && before.seats.some((s) => s.playerId !== actor.playerId && !s.isFolded && s.stack > 0);
    const activePlayers = before.seats.filter((s) => !s.isFolded).length;
    actions.push({ ...action, street, pot: before.pot, toCall, canRaise, activePlayers });
    if (action.playerId === ownPlayerId) decisions.push({
      id: `${history.key}:${action.sequence}`, handKey: history.key, playerId: ownPlayerId,
      street, position, board: before.board.map((c) => ({ ...c })), ownCards,
      pot: before.pot, stack: actor.stack, stackBB: actor.stack / config.bigBlind,
      toCall, activePlayers, currentBet, bigBlind: config.bigBlind, canRaise,
      seats: before.seats.map((s) => ({ playerId: s.playerId, seatNumber: s.seatNumber, stack: s.stack, currentBet: s.currentBet, totalCommitted: s.totalCommitted, isFolded: s.isFolded })),
      minRaiseTo: canRaise ? Math.round((currentBet + (before.minimumIncrement ?? config.bigBlind)) * 10) / 10 : null,
      maxRaiseTo: canRaise ? Math.round((actor.currentBet + actor.stack) * 10) / 10 : null,
      priorActions: actions.slice(0, -1).map(({ sequence, playerId, type, amount, raiseTo, street }) => ({ sequence, playerId, type, amount, raiseTo, street })),
      action,
    });
  }
  const ownFirst = first?.seats.find((s) => s.playerId === ownPlayerId);
  const wonAmount = history.pots.flatMap((p) => p.payouts).filter((p) => p.seatNumber === own?.seatNumber).reduce((sum, p) => sum + p.amount, 0);
  const last = ordered.at(-1)?.seats.find((s) => s.playerId === ownPlayerId);
  // Snapshot stack + committed excludes jackpot payouts/rebuys; this is poker
  // decision P&L only. Account-level final P&L is sourced separately from DB.
  const returned = history.uncalledReturns.filter((p) => p.seatNumber === own?.seatNumber).reduce((sum, p) => sum + p.amount, 0);
  const net = ownFirst && last ? Math.round((wonAmount + returned - last.totalCommitted) * 10) / 10 : 0;
  const firstResult = ordered.find((frame) => frame.street === 'showdown');
  const sawFlop = ordered.some((frame) => (frame.street !== 'showdown' || frame === firstResult) && frame.board.length >= 3 && frame.seats.some((s) => s.playerId === ownPlayerId && !s.isFolded));
  const players = history.players.map((p) => {
    const winnings = history.pots.flatMap((pot) => pot.payouts).filter((pay) => pay.seatNumber === p.seatNumber).reduce((sum, pay) => sum + pay.amount, 0);
    const refunds = history.uncalledReturns.filter((pay) => pay.seatNumber === p.seatNumber).reduce((sum, pay) => sum + pay.amount, 0);
    const committed = ordered.at(-1)?.seats.find((s) => s.playerId === p.playerId)?.totalCommitted ?? 0;
    return { ...p, outcome: {
      sawFlop: ordered.some((f) => (f.street !== 'showdown' || f === firstResult) && f.board.length >= 3 && f.seats.some((s) => s.playerId === p.playerId && !s.isFolded)),
      wentToShowdown: !p.folded && history.players.filter((s) => !s.folded).length >= 2,
      won: winnings > 0, net: Math.round((winnings + refunds - committed) * 10) / 10,
    } };
  });
  return {
    key: history.key, number, bigBlind: config.bigBlind, dealerSeat: config.dealerSeat,
    ownPlayerId, position, dealt: Boolean(ownFirst), ownCards,
    players, actions, decisions, board: history.board,
    sawFlop, wentToShowdown: Boolean(own && !own.folded && history.players.filter((s) => !s.folded).length >= 2),
    won: wonAmount > 0, net,
    warnings: !first || !ownFirst ? ['לא חולקו לשחקן קלפים ביד זו; אין החלטות לניתוח.'] : actions.length !== history.actions.length ? ['חלק ממצבי ההחלטה אינם זמינים בארכיון הישן. מדדים התלויים בהם אינם מלאים.'] : [],
  };
}

export function decisionPayload(hand: CoachHand) {
  // Explicit allowlist: neither `players` nor outcome/board-at-result is copied.
  const action = (a: Action) => ({ sequence: a.sequence, playerId: a.playerId, type: a.type, amount: a.amount, raiseTo: a.raiseTo });
  return { handKey: hand.key, number: hand.number, decisions: hand.decisions.map((d) => ({
    id: d.id, handKey: d.handKey, playerId: d.playerId, street: d.street, position: d.position,
    ownCards: d.ownCards.map((c) => c ? { rank: c.rank, suit: c.suit } : null),
    board: d.board.map((c) => ({ rank: c.rank, suit: c.suit })), pot: d.pot, stack: d.stack,
    stackBB: d.stackBB, toCall: d.toCall, activePlayers: d.activePlayers, currentBet: d.currentBet,
    bigBlind: d.bigBlind, canRaise: d.canRaise, action: action(d.action),
    minRaiseTo: d.minRaiseTo, maxRaiseTo: d.maxRaiseTo,
    seats: d.seats.map((s) => ({ playerId: s.playerId, seatNumber: s.seatNumber, stack: s.stack, currentBet: s.currentBet, totalCommitted: s.totalCommitted, isFolded: s.isFolded })),
    priorActions: d.priorActions.map((a) => ({ ...action(a), street: a.street })),
  })) };
}
