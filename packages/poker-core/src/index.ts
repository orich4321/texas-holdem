export const pokerCorePackage = '@texas-holdem/poker-core';

export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';
export type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades';

export interface Card {
  rank: Rank;
  suit: Suit;
}

export type FiveCardHandCategory = 'high-card' | 'one-pair' | 'two-pair' | 'three-of-a-kind' | 'straight' | 'flush' | 'full-house' | 'four-of-a-kind' | 'straight-flush';

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

function categoryValue(category: FiveCardHandCategory): number {
  return category === 'straight-flush' ? 8 : category === 'four-of-a-kind' ? 7 : category === 'full-house' ? 6 : category === 'flush' ? 5 : category === 'straight' ? 4 : category === 'three-of-a-kind' ? 3 : category === 'two-pair' ? 2 : category === 'one-pair' ? 1 : 0;
}

function compareEvaluations(left: FiveCardHandEvaluation, right: FiveCardHandEvaluation): -1 | 0 | 1 {
  const categoryDifference = categoryValue(left.category) - categoryValue(right.category);
  if (categoryDifference !== 0) {
    return categoryDifference > 0 ? 1 : -1;
  }
  return compareTieBreakRanks(left.tieBreakRanks, right.tieBreakRanks) as -1 | 0 | 1;
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
  const isStraightHand = isStraight(ranksDescending);

  if (frequencies.join(',') === '1,1,1,1,1' && isFlush && isStraightHand) {
    const values = ranksDescending.map(rankValue).sort((left, right) => left - right);
    const highCard = values.join(',') === '2,3,4,5,14' ? '5' : ranksDescending[0];
    return Object.freeze({ category: 'straight-flush', tieBreakRanks: Object.freeze([highCard]) });
  }

  if (frequencies.join(',') === '4,1') {
    const quadRank = ranksDescending.find((rank) => ranksByFrequency.get(rank) === 4)!;
    const kicker = ranksDescending.find((rank) => ranksByFrequency.get(rank) === 1)!;
    return Object.freeze({ category: 'four-of-a-kind', tieBreakRanks: Object.freeze([quadRank, kicker]) });
  }

  if (frequencies.join(',') === '3,2') {
    const tripRank = ranksDescending.find((rank) => ranksByFrequency.get(rank) === 3)!;
    const pairRank = ranksDescending.find((rank) => ranksByFrequency.get(rank) === 2)!;
    return Object.freeze({ category: 'full-house', tieBreakRanks: Object.freeze([tripRank, pairRank]) });
  }

  if (frequencies.join(',') === '2,2,1') {
    const pairRanks = ranksDescending.filter((rank) => ranksByFrequency.get(rank) === 2);
    const kicker = ranksDescending.find((rank) => ranksByFrequency.get(rank) === 1)!;
    return Object.freeze({ category: 'two-pair', tieBreakRanks: Object.freeze([...pairRanks, kicker]) });
  }

  if (frequencies.join(',') === '3,1,1') {
    const tripRank = ranksDescending.find((rank) => ranksByFrequency.get(rank) === 3)!;
    const kickers = ranksDescending.filter((rank) => rank !== tripRank);
    return Object.freeze({ category: 'three-of-a-kind', tieBreakRanks: Object.freeze([tripRank, ...kickers]) });
  }

  if (frequencies.join(',') === '1,1,1,1,1' && isFlush && !isStraightHand) {
    return Object.freeze({ category: 'flush', tieBreakRanks: Object.freeze([...ranksDescending]) });
  }

  if (frequencies.join(',') === '1,1,1,1,1' && isStraightHand && !isFlush) {
    const values = ranksDescending.map(rankValue).sort((left, right) => left - right);
    const highCard = values.join(',') === '2,3,4,5,14' ? '5' : ranksDescending[0];
    return Object.freeze({ category: 'straight', tieBreakRanks: Object.freeze([highCard]) });
  }

  if (frequencies.join(',') === '2,1,1,1') {
    const pairRank = ranksDescending.find((rank) => ranksByFrequency.get(rank) === 2)!;
    const kickers = ranksDescending.filter((rank) => rank !== pairRank);
    return Object.freeze({ category: 'one-pair', tieBreakRanks: Object.freeze([pairRank, ...kickers]) });
  }

  if (frequencies.join(',') === '1,1,1,1,1' && !isFlush && !isStraight(ranksDescending)) {
    return Object.freeze({ category: 'high-card', tieBreakRanks: Object.freeze([...ranksDescending]) });
  }

  throw new Error('Unsupported hand category');
}

/** Compares two supported five-card hands: 1 when left wins, -1 when right wins, 0 when tied. */
export function compareFiveCardHands(left: readonly Card[], right: readonly Card[]): -1 | 0 | 1 {
  const leftEvaluation = evaluateFiveCardHand(left);
  const rightEvaluation = evaluateFiveCardHand(right);
  return compareEvaluations(leftEvaluation, rightEvaluation);
}

/** Evaluates the strongest legal five-card hand among exactly seven distinct cards. */
export function evaluateBestFiveCardHand(cards: readonly Card[]): FiveCardHandEvaluation {
  if (cards.length !== 7) {
    throw new Error('A seven-card hand must contain exactly seven cards');
  }

  const physicalCards = new Set(cards.map((card) => `${card?.rank}-${card?.suit}`));
  if (physicalCards.size !== cards.length) {
    throw new Error('A seven-card hand cannot contain a duplicate physical card');
  }

  let best: FiveCardHandEvaluation | undefined;
  for (let first = 0; first < cards.length - 4; first += 1) {
    for (let second = first + 1; second < cards.length - 3; second += 1) {
      for (let third = second + 1; third < cards.length - 2; third += 1) {
        for (let fourth = third + 1; fourth < cards.length - 1; fourth += 1) {
          for (let fifth = fourth + 1; fifth < cards.length; fifth += 1) {
            const evaluation = evaluateFiveCardHand([cards[first], cards[second], cards[third], cards[fourth], cards[fifth]]);
            if (!best || compareEvaluations(evaluation, best) === 1) {
              best = evaluation;
            }
          }
        }
      }
    }
  }

  return best!;
}

/** Compares the best legal five-card hand selected from each seven-card input. */
export function compareBestFiveCardHands(left: readonly Card[], right: readonly Card[]): -1 | 0 | 1 {
  return compareEvaluations(evaluateBestFiveCardHand(left), evaluateBestFiveCardHand(right));
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

export interface StartHandSeat {
  seatNumber: number;
  playerId: string;
  stack: number;
}

export interface StartHandInput {
  seats: readonly StartHandSeat[];
  dealerSeat: number;
  smallBlind: number;
  bigBlind: number;
}

export interface StartedHandSeat extends StartHandSeat {
  currentBet: number;
}

export interface StartedHand {
  dealerSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  currentActorSeat: number;
  currentBet: number;
  pot: number;
  seats: StartedHandSeat[];
}

/** Starts a heads-up or three-player preflop round, posting blinds clockwise from the dealer. */
export function startHand(input: StartHandInput): StartedHand {
  if (!input || typeof input !== 'object' || !Array.isArray(input.seats)) {
    throw new Error('Start hand input must be an object with seats');
  }
  if (input.seats.length !== 2 && input.seats.length !== 3) {
    throw new Error('A hand must contain exactly two or three seats');
  }
  if (!Number.isSafeInteger(input.smallBlind) || !Number.isSafeInteger(input.bigBlind) || input.smallBlind <= 0 || input.bigBlind < input.smallBlind || !Number.isSafeInteger(input.smallBlind + input.bigBlind)) {
    throw new Error('Blinds and their total pot must be safe integers with big blind at least the small blind');
  }

  const seatNumbers = new Set<number>();
  const playerIds = new Set<string>();
  for (const seat of input.seats) {
    if (!seat || typeof seat !== 'object') {
      throw new Error('Each seat must be an object');
    }
    if (!Number.isSafeInteger(seat.seatNumber) || seatNumbers.has(seat.seatNumber) || typeof seat.playerId !== 'string' || seat.playerId.length === 0 || playerIds.has(seat.playerId) || !Number.isSafeInteger(seat.stack) || seat.stack <= 0) {
      throw new Error('Seats must have unique numbers, unique player IDs, and positive safe integer stacks');
    }
    seatNumbers.add(seat.seatNumber);
    playerIds.add(seat.playerId);
  }
  const dealerIndex = input.seats.findIndex((seat) => seat.seatNumber === input.dealerSeat);
  if (dealerIndex === -1) {
    throw new Error('Dealer seat must be seated');
  }

  const smallBlindIndex = input.seats.length === 2 ? dealerIndex : (dealerIndex + 1) % input.seats.length;
  const bigBlindIndex = (smallBlindIndex + 1) % input.seats.length;
  const seats = input.seats.map((seat, index) => {
    const blind = index === smallBlindIndex ? input.smallBlind : index === bigBlindIndex ? input.bigBlind : 0;
    if (seat.stack < blind) {
      throw new Error('A player must have enough chips to post their blind');
    }
    return { ...seat, stack: seat.stack - blind, currentBet: blind };
  });

  return {
    dealerSeat: input.dealerSeat,
    smallBlindSeat: input.seats[smallBlindIndex].seatNumber,
    bigBlindSeat: input.seats[bigBlindIndex].seatNumber,
    currentActorSeat: input.seats[(bigBlindIndex + 1) % input.seats.length].seatNumber,
    currentBet: input.bigBlind,
    pot: input.smallBlind + input.bigBlind,
    seats,
  };
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
