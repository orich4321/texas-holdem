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
  type Card,
  type StartedHand,
} from '@texas-holdem/poker-core';

import { startServerHand } from './hand-start.js';

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

  constructor(input: ServerGameLifecycleInput) {
    if (!input || !Array.isArray(input.seats) || input.seats.length < 2 || input.seats.length > 3) {
      throw new Error('A server game requires two or three seats');
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
        stack: seat.stack,
        currentBet: seat.currentBet,
        isFolded: seat.isFolded === true,
      }))),
    });
  }

  applyAction(playerId: string, action: PlayerAction): ServerPlayerView {
    const hand = this.requireHand();
    if (this.currentActorPlayerId() !== playerId) throw new Error('Only the active player may act');
    this.validateAction(action);
    const actorSeat = hand.currentActorSeat;
    this.hand = this.advanceIfSettled(this.apply(hand, actorSeat, action));
    return this.viewFor(playerId);
  }

  private requireHand(): StartedHand {
    if (!this.hand) throw new Error('Game has not started');
    return this.hand;
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
