export const pokerCorePackage = '@texas-holdem/poker-core';

export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';
export type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades';

export interface Card {
  rank: Rank;
  suit: Suit;
}

export type FiveCardHandCategory = 'high-card' | 'one-pair' | 'two-pair';

export interface FiveCardHandEvaluation {
  category: FiveCardHandCategory;
  tieBreakRanks: readonly Rank[];
}

const ranks: readonly Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const suits: readonly Suit[] = ['clubs', 'diamonds', 'hearts', 'spades'];
const rankValues = new Map(ranks.map((rank, index) => [rank, index + 2]));

function rankValue(rank: Rank): number {
  return rankValues.get(rank)!;
}

function compareRanksDescending(left: Rank, right: Rank): number {
  return rankValue(right) - rankValue(left);
}

function isStraight(uniqueRanks: readonly Rank[]): boolean {
  if (uniqueRanks.length !== 5) {
    return false;
  }

  const values = uniqueRanks.map(rankValue).sort((left, right) => left - right);
  const isWheel = values.join(',') === '2,3,4,5,14';
  return isWheel || values.every((value, index) => index === 0 || value === values[index - 1] + 1);
}

function compareTieBreakRanks(left: readonly Rank[], right: readonly Rank[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = rankValue(left[index]) - rankValue(right[index]);
    if (difference !== 0) {
      return difference > 0 ? 1 : -1;
    }
  }
  return 0;
}

/** Evaluates exactly five distinct cards in the deliberately narrow supported categories. */
export function evaluateFiveCardHand(cards: readonly Card[]): FiveCardHandEvaluation {
  if (cards.length !== 5) {
    throw new Error('A five-card hand must contain exactly five cards');
  }

  for (const card of cards) {
    if (!card || typeof card !== 'object') {
      throw new Error('Invalid card');
    }
    if (!rankValues.has(card.rank)) {
      throw new Error('Invalid card rank');
    }
    if (!suits.includes(card.suit)) {
      throw new Error('Invalid card suit');
    }
  }

  const physicalCards = new Set(cards.map((card) => `${card.rank}-${card.suit}`));
  if (physicalCards.size !== cards.length) {
    throw new Error('A five-card hand cannot contain a duplicate physical card');
  }

  const ranksByFrequency = new Map<Rank, number>();
  for (const card of cards) {
    ranksByFrequency.set(card.rank, (ranksByFrequency.get(card.rank) ?? 0) + 1);
  }

  const ranksDescending = [...ranksByFrequency.keys()].sort(compareRanksDescending);
  const frequencies = [...ranksByFrequency.values()].sort((left, right) => right - left);
  const isFlush = cards.every((card) => card.suit === cards[0].suit);

  if (frequencies.join(',') === '2,2,1') {
    const pairRanks = ranksDescending.filter((rank) => ranksByFrequency.get(rank) === 2);
    const kicker = ranksDescending.find((rank) => ranksByFrequency.get(rank) === 1)!;
    return Object.freeze({ category: 'two-pair', tieBreakRanks: Object.freeze([...pairRanks, kicker]) });
  }

  if (frequencies.join(',') === '2,1,1,1') {
    const pairRank = ranksDescending.find((rank) => ranksByFrequency.get(rank) === 2)!;
    const kickers = ranksDescending.filter((rank) => rank !== pairRank);
    return Object.freeze({ category: 'one-pair', tieBreakRanks: Object.freeze([pairRank, ...kickers]) });
  }

  if (frequencies.join(',') === '1,1,1,1,1' && !isFlush && !isStraight(ranksDescending)) {
    return Object.freeze({ category: 'high-card', tieBreakRanks: Object.freeze([...ranksDescending]) });
  }

  throw new Error('Unsupported hand category: only high-card, one-pair, and two-pair are supported');
}

/** Compares two supported five-card hands: 1 when left wins, -1 when right wins, 0 when tied. */
export function compareFiveCardHands(left: readonly Card[], right: readonly Card[]): -1 | 0 | 1 {
  const leftEvaluation = evaluateFiveCardHand(left);
  const rightEvaluation = evaluateFiveCardHand(right);
  const categoryDifference =
    (leftEvaluation.category === 'two-pair' ? 2 : leftEvaluation.category === 'one-pair' ? 1 : 0)
    - (rightEvaluation.category === 'two-pair' ? 2 : rightEvaluation.category === 'one-pair' ? 1 : 0);

  if (categoryDifference !== 0) {
    return categoryDifference > 0 ? 1 : -1;
  }

  return compareTieBreakRanks(leftEvaluation.tieBreakRanks, rightEvaluation.tieBreakRanks) as -1 | 0 | 1;
}

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
