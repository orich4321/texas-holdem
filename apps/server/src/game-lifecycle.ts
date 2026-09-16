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
  getFlopLegalActions,
  getPreflopLegalActions,
  getRiverLegalActions,
  getTurnLegalActions,
  runOutAllInToShowdown,
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

export interface ServerPlayerView {
  playerId: string;
  street: StartedHand['street'];
  dealerSeat: number;
  currentActorSeat: number;
  communityCards: readonly Card[];
  pot: number;
  toCall: number;
  holeCards: readonly [Card, Card];
  seats: readonly {
    seatNumber: number;
    playerId: string;
    playerName: string;
    stack: number;
    currentBet: number;
    isFolded: boolean;
  }[];
  showdown?: Readonly<{
    winners: readonly { seatNumber: number; playerId: string; playerName: string; chipsWon: number }[];
    pots: readonly Pick<ShowdownPot, 'amount' | 'winnerSeatNumbers'>[];
  }>;
}

/**
 * In-memory authoritative hand coordinator. It deliberately takes neither an
 * RNG nor a client deck: `startServerHand` is the only dealing boundary.
 */
export class ServerGameLifecycle {
  private hand: StartedHand | undefined;
  private readonly namesByPlayerId: ReadonlyMap<string, string>;
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
    const playerIds = new Map<number, string>();
    for (const seat of input.seats) {
      if (!seat || typeof seat.playerId !== 'string' || seat.playerId.length === 0 || typeof seat.playerName !== 'string' || seat.playerName.length === 0 || names.has(seat.playerId) || playerIds.has(seat.seatNumber)) {
        throw new Error('Server game seats must have unique player IDs, seats, and names');
      }
      names.set(seat.playerId, seat.playerName);
      playerIds.set(seat.seatNumber, seat.playerId);
    }
    this.namesByPlayerId = names;
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
    const toCall = hand.street === 'showdown' ? 0 : this.legalActions(hand).toCall;
    const showdown = hand.street === 'showdown' ? this.showdownResult(hand) : undefined;
    const settledStacks = showdown
      ? new Map(showdown.seats.map((seat) => [seat.seatNumber, seat.stack]))
      : undefined;
    return Object.freeze({
      playerId,
      street: hand.street,
      dealerSeat: hand.dealerSeat,
      currentActorSeat: hand.currentActorSeat,
      communityCards: Object.freeze(hand.communityCards.map((card) => Object.freeze({ ...card }))),
      pot: hand.pot,
      toCall: hand.currentActorSeat === requestingSeat.seatNumber ? toCall : 0,
      holeCards: Object.freeze(requestingSeat.holeCards.map((card) => Object.freeze({ ...card }))) as unknown as readonly [Card, Card],
      seats: Object.freeze(hand.seats.map((seat) => Object.freeze({
        seatNumber: seat.seatNumber,
        playerId: seat.playerId,
        playerName: this.namesByPlayerId.get(seat.playerId)!,
        stack: settledStacks?.get(seat.seatNumber) ?? seat.stack,
        currentBet: seat.currentBet,
        isFolded: seat.isFolded === true,
      }))),
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
              })),
          ),
          pots: Object.freeze(showdown.pots.map((pot) => Object.freeze({
            amount: pot.amount,
            winnerSeatNumbers: Object.freeze([...pot.winnerSeatNumbers]),
          }))),
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
    if (this.currentActorPlayerId() !== playerId) throw new Error('Only the active player may act');
    this.validateAction(action);
    const actorSeat = hand.currentActorSeat;
    this.hand = this.advanceIfSettled(this.apply(hand, actorSeat, action));
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
    if (hand.pendingActorSeats.length > 0 || hand.street === 'showdown') return hand;
    if (hand.street === 'preflop') return this.advanceIfSettled(advancePreflopToFlop(hand));
    const contestingSeats = hand.seats.filter((seat) => seat.holeCards && !seat.isFolded);
    if (contestingSeats.length >= 2 && contestingSeats.every((seat) => seat.stack === 0)) {
      return runOutAllInToShowdown(hand);
    }
    if (hand.street === 'flop') return advanceFlopToTurn(hand);
    if (hand.street === 'turn') return advanceTurnToRiver(hand);
    return advanceRiverToShowdown(hand);
  }
}
