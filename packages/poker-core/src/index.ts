export const pokerCorePackage = '@texas-holdem/poker-core';

export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';
export type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades';

export interface Card {
  rank: Rank;
  suit: Suit;
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
