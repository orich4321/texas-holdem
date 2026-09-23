import {
  applyFlopAllIn,
  applyFlopCall,
  applyFlopCheck,
  applyFlopFold,
  applyFlopRaise,
  applyPreflopAllIn,
  applyPreflopCall,
  applyPreflopCheck,
  applyPreflopFold,
  applyPreflopRaise,
  applyRiverAllIn,
  applyRiverCall,
  applyRiverCheck,
  applyRiverFold,
  applyRiverRaise,
  applyTurnAllIn,
  applyTurnCall,
  applyTurnCheck,
  applyTurnFold,
  applyTurnRaise,
  advanceFlopToTurn,
  advancePreflopToFlop,
  advanceRiverToShowdown,
  advanceTurnToRiver,
  compareFiveCardHands,
  finishUncontestedHand,
  getFlopLegalActions,
  getPreflopLegalActions,
  getRiverLegalActions,
  getTurnLegalActions,
  runOutAllInToShowdown,
  revealShowdownSeat,
  settleShowdown,
  type Card,
  type ShowdownPot,
} from '@texas-holdem/poker-core/server';
import type { StartedHand } from '../../../packages/poker-core/src/server-recovery.js';

import { startServerHand } from './hand-start.js';
import { isVerifiedPrivateHandRecovery, type VerifiedPrivateHandRecovery } from './persistence/private-hand-snapshot.js';

export interface GameSeatInput {
  seatNumber: number;
  playerId: string;
  playerName: string;
  avatarDataUrl?: string;
  stack: number;
}

export interface ServerGameLifecycleInput {
  seats: readonly GameSeatInput[];
  dealerSeat: number;
  smallBlind: number;
  bigBlind: number;
}

export type PlayerAction =
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'fold' }
  | { type: 'all-in' }
  | { type: 'raise'; raiseTo: number };

export type PlayerActionNotification = Readonly<{
  sequence: number;
  actorPlayerId: string;
  actorPlayerName: string;
  avatarDataUrl?: string;
  action: PlayerAction;
  /** Distinguishes an opening wager from a raise over an existing wager. */
  raiseKind?: 'bet' | 'raise';
  /** Chips called, or the resulting total bet for a raise/all-in. */
  amount?: number;
}>;

type PublicShowdownPot = Readonly<{
  amount: number;
  eligibleSeatNumbers: readonly number[];
  winnerSeatNumbers: readonly number[];
  payouts: readonly Readonly<{ seatNumber: number; amount: number }>[];
}>;

function publicShowdownPot(hand: StartedHand, pot: ShowdownPot): PublicShowdownPot {
  const dealerIndex = hand.seats.findIndex((seat) => seat.seatNumber === hand.dealerSeat);
  if (dealerIndex === -1) throw new Error('Showdown view requires a seated dealer');
  const share = Math.floor(pot.amount / pot.winnerSeatNumbers.length);
  let remainder = pot.amount % pot.winnerSeatNumbers.length;
  const clockwiseWinners = [...pot.winnerSeatNumbers].sort((left, right) => {
    const leftIndex = hand.seats.findIndex((seat) => seat.seatNumber === left);
    const rightIndex = hand.seats.findIndex((seat) => seat.seatNumber === right);
    return ((leftIndex - dealerIndex - 1 + hand.seats.length) % hand.seats.length) - ((rightIndex - dealerIndex - 1 + hand.seats.length) % hand.seats.length);
  });
  const payoutBySeat = new Map(clockwiseWinners.map((seatNumber) => [seatNumber, share + (remainder-- > 0 ? 1 : 0)]));
  return Object.freeze({
    amount: pot.amount,
    eligibleSeatNumbers: Object.freeze([...pot.eligibleSeatNumbers]),
    winnerSeatNumbers: Object.freeze([...pot.winnerSeatNumbers]),
    payouts: Object.freeze(pot.winnerSeatNumbers.map((seatNumber) => Object.freeze({ seatNumber, amount: payoutBySeat.get(seatNumber)! }))),
  });
}

export interface ServerPlayerView {
  /** Durable snapshot sequence used by clients to reject stale delivery. */
  sequence?: number;
  /** Public seat identity of the current host; authority is still checked server-side. */
  hostPlayerId?: string;
  /** True only after the server has durably completed the room's final hand. */
  gameCompleted?: boolean;
  /** The host has released the final summary after everyone saw the last hand. */
  finalSummaryVisible?: boolean;
  /** Membership survives busting; spectators receive no private cards. */
  isSittingOut?: boolean;
  /** Latest durable action, shared identically with every participant. */
  lastAction?: PlayerActionNotification;
  playerId: string;
  street: StartedHand['street'];
  dealerSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  currentActorSeat: number;
  communityCards: readonly Card[];
  pot: number;
  toCall: number;
  /** Present only for the active, authenticated player when a full raise is legal. */
  raise?: Readonly<{
    minRaiseTo: number;
    maxRaiseTo: number;
    minimumIncrement: number;
  }>;
  holeCards: readonly [Card, Card] | readonly [];
  seats: readonly {
    seatNumber: number;
    playerId: string;
    playerName: string;
    avatarDataUrl?: string;
    stack: number;
    currentBet: number;
    isFolded: boolean;
    isSittingOut: boolean;
  }[];
  /** Cards intentionally made public by a showdown or an all-in runout. */
  exposedHands: readonly {
    seatNumber: number;
    playerId: string;
    playerName: string;
    holeCards: readonly [Card, Card];
    reason: 'all-in' | 'winner' | 'voluntary';
  }[];
  allInRunout?: Readonly<{
    nextStreet: 'flop' | 'turn' | 'river' | 'showdown';
  }>;
  showdown?: Readonly<{
    winners: readonly { seatNumber: number; playerId: string; playerName: string; chipsWon: number; winningCards?: readonly Card[] }[];
    pots: readonly PublicShowdownPot[];
    /** Chips above every opponent's matched commitment, returned to their owner. */
    uncalledReturns: readonly { seatNumber: number; amount: number }[];
  }>;
}

function bestFiveCards(cards: readonly Card[]): readonly Card[] {
  if (cards.length !== 7) throw new Error('A winning poker hand requires seven cards');
  let best = cards.slice(0, 5);
  for (let first = 0; first < cards.length - 4; first += 1) {
    for (let second = first + 1; second < cards.length - 3; second += 1) {
      for (let third = second + 1; third < cards.length - 2; third += 1) {
        for (let fourth = third + 1; fourth < cards.length - 1; fourth += 1) {
          for (let fifth = fourth + 1; fifth < cards.length; fifth += 1) {
            const candidate = [cards[first], cards[second], cards[third], cards[fourth], cards[fifth]];
            if (compareFiveCardHands(candidate, best) === 1) best = candidate;
          }
        }
      }
    }
  }
  return Object.freeze(best.map((card) => Object.freeze({ ...card })));
}

/**
 * In-memory authoritative hand coordinator. It deliberately takes neither an
 * RNG nor a client deck: `startServerHand` is the only dealing boundary.
 */
export class ServerGameLifecycle {
  private hand: StartedHand | undefined;
  private readonly namesByPlayerId: ReadonlyMap<string, string>;
  private readonly avatarsByPlayerId: ReadonlyMap<string, string>;
  private readonly playerIdBySeat: ReadonlyMap<number, string>;
  private readonly startInput: Readonly<{
    seats: readonly { seatNumber: number; playerId: string; stack: number }[];
    dealerSeat: number;
    smallBlind: number;
    bigBlind: number;
  }>;

  /**
   * Installs a hand only after the repository has verified its context-bound
   * signed envelope. It never deals, shuffles, or accepts client state.
   */
  static fromVerifiedRecoveredHand(input: ServerGameLifecycleInput, recovery: VerifiedPrivateHandRecovery): ServerGameLifecycle {
    const lifecycle = new ServerGameLifecycle(input);
    if (!isVerifiedPrivateHandRecovery(recovery)) throw new Error('Recovered hand must be verified by the private snapshot boundary');
    const hand = recovery.hand;
    if (!hand || !Array.isArray(hand.seats) || hand.seats.length !== lifecycle.playerIdBySeat.size) {
      throw new Error('Recovered hand does not match the persisted game seats');
    }
    for (const seat of hand.seats) {
      if (lifecycle.playerIdBySeat.get(seat.seatNumber) !== seat.playerId) {
        throw new Error('Recovered hand does not match the persisted game seats');
      }
    }
    lifecycle.hand = hand;
    return lifecycle;
  }

  constructor(input: ServerGameLifecycleInput) {
    if (!input || !Array.isArray(input.seats) || input.seats.length < 2 || input.seats.length > 9) {
      throw new Error('A server game requires between two and nine seats');
    }
    const names = new Map<string, string>();
    const avatars = new Map<string, string>();
    const playerIds = new Map<number, string>();
    for (const seat of input.seats) {
      if (!seat || typeof seat.playerId !== 'string' || seat.playerId.length === 0 || typeof seat.playerName !== 'string' || seat.playerName.length === 0 || names.has(seat.playerId) || playerIds.has(seat.seatNumber)) {
        throw new Error('Server game seats must have unique player IDs, seats, and names');
      }
      names.set(seat.playerId, seat.playerName);
      if (seat.avatarDataUrl) avatars.set(seat.playerId, seat.avatarDataUrl);
      playerIds.set(seat.seatNumber, seat.playerId);
    }
    this.namesByPlayerId = names;
    this.avatarsByPlayerId = avatars;
    this.playerIdBySeat = playerIds;
    this.startInput = Object.freeze({
      seats: Object.freeze(input.seats.map(({ seatNumber, playerId, stack }) => Object.freeze({ seatNumber, playerId, stack }))),
      dealerSeat: input.dealerSeat,
      smallBlind: input.smallBlind,
      bigBlind: input.bigBlind,
    });
  }

  start(): ServerPlayerView {
    if (this.hand) throw new Error('Game has already started');
    this.hand = startServerHand(this.startInput);
    return this.viewFor(this.playerIdBySeat.get(this.hand.currentActorSeat)!);
  }

  currentActorPlayerId(): string {
    const hand = this.requireHand();
    const playerId = this.playerIdBySeat.get(hand.currentActorSeat);
    if (!playerId) throw new Error('Authoritative hand has an unknown active seat');
    return playerId;
  }

  viewFor(playerId: string): ServerPlayerView {
    const hand = this.requireHand();
    const requestingSeat = hand.seats.find((seat) => seat.playerId === playerId);
    if (!requestingSeat?.holeCards) throw new Error('Player is not seated in this game');
    const allInRunout = this.allInRunoutNextStreet(hand);
    const legalActions = hand.street === 'showdown' || allInRunout || hand.currentActorSeat !== requestingSeat.seatNumber
      ? undefined
      : this.legalActions(hand);
    const toCall = legalActions?.toCall ?? 0;
    const showdown = hand.street === 'showdown' ? this.showdownResult(hand) : undefined;
    const settledStacks = showdown
      ? new Map(showdown.seats.map((seat) => [seat.seatNumber, seat.stack]))
      : undefined;
    const contestingSeats = hand.seats.filter((seat) => seat.holeCards && !seat.isFolded);
    const allInShowdown = hand.street === 'showdown'
      && hand.communityCards.length === 5
      && contestingSeats.length >= 2
      && contestingSeats.every((seat) => seat.stack === 0);
    const winnerSeatNumbers = new Set(
      showdown && contestingSeats.length >= 2 && hand.communityCards.length === 5
        ? showdown.pots.flatMap((pot) => pot.winnerSeatNumbers)
        : [],
    );
    const voluntarilyRevealed = new Set(hand.revealedSeatNumbers);
    const exposedHands = Object.freeze(hand.seats.flatMap((seat) => {
      if (!seat.holeCards) return [];
      let reason: 'all-in' | 'winner' | 'voluntary' | undefined;
      if (voluntarilyRevealed.has(seat.seatNumber)) reason = 'voluntary';
      else if (!seat.isFolded && (allInRunout || allInShowdown)) reason = 'all-in';
      else if (!seat.isFolded && winnerSeatNumbers.has(seat.seatNumber)) reason = 'winner';
      if (!reason) return [];
      return [Object.freeze({
        seatNumber: seat.seatNumber,
        playerId: seat.playerId,
        playerName: this.namesByPlayerId.get(seat.playerId)!,
        holeCards: Object.freeze(seat.holeCards.map((card) => Object.freeze({ ...card }))) as unknown as readonly [Card, Card],
        reason,
      })];
    }));
    return Object.freeze({
      playerId,
      street: hand.street,
      dealerSeat: hand.dealerSeat,
      smallBlindSeat: hand.smallBlindSeat,
      bigBlindSeat: hand.bigBlindSeat,
      currentActorSeat: hand.currentActorSeat,
      communityCards: Object.freeze(hand.communityCards.map((card) => Object.freeze({ ...card }))),
      // Once settlement has happened there are no chips left in the live pot.
      // The individual awarded pots remain available in `showdown.pots`.
      pot: showdown ? 0 : hand.pot,
      toCall,
      ...(legalActions?.canRaise && legalActions.minRaiseTo !== null && legalActions.maxRaiseTo !== null ? {
        raise: Object.freeze({
          minRaiseTo: legalActions.minRaiseTo,
          maxRaiseTo: legalActions.maxRaiseTo,
          minimumIncrement: hand.minimumRaiseIncrement,
        }),
      } : {}),
      holeCards: Object.freeze(requestingSeat.holeCards.map((card) => Object.freeze({ ...card }))) as unknown as readonly [Card, Card],
      seats: Object.freeze(hand.seats.map((seat) => Object.freeze({
        seatNumber: seat.seatNumber,
        playerId: seat.playerId,
        playerName: this.namesByPlayerId.get(seat.playerId)!,
        ...(this.avatarsByPlayerId.get(seat.playerId) ? { avatarDataUrl: this.avatarsByPlayerId.get(seat.playerId) } : {}),
        stack: settledStacks?.get(seat.seatNumber) ?? seat.stack,
        currentBet: seat.currentBet,
        isFolded: seat.isFolded === true,
        isSittingOut: false,
      }))),
      exposedHands,
      ...(allInRunout ? { allInRunout: Object.freeze({ nextStreet: allInRunout }) } : {}),
      ...(showdown ? {
        showdown: Object.freeze({
          winners: Object.freeze(
            hand.seats
              .filter((seat) => showdown.pots.some((pot) => pot.winnerSeatNumbers.includes(seat.seatNumber)))
              .map((seat) => Object.freeze({
                seatNumber: seat.seatNumber,
                playerId: seat.playerId,
                playerName: this.namesByPlayerId.get(seat.playerId)!,
                chipsWon: showdown.seats.find((settledSeat) => settledSeat.seatNumber === seat.seatNumber)!.stack - seat.stack,
                ...(contestingSeats.length >= 2 && hand.communityCards.length === 5 && seat.holeCards
                  ? { winningCards: bestFiveCards([...seat.holeCards, ...hand.communityCards]) }
                  : {}),
              })),
          ),
          pots: Object.freeze(showdown.pots.map((pot) => publicShowdownPot(hand, pot))),
          uncalledReturns: Object.freeze(showdown.uncalledReturns.map((returned) => Object.freeze({ ...returned }))),
        }),
      } : {}),
    });
  }

  /** Computes the authoritative payout only after a terminal showdown. */
  showdownSettlement() {
    const hand = this.requireHand();
    if (hand.street !== 'showdown') throw new Error('Hand has not reached showdown');
    return this.showdownResult(hand);
  }

  applyAction(playerId: string, action: PlayerAction): ServerPlayerView {
    const hand = this.requireHand();
    if (this.allInRunoutNextStreet(hand)) throw new Error('The host must advance the all-in board');
    if (this.currentActorPlayerId() !== playerId) throw new Error('Only the active player may act');
    this.validateAction(action);
    const actorSeat = hand.currentActorSeat;
    this.hand = this.advanceIfSettled(this.apply(hand, actorSeat, action));
    return this.viewFor(playerId);
  }

  /** Host-only repository callers use this to reveal exactly one all-in street. */
  advanceAllInRunout(): void {
    const hand = this.requireHand();
    if (!this.allInRunoutNextStreet(hand)) throw new Error('An all-in board is not ready to advance');
    this.hand = hand.street === 'preflop'
      ? advancePreflopToFlop(hand)
      : hand.street === 'flop'
        ? advanceFlopToTurn(hand)
        : hand.street === 'turn'
          ? advanceTurnToRiver(hand)
          : runOutAllInToShowdown(hand);
  }

  /** Any player dealt into the completed hand may voluntarily make their own cards public. */
  revealShowdownHand(playerId: string): ServerPlayerView {
    const hand = this.requireHand();
    const seat = hand.seats.find((candidate) => candidate.playerId === playerId);
    if (!seat) throw new Error('Player is not seated in this game');
    this.hand = revealShowdownSeat(hand, seat.seatNumber);
    return this.viewFor(playerId);
  }

  /** Server-only persistence boundary; callers must sign before storing this state. */
  handForDurableSnapshot(): StartedHand {
    return this.requireHand();
  }

  private requireHand(): StartedHand {
    if (!this.hand) throw new Error('Game has not started');
    return this.hand;
  }

  private showdownResult(hand: StartedHand) {
    return settleShowdown(hand);
  }

  private legalActions(hand: StartedHand) {
    if (hand.street === 'preflop') return getPreflopLegalActions(hand);
    if (hand.street === 'flop') return getFlopLegalActions(hand);
    if (hand.street === 'turn') return getTurnLegalActions(hand);
    if (hand.street === 'river') return getRiverLegalActions(hand);
    throw new Error('Showdown has no player actions');
  }

  private validateAction(action: PlayerAction): void {
    if (!action || typeof action !== 'object' || !['check', 'call', 'fold', 'all-in', 'raise'].includes(action.type)) throw new Error('Unsupported player action');
    if (action.type === 'raise' && (!Number.isSafeInteger(action.raiseTo) || action.raiseTo < 0)) throw new Error('Raise target must be a non-negative safe integer');
  }

  private apply(hand: StartedHand, actorSeat: number, action: PlayerAction): StartedHand {
    const actions = hand.street === 'preflop'
      ? { check: applyPreflopCheck, call: applyPreflopCall, fold: applyPreflopFold, raise: applyPreflopRaise, allIn: applyPreflopAllIn }
      : hand.street === 'flop'
        ? { check: applyFlopCheck, call: applyFlopCall, fold: applyFlopFold, raise: applyFlopRaise, allIn: applyFlopAllIn }
        : hand.street === 'turn'
          ? { check: applyTurnCheck, call: applyTurnCall, fold: applyTurnFold, raise: applyTurnRaise, allIn: applyTurnAllIn }
          : hand.street === 'river'
            ? { check: applyRiverCheck, call: applyRiverCall, fold: applyRiverFold, raise: applyRiverRaise, allIn: applyRiverAllIn }
            : undefined;
    if (!actions) throw new Error('Showdown has no player actions');
    if (action.type === 'check') return actions.check(hand, actorSeat);
    if (action.type === 'call') return actions.call(hand, actorSeat);
    if (action.type === 'fold') return actions.fold(hand, actorSeat);
    if (action.type === 'all-in') return actions.allIn(hand, actorSeat);
    return actions.raise(hand, actorSeat, action.raiseTo);
  }

  /** Advances a completed betting round before emitting any player-facing view. */
  private advanceIfSettled(hand: StartedHand): StartedHand {
    if (hand.street === 'showdown') return hand;
    const contestingSeats = hand.seats.filter((seat) => seat.holeCards && !seat.isFolded);
    if (contestingSeats.length === 1) return finishUncontestedHand(hand);
    if (hand.pendingActorSeats.length > 0) return hand;
    if (this.allInRunoutNextStreet(hand)) return hand;
    if (hand.street === 'preflop') return this.advanceIfSettled(advancePreflopToFlop(hand));
    if (hand.street === 'flop') return advanceFlopToTurn(hand);
    if (hand.street === 'turn') return advanceTurnToRiver(hand);
    return advanceRiverToShowdown(hand);
  }

  private allInRunoutNextStreet(hand: StartedHand): 'flop' | 'turn' | 'river' | 'showdown' | undefined {
    if (hand.street === 'showdown' || hand.pendingActorSeats.length > 0) return undefined;
    const contestingSeats = hand.seats.filter((seat) => seat.holeCards && !seat.isFolded);
    if (contestingSeats.length < 2 || !contestingSeats.every((seat) => seat.stack === 0)) return undefined;
    if (hand.street === 'preflop') return 'flop';
    if (hand.street === 'flop') return 'turn';
    if (hand.street === 'turn') return 'river';
    return 'showdown';
  }
}
