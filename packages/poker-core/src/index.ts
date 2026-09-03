export const pokerCorePackage = '@texas-holdem/poker-core';

export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';
export type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades';

export interface Card {
  rank: Rank;
  suit: Suit;
}

const ranks: readonly Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const suits: readonly Suit[] = ['clubs', 'diamonds', 'hearts', 'spades'];

export type RandomInt = (maxExclusive: number) => number;

export class Deck {
  private readonly cards: Card[];

  constructor() {
    this.cards = [];
    for (const suit of suits) {
      for (const rank of ranks) {
        this.cards.push({ rank, suit });
      }
    }
  }

  get remaining(): number {
    return this.cards.length;
  }

  shuffle(randomInt: RandomInt): void {
    const swapIndexes: number[] = [];

    for (let currentIndex = this.cards.length - 1; currentIndex > 0; currentIndex -= 1) {
      const maxExclusive = currentIndex + 1;
      const swapIndex = randomInt(maxExclusive);
      if (swapIndex < 0 || swapIndex >= maxExclusive || swapIndex !== Math.floor(swapIndex)) {
        throw new Error(`randomInt must return an integer from 0 to ${maxExclusive - 1}`);
      }
      swapIndexes.push(swapIndex);
    }

    for (let currentIndex = this.cards.length - 1, index = 0; currentIndex > 0; currentIndex -= 1, index += 1) {
      const swapIndex = swapIndexes[index];
      const card = this.cards[currentIndex];
      this.cards[currentIndex] = this.cards[swapIndex];
      this.cards[swapIndex] = card;
    }
  }

  deal(): Card;
  deal(count: number): Card[];
  deal(count = 1): Card | Card[] {
    if (count < 1 || count !== Math.floor(count)) {
      throw new Error('Deal count must be a positive integer');
    }
    if (count > this.cards.length) {
      throw new Error(`Cannot deal ${count} cards: only ${this.cards.length} remaining`);
    }
    const dealt = this.cards.splice(0, count);
    return count === 1 ? dealt[0] : dealt;
  }
}

export interface Player {
  id: string;
  name: string;
}

export interface Seat {
  seatNumber: number;
  player: Player;
  stack: number;
  currentBet: number;
  isFolded: boolean;
  holeCards: [Card, Card];
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';

export interface TableState {
  tableId: string;
  dealerSeat: number;
  street: Street;
  communityCards: Card[];
  pot: number;
  seats: Seat[];
}

export interface PlayerSeatView {
  seatNumber: number;
  player: Player;
  stack: number;
  currentBet: number;
  isFolded: boolean;
}

export interface PlayerView {
  tableId: string;
  dealerSeat: number;
  street: Street;
  communityCards: Card[];
  pot: number;
  seats: PlayerSeatView[];
  playerId: string;
  holeCards: [Card, Card];
}

export function toPlayerView(state: TableState, playerId: string): PlayerView {
  let requestingSeat: Seat | undefined;

  for (const seat of state.seats) {
    if (seat.player.id === playerId) {
      requestingSeat = seat;
      break;
    }
  }

  if (!requestingSeat) {
    throw new Error(`Player "${playerId}" is not seated at table "${state.tableId}"`);
  }

  return {
    tableId: state.tableId,
    dealerSeat: state.dealerSeat,
    street: state.street,
    communityCards: state.communityCards.map((card) => ({ ...card })),
    pot: state.pot,
    seats: state.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      player: { ...seat.player },
      stack: seat.stack,
      currentBet: seat.currentBet,
      isFolded: seat.isFolded,
    })),
    playerId,
    holeCards: [
      { ...requestingSeat.holeCards[0] },
      { ...requestingSeat.holeCards[1] },
    ],
  };
}
