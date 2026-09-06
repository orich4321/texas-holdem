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
  randomInt: RandomInt;
}

export interface StartedHandSeat extends StartHandSeat {
  currentBet: number;
  /** Chips committed across every street; retained for authoritative payout construction. */
  totalCommitted: number;
  holeCards?: readonly [Card, Card];
  isFolded?: boolean;
}

export interface StartedHand {
  dealerSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  currentActorSeat: number;
  currentBet: number;
  /** The last full-raise size; short all-ins do not change it. */
  minimumRaiseIncrement: number;
  pot: number;
  seats: StartedHandSeat[];
  /** Server-private betting state; intentionally omitted from JSON/table views. */
  street: Street;
  communityCards: readonly Card[];
  remainingDeck: readonly Card[];
  /** Server-private burn pile; retained to preserve the complete 52-card invariant. */
  burnedCards: readonly Card[];
  bigBlindAmount: number;
  /** Pot at the start of this street; prevents forged cross-street pot changes. */
  streetPot: number;
  pendingActorSeats: readonly number[];
  /** Actors whose prior action was not reopened by a short all-in raise. */
  raiseLockedSeats?: readonly number[];
}

function cloneCard(card: Card): Card {
  return { rank: card.rank, suit: card.suit };
}

function frozenCards(cards: readonly Card[]): readonly Card[] {
  return Object.freeze(cards.map((card) => Object.freeze(cloneCard(card))));
}

/** Identity capability for state produced by this authoritative core process. */
const authoritativeHands = new WeakSet<object>();

function freezeStartedSeats(seats: StartedHandSeat[]): StartedHandSeat[] {
  for (const seat of seats) {
    if (seat.holeCards) {
      Object.freeze(seat.holeCards[0]);
      Object.freeze(seat.holeCards[1]);
      Object.freeze(seat.holeCards);
    }
    Object.freeze(seat);
  }
  return Object.freeze(seats) as unknown as StartedHandSeat[];
}

function attachPrivateHandState<T extends Omit<StartedHand, 'street' | 'communityCards' | 'remainingDeck' | 'burnedCards' | 'bigBlindAmount' | 'streetPot' | 'pendingActorSeats' | 'raiseLockedSeats'>>(
  hand: T,
  state: Pick<StartedHand, 'street' | 'communityCards' | 'remainingDeck' | 'burnedCards' | 'bigBlindAmount' | 'streetPot' | 'pendingActorSeats' | 'raiseLockedSeats'>,
): StartedHand {
  const freezePublicState = state.street !== 'preflop';
  if (freezePublicState) hand.seats = freezeStartedSeats(hand.seats);
  const authoritativeHand = Object.defineProperties(hand, {
    street: { value: state.street, enumerable: false },
    communityCards: { value: frozenCards(state.communityCards), enumerable: false },
    remainingDeck: { value: frozenCards(state.remainingDeck), enumerable: false },
    burnedCards: { value: frozenCards(state.burnedCards), enumerable: false },
    bigBlindAmount: { value: state.bigBlindAmount, enumerable: false },
    streetPot: { value: state.streetPot, enumerable: false },
    pendingActorSeats: { value: Object.freeze([...state.pendingActorSeats]), enumerable: false },
    raiseLockedSeats: { value: Object.freeze([...(state.raiseLockedSeats ?? [])]), enumerable: false },
  }) as unknown as StartedHand;
  authoritativeHands.add(authoritativeHand);
  return freezePublicState ? Object.freeze(authoritativeHand) : authoritativeHand;
}

function preservePrivateHandState(
  source: StartedHand,
  next: Omit<StartedHand, 'street' | 'communityCards' | 'remainingDeck' | 'burnedCards' | 'bigBlindAmount' | 'streetPot' | 'pendingActorSeats' | 'raiseLockedSeats'>,
  pendingActorSeats: readonly number[] = source.pendingActorSeats,
  raiseLockedSeats: readonly number[] = source.raiseLockedSeats ?? [],
): StartedHand {
  if (!authoritativeHands.has(source)) {
    throw new Error('Started hand must be authoritative private state');
  }
  if (!Array.isArray(source.communityCards) || !Array.isArray(source.remainingDeck) || !Array.isArray(source.burnedCards) || !Array.isArray(pendingActorSeats)) {
    throw new Error('Started hand must retain valid private state');
  }
  return attachPrivateHandState(next, {
    street: source.street,
    communityCards: source.communityCards,
    remainingDeck: source.remainingDeck,
    burnedCards: source.burnedCards,
    bigBlindAmount: source.bigBlindAmount,
    streetPot: source.streetPot,
    pendingActorSeats,
    raiseLockedSeats,
  });
}

function pendingAfterAction(hand: StartedHand, actorSeat: number, resetForRaise = false): number[] {
  const activeSeats = hand.seats
    .filter((seat) => seat.holeCards && !seat.isFolded && seat.stack > 0)
    .map((seat) => seat.seatNumber);
  return resetForRaise
    ? activeSeats.filter((seatNumber) => seatNumber !== actorSeat)
    : hand.pendingActorSeats.filter((seatNumber) => seatNumber !== actorSeat);
}

/** Starts a two- through nine-player preflop round, skipping seated players with no chips. */
export function startHand(input: StartHandInput): StartedHand {
  if (!input || typeof input !== 'object' || !Array.isArray(input.seats)) {
    throw new Error('Start hand input must be an object with seats');
  }
  if (input.seats.length < 2 || input.seats.length > 9) {
    throw new Error('A hand must contain between two and nine seats');
  }
  if (!Number.isSafeInteger(input.smallBlind) || !Number.isSafeInteger(input.bigBlind) || input.smallBlind <= 0 || input.bigBlind < input.smallBlind || !Number.isSafeInteger(input.smallBlind + input.bigBlind)) {
    throw new Error('Blinds and their total pot must be safe integers with big blind at least the small blind');
  }
  if (typeof input.randomInt !== 'function') {
    throw new Error('Start hand input must include a randomInt function');
  }

  const seatNumbers = new Set<number>();
  const playerIds = new Set<string>();
  for (const seat of input.seats) {
    if (!seat || typeof seat !== 'object') {
      throw new Error('Each seat must be an object');
    }
    if (!Number.isSafeInteger(seat.seatNumber) || seatNumbers.has(seat.seatNumber) || typeof seat.playerId !== 'string' || seat.playerId.length === 0 || playerIds.has(seat.playerId) || !Number.isSafeInteger(seat.stack) || seat.stack < 0) {
      throw new Error('Seats must have unique numbers, unique player IDs, and non-negative safe integer stacks');
    }
    seatNumbers.add(seat.seatNumber);
    playerIds.add(seat.playerId);
  }
  const dealerIndex = input.seats.findIndex((seat) => seat.seatNumber === input.dealerSeat);
  if (dealerIndex === -1) {
    throw new Error('Dealer seat must be seated');
  }

  const eligibleIndexes = input.seats.flatMap((seat, index) => seat.stack > 0 ? [index] : []);
  if (eligibleIndexes.length < 2) {
    throw new Error('A hand must contain at least two players with chips');
  }
  const dealerPosition = eligibleIndexes.findIndex((index) => index >= dealerIndex);
  const activeDealerIndex = eligibleIndexes[dealerPosition === -1 ? 0 : dealerPosition];
  const dealerEligiblePosition = eligibleIndexes.indexOf(activeDealerIndex);
  const smallBlindEligiblePosition = eligibleIndexes.length === 2 ? dealerEligiblePosition : (dealerEligiblePosition + 1) % eligibleIndexes.length;
  const bigBlindEligiblePosition = (smallBlindEligiblePosition + 1) % eligibleIndexes.length;
  const smallBlindIndex = eligibleIndexes[smallBlindEligiblePosition];
  const bigBlindIndex = eligibleIndexes[bigBlindEligiblePosition];
  for (const index of eligibleIndexes) {
    const seat = input.seats[index];
    const blind = index === smallBlindIndex ? input.smallBlind : index === bigBlindIndex ? input.bigBlind : 0;
    if (seat.stack < blind) {
      throw new Error('A player must have enough chips to post their blind');
    }
  }
  const deck = new Deck();
  deck.shuffle(input.randomInt);
  const firstHoleCards = new Map<number, Card>();
  const holeCards = new Map<number, [Card, Card]>();
  const dealingOrder = Array.from({ length: eligibleIndexes.length }, (_, offset) => eligibleIndexes[(smallBlindEligiblePosition + offset) % eligibleIndexes.length]);
  for (const index of dealingOrder) {
    firstHoleCards.set(index, deck.deal() as Card);
  }
  for (const index of dealingOrder) {
    holeCards.set(index, [firstHoleCards.get(index)!, deck.deal() as Card]);
  }
  const seats = input.seats.map((seat, index) => {
    const blind = index === smallBlindIndex ? input.smallBlind : index === bigBlindIndex ? input.bigBlind : 0;
    const startedSeat: StartedHandSeat = { ...seat, stack: seat.stack - blind, currentBet: blind, totalCommitted: blind };
    const dealtCards = holeCards.get(index);
    if (dealtCards) {
      startedSeat.holeCards = dealtCards;
    }
    return startedSeat;
  });
  const preflopActionOrder = Array.from(
    { length: eligibleIndexes.length },
    (_, offset) => eligibleIndexes[(bigBlindEligiblePosition + 1 + offset) % eligibleIndexes.length],
  );

  return attachPrivateHandState({
    dealerSeat: input.seats[activeDealerIndex].seatNumber,
    smallBlindSeat: input.seats[smallBlindIndex].seatNumber,
    bigBlindSeat: input.seats[bigBlindIndex].seatNumber,
    currentActorSeat: input.seats[preflopActionOrder[0]].seatNumber,
    currentBet: input.bigBlind,
    minimumRaiseIncrement: input.bigBlind,
    pot: input.smallBlind + input.bigBlind,
    seats,
  }, {
    street: 'preflop',
    communityCards: [],
    remainingDeck: deck.deal(deck.remaining) as Card[],
    burnedCards: [],
    bigBlindAmount: input.bigBlind,
    streetPot: input.smallBlind + input.bigBlind,
    pendingActorSeats: preflopActionOrder.filter((index) => seats[index].stack > 0).map((index) => input.seats[index].seatNumber),
  });
}

export interface PreflopLegalActions {
  actorSeat: number;
  toCall: number;
  canCheck: boolean;
  canCall: boolean;
  canFold: boolean;
  callAmount: number;
  canRaise: boolean;
  minRaiseTo: number | null;
  maxRaiseTo: number | null;
}

/** Returns the current preflop actor's legal action ranges without changing the hand. */
export function getPreflopLegalActions(hand: StartedHand): PreflopLegalActions {
  if (!hand || typeof hand !== 'object' || hand.street !== 'preflop' || !Array.isArray(hand.seats) || !Array.isArray(hand.pendingActorSeats) || !Number.isSafeInteger(hand.currentActorSeat) || !Number.isSafeInteger(hand.currentBet) || hand.currentBet < 0 || !Number.isSafeInteger(hand.minimumRaiseIncrement) || hand.minimumRaiseIncrement <= 0) {
    throw new Error('Started hand must contain safe preflop betting state');
  }
  if (!hand.pendingActorSeats.includes(hand.currentActorSeat)) {
    throw new Error('Preflop betting is settled or the current actor has already acted');
  }

  const actor = hand.seats.find((seat) => seat?.seatNumber === hand.currentActorSeat);
  if (!actor || actor.isFolded === true || !Number.isSafeInteger(actor.currentBet) || actor.currentBet < 0 || actor.currentBet > hand.currentBet || !Number.isSafeInteger(actor.stack) || actor.stack < 0) {
    throw new Error('Current actor must have a valid current bet');
  }

  const toCall = hand.currentBet - actor.currentBet;
  const callAmount = Math.min(toCall, actor.stack);
  const minRaiseTo = hand.currentBet + hand.minimumRaiseIncrement;
  const maxRaiseTo = actor.currentBet + actor.stack;
  if (!Number.isSafeInteger(minRaiseTo) || !Number.isSafeInteger(maxRaiseTo)) {
    throw new Error('Preflop raise targets must be safe integers');
  }
  const canRaise = maxRaiseTo >= minRaiseTo;
  const otherEligiblePlayers = hand.seats.filter((seat) => seat.seatNumber !== actor.seatNumber && seat.holeCards && seat.stack > 0 && !seat.isFolded).length;
  return Object.freeze({
    actorSeat: actor.seatNumber,
    toCall,
    canCheck: toCall === 0,
    canCall: toCall > 0 && callAmount > 0,
    canFold: otherEligiblePlayers > 1,
    callAmount,
    canRaise,
    minRaiseTo: canRaise ? minRaiseTo : null,
    maxRaiseTo: canRaise ? maxRaiseTo : null,
  });
}

/** Applies a legal preflop check and advances action without changing bets or stacks. */
export function applyPreflopCheck(hand: StartedHand, actorSeat: number): StartedHand {
  if (!Number.isSafeInteger(actorSeat)) {
    throw new Error('Checking actor seat must be a safe integer');
  }
  if (hand.currentActorSeat !== actorSeat) {
    throw new Error('Only the active actor may check');
  }

  const legalActions = getPreflopLegalActions(hand);
  const actor = hand.seats.find((seat) => seat.seatNumber === actorSeat);
  if (!actor?.holeCards || actor.stack <= 0) {
    throw new Error('A preflop check requires an eligible actor');
  }
  if (!legalActions.canCheck) {
    throw new Error('A player cannot check while chips are owed');
  }

  const actorIndex = hand.seats.findIndex((seat) => seat.seatNumber === actorSeat);
  const nextActorIndex = hand.seats.findIndex((seat, index) => index > actorIndex && seat.holeCards && seat.stack > 0 && !seat.isFolded)
    ?? -1;
  const wrappedActorIndex = nextActorIndex === -1
    ? hand.seats.findIndex((seat, index) => index < actorIndex && seat.holeCards && seat.stack > 0 && !seat.isFolded)
    : nextActorIndex;
  if (wrappedActorIndex === -1) {
    throw new Error('A preflop check requires another eligible actor');
  }

  return preservePrivateHandState(hand, {
    ...hand,
    currentActorSeat: hand.seats[wrappedActorIndex].seatNumber,
    seats: hand.seats.map((seat) => ({
      ...seat,
      holeCards: seat.holeCards && [{ ...seat.holeCards[0] }, { ...seat.holeCards[1] }] as [Card, Card],
    })),
  }, pendingAfterAction(hand, actorSeat));
}

/** Applies a legal preflop call, including a short all-in call, then advances action. */
export function applyPreflopCall(hand: StartedHand, actorSeat: number): StartedHand {
  if (!Number.isSafeInteger(actorSeat)) {
    throw new Error('Calling actor seat must be a safe integer');
  }
  if (hand.currentActorSeat !== actorSeat) {
    throw new Error('Only the active actor may call');
  }
  if (!Number.isSafeInteger(hand.pot) || hand.pot < 0) {
    throw new Error('Started hand must contain a non-negative safe pot');
  }

  const legalActions = getPreflopLegalActions(hand);
  const actorIndex = hand.seats.findIndex((seat) => seat.seatNumber === actorSeat);
  const actor = hand.seats[actorIndex];
  if (!actor?.holeCards || actor.stack <= 0 || !legalActions.canCall) {
    throw new Error('A preflop call requires an eligible actor with chips owed');
  }
  const nextStack = actor.stack - legalActions.callAmount;
  const nextCurrentBet = actor.currentBet + legalActions.callAmount;
  const nextPot = hand.pot + legalActions.callAmount;
  if (!Number.isSafeInteger(nextStack) || !Number.isSafeInteger(nextCurrentBet) || !Number.isSafeInteger(nextPot)) {
    throw new Error('Preflop call results must be safe integers');
  }

  const seats = hand.seats.map((seat, index) => {
    const clone: StartedHandSeat = {
      ...seat,
      holeCards: seat.holeCards && [{ ...seat.holeCards[0] }, { ...seat.holeCards[1] }] as [Card, Card],
    };
    if (index === actorIndex) {
      clone.stack = nextStack;
      clone.currentBet = nextCurrentBet;
      clone.totalCommitted += legalActions.callAmount;
    }
    return clone;
  });
  const nextActorIndex = seats.findIndex((seat, index) => index > actorIndex && seat.holeCards && seat.stack > 0 && !seat.isFolded);
  const wrappedActorIndex = nextActorIndex === -1
    ? seats.findIndex((seat, index) => index < actorIndex && seat.holeCards && seat.stack > 0 && !seat.isFolded)
    : nextActorIndex;
  if (wrappedActorIndex === -1 && pendingAfterAction(hand, actorSeat).length > 0) {
    throw new Error('A preflop call requires another eligible actor');
  }

  return preservePrivateHandState(hand, {
    ...hand,
    pot: nextPot,
    currentActorSeat: wrappedActorIndex === -1 ? actorSeat : seats[wrappedActorIndex].seatNumber,
    seats,
  }, pendingAfterAction(hand, actorSeat));
}

/** Applies a legal preflop fold, preserving committed chips and advancing past folded seats. */
export function applyPreflopFold(hand: StartedHand, actorSeat: number): StartedHand {
  if (!Number.isSafeInteger(actorSeat)) {
    throw new Error('Folding actor seat must be a safe integer');
  }
  if (hand.currentActorSeat !== actorSeat) {
    throw new Error('Only the active actor may fold');
  }
  if (!Number.isSafeInteger(hand.pot) || hand.pot < 0) {
    throw new Error('Started hand must contain a non-negative safe pot');
  }

  const legalActions = getPreflopLegalActions(hand);
  if (!legalActions.canFold) {
    throw new Error('A player cannot fold when no further betting decision remains');
  }
  const actorIndex = hand.seats.findIndex((seat) => seat.seatNumber === actorSeat);
  const actor = hand.seats[actorIndex];
  if (!actor?.holeCards || actor.stack <= 0 || actor.isFolded) {
    throw new Error('A preflop fold requires an eligible actor');
  }

  const seats = hand.seats.map((seat, index) => ({
    ...seat,
    isFolded: index === actorIndex ? true : seat.isFolded === true,
    holeCards: seat.holeCards && [{ ...seat.holeCards[0] }, { ...seat.holeCards[1] }] as [Card, Card],
  }));
  const nextActorIndex = seats.findIndex((seat, index) => index > actorIndex && seat.holeCards && seat.stack > 0 && !seat.isFolded);
  const wrappedActorIndex = nextActorIndex === -1
    ? seats.findIndex((seat, index) => index < actorIndex && seat.holeCards && seat.stack > 0 && !seat.isFolded)
    : nextActorIndex;
  if (wrappedActorIndex === -1) {
    throw new Error('A preflop fold requires another eligible actor');
  }

  return preservePrivateHandState(hand, {
    ...hand,
    currentActorSeat: seats[wrappedActorIndex].seatNumber,
    seats,
  }, pendingAfterAction(hand, actorSeat));
}

/** Applies a legal full preflop raise to a total committed-bet target and advances action. */
export function applyPreflopRaise(hand: StartedHand, actorSeat: number, raiseTo: number): StartedHand {
  if (!Number.isSafeInteger(actorSeat)) {
    throw new Error('Raising actor seat must be a safe integer');
  }
  if (!Number.isSafeInteger(raiseTo) || raiseTo < 0) {
    throw new Error('Preflop raise target must be a non-negative safe integer');
  }
  if (hand.currentActorSeat !== actorSeat) {
    throw new Error('Only the active actor may raise');
  }
  if (!Number.isSafeInteger(hand.pot) || hand.pot < 0) {
    throw new Error('Started hand must contain a non-negative safe pot');
  }

  const legalActions = getPreflopLegalActions(hand);
  const actorIndex = hand.seats.findIndex((seat) => seat.seatNumber === actorSeat);
  const actor = hand.seats[actorIndex];
  if (!actor?.holeCards || actor.stack <= 0 || !legalActions.canRaise || legalActions.minRaiseTo === null || legalActions.maxRaiseTo === null) {
    throw new Error('A preflop raise requires an eligible actor with a full raise available');
  }
  if (raiseTo < legalActions.minRaiseTo || raiseTo > legalActions.maxRaiseTo) {
    throw new Error('Preflop raise target is outside the legal full raise range');
  }

  const raiseAmount = raiseTo - actor.currentBet;
  const nextStack = actor.stack - raiseAmount;
  const nextPot = hand.pot + raiseAmount;
  if (!Number.isSafeInteger(raiseAmount) || !Number.isSafeInteger(nextStack) || !Number.isSafeInteger(nextPot)) {
    throw new Error('Preflop raise results must be safe integers');
  }

  const seats = hand.seats.map((seat, index) => {
    const clone: StartedHandSeat = {
      ...seat,
      holeCards: seat.holeCards && [{ ...seat.holeCards[0] }, { ...seat.holeCards[1] }] as [Card, Card],
    };
    if (index === actorIndex) {
      clone.stack = nextStack;
      clone.currentBet = raiseTo;
      clone.totalCommitted += raiseAmount;
    }
    return clone;
  });
  const nextActorIndex = seats.findIndex((seat, index) => index > actorIndex && seat.holeCards && seat.stack > 0 && !seat.isFolded);
  const wrappedActorIndex = nextActorIndex === -1
    ? seats.findIndex((seat, index) => index < actorIndex && seat.holeCards && seat.stack > 0 && !seat.isFolded)
    : nextActorIndex;
  if (wrappedActorIndex === -1) {
    throw new Error('A preflop raise requires another eligible actor');
  }

  return preservePrivateHandState(hand, {
    ...hand,
    currentBet: raiseTo,
    minimumRaiseIncrement: raiseTo - hand.currentBet,
    pot: nextPot,
    currentActorSeat: seats[wrappedActorIndex].seatNumber,
    seats,
  }, pendingAfterAction(hand, actorSeat, true));
}

/** Applies an all-in preflop raise; a full raise reopens the full-raise increment. */
export function applyPreflopAllIn(hand: StartedHand, actorSeat: number): StartedHand {
  if (!Number.isSafeInteger(actorSeat)) {
    throw new Error('All-in actor seat must be a safe integer');
  }
  if (hand.currentActorSeat !== actorSeat) {
    throw new Error('Only the active actor may go all-in');
  }
  if (!Number.isSafeInteger(hand.pot) || hand.pot < 0) {
    throw new Error('Started hand must contain a non-negative safe pot');
  }

  const legalActions = getPreflopLegalActions(hand);
  const actorIndex = hand.seats.findIndex((seat) => seat.seatNumber === actorSeat);
  const actor = hand.seats[actorIndex];
  if (!actor?.holeCards || actor.stack <= 0) {
    throw new Error('A preflop all-in requires an eligible actor');
  }
  const allInTo = actor.currentBet + actor.stack;
  if (!Number.isSafeInteger(allInTo) || allInTo <= hand.currentBet) {
    throw new Error('A preflop all-in must be a raise');
  }
  const nextPot = hand.pot + actor.stack;
  if (!Number.isSafeInteger(nextPot)) {
    throw new Error('Preflop all-in results must be safe integers');
  }

  const seats = hand.seats.map((seat, index) => {
    const clone: StartedHandSeat = {
      ...seat,
      holeCards: seat.holeCards && [{ ...seat.holeCards[0] }, { ...seat.holeCards[1] }] as [Card, Card],
    };
    if (index === actorIndex) {
      clone.stack = 0;
      clone.currentBet = allInTo;
      clone.totalCommitted += actor.stack;
    }
    return clone;
  });
  const nextActorIndex = seats.findIndex((seat, index) => index > actorIndex && seat.holeCards && seat.stack > 0 && !seat.isFolded);
  const wrappedActorIndex = nextActorIndex === -1
    ? seats.findIndex((seat, index) => index < actorIndex && seat.holeCards && seat.stack > 0 && !seat.isFolded)
    : nextActorIndex;
  if (wrappedActorIndex === -1) {
    throw new Error('A preflop all-in requires another eligible actor');
  }

  return preservePrivateHandState(hand, {
    ...hand,
    currentBet: allInTo,
    minimumRaiseIncrement: allInTo >= (legalActions.minRaiseTo ?? Number.MAX_SAFE_INTEGER)
      ? allInTo - hand.currentBet
      : hand.minimumRaiseIncrement,
    pot: nextPot,
    currentActorSeat: seats[wrappedActorIndex].seatNumber,
    seats,
  }, pendingAfterAction(hand, actorSeat, true));
}

/** Advances a settled preflop round to the flop using the server-shuffled deck retained at hand start. */
export function advancePreflopToFlop(hand: StartedHand): StartedHand {
  if (!hand || typeof hand !== 'object' || hand.street !== 'preflop' || !Array.isArray(hand.communityCards) || hand.communityCards.length !== 0 || !Array.isArray(hand.remainingDeck) || !Array.isArray(hand.pendingActorSeats) || !Number.isSafeInteger(hand.bigBlindAmount) || hand.bigBlindAmount <= 0 || !Number.isSafeInteger(hand.currentBet) || hand.currentBet < 0) {
    throw new Error('A preflop hand must contain valid private deck state');
  }
  const dealtSeats = hand.seats.filter((seat) => seat?.holeCards);
  const contestingSeats = dealtSeats.filter((seat) => !seat.isFolded);
  if (contestingSeats.length < 2 || contestingSeats.some((seat) => !Number.isSafeInteger(seat.currentBet) || seat.currentBet < 0 || !Number.isSafeInteger(seat.stack) || seat.stack < 0)) {
    throw new Error('A flop requires at least two valid contesting players');
  }
  if (hand.pendingActorSeats.length > 0 || contestingSeats.some((seat) => seat.stack > 0 && seat.currentBet !== hand.currentBet)) {
    throw new Error('Preflop betting must be settled and every player must have acted before advancing to the flop');
  }
  const committedPot = hand.seats.reduce((total, seat) => total + seat.currentBet, 0);
  if (!Number.isSafeInteger(committedPot) || hand.pot !== committedPot) {
    throw new Error('Preflop pot must equal all committed bets before advancing to the flop');
  }
  const allDealtCards = dealtSeats.flatMap((seat) => seat.holeCards!);
  const allCards = [...hand.remainingDeck, ...allDealtCards];
  if (hand.remainingDeck.length !== 52 - allDealtCards.length || allCards.length !== 52 || new Set(allCards.map((card) => `${card?.rank}-${card?.suit}`)).size !== 52 || allCards.some((card) => !card || !rankValues.has(card.rank) || !suits.includes(card.suit))) {
    throw new Error('Private deck state must contain 52 distinct valid cards');
  }
  const dealerIndex = hand.seats.findIndex((seat) => seat.seatNumber === hand.dealerSeat);
  let currentActorSeat: number | undefined;
  for (let offset = 1; offset <= hand.seats.length; offset += 1) {
    const seat = hand.seats[(dealerIndex + offset) % hand.seats.length];
    if (seat.holeCards && !seat.isFolded && seat.stack > 0) {
      currentActorSeat = seat.seatNumber;
      break;
    }
  }
  if (dealerIndex === -1) {
    throw new Error('A flop requires a valid dealer');
  }
  // With every contesting player all-in, no betting actor exists; retain the
  // dealer as an inert cursor until the automatic runout/showdown slice.
  if (currentActorSeat === undefined) {
    currentActorSeat = hand.dealerSeat;
  }
  const [flopBurn, ...afterBurn] = hand.remainingDeck;
  return attachPrivateHandState({
    ...hand,
    currentActorSeat,
    currentBet: 0,
    minimumRaiseIncrement: hand.bigBlindAmount,
    seats: hand.seats.map((seat) => ({
      ...seat,
      currentBet: 0,
      holeCards: seat.holeCards && [cloneCard(seat.holeCards[0]), cloneCard(seat.holeCards[1])] as [Card, Card],
    })),
  }, {
    street: 'flop',
    communityCards: afterBurn.slice(0, 3),
    remainingDeck: afterBurn.slice(3),
    burnedCards: [flopBurn],
    bigBlindAmount: hand.bigBlindAmount,
    streetPot: hand.pot,
    pendingActorSeats: hand.seats.filter((seat) => seat.holeCards && !seat.isFolded && seat.stack > 0).map((seat) => seat.seatNumber),
  });
}

/** Legal flop actions use the same total-bet targets as preflop after round bets reset. */
export type FlopLegalActions = PreflopLegalActions;

function getPostflopLegalActions(hand: StartedHand, street: 'flop' | 'turn' | 'river'): FlopLegalActions {
  if (!hand || typeof hand !== 'object' || hand.street !== street || !Array.isArray(hand.seats) || !Array.isArray(hand.pendingActorSeats) || !Number.isSafeInteger(hand.currentActorSeat) || !Number.isSafeInteger(hand.currentBet) || hand.currentBet < 0 || !Number.isSafeInteger(hand.minimumRaiseIncrement) || hand.minimumRaiseIncrement <= 0) {
    throw new Error('Started hand must contain safe flop betting state');
  }
  if (!hand.pendingActorSeats.includes(hand.currentActorSeat)) throw new Error('Flop betting is settled or the current actor has already acted');
  const actor = hand.seats.find((seat) => seat?.seatNumber === hand.currentActorSeat);
  if (!actor || actor.isFolded === true || !Number.isSafeInteger(actor.currentBet) || actor.currentBet < 0 || actor.currentBet > hand.currentBet || !Number.isSafeInteger(actor.stack) || actor.stack < 0) throw new Error('Current flop actor must have a valid current bet');
  const toCall = hand.currentBet - actor.currentBet;
  const callAmount = Math.min(toCall, actor.stack);
  const minRaiseTo = hand.currentBet + hand.minimumRaiseIncrement;
  const maxRaiseTo = actor.currentBet + actor.stack;
  if (!Number.isSafeInteger(minRaiseTo) || !Number.isSafeInteger(maxRaiseTo)) throw new Error('Flop raise targets must be safe integers');
  const canRaise = maxRaiseTo >= minRaiseTo && !hand.raiseLockedSeats?.includes(actor.seatNumber);
  const otherEligiblePlayers = hand.seats.filter((seat) => seat.seatNumber !== actor.seatNumber && seat.holeCards && !seat.isFolded).length;
  return Object.freeze({ actorSeat: actor.seatNumber, toCall, canCheck: toCall === 0, canCall: toCall > 0 && callAmount > 0, canFold: otherEligiblePlayers > 0, callAmount, canRaise, minRaiseTo: canRaise ? minRaiseTo : null, maxRaiseTo: canRaise ? maxRaiseTo : null });
}

/** Applies a legal flop check and advances only the still-pending postflop actor. */
function applyPostflopCheck(hand: StartedHand, actorSeat: number, street: 'flop' | 'turn' | 'river'): StartedHand {
  if (!Number.isSafeInteger(actorSeat)) throw new Error('Checking actor seat must be a safe integer');
  if (hand.currentActorSeat !== actorSeat) throw new Error('Only the active actor may check');
  const legalActions = getPostflopLegalActions(hand, street);
  const actorIndex = hand.seats.findIndex((seat) => seat.seatNumber === actorSeat);
  const actor = hand.seats[actorIndex];
  if (!actor?.holeCards || actor.stack <= 0 || actor.isFolded || !legalActions.canCheck) throw new Error('A flop check requires an eligible actor with nothing owed');
  const pending = pendingAfterAction(hand, actorSeat);
  let nextActorIndex = -1;
  if (pending.length > 0) {
    for (let offset = 1; offset <= hand.seats.length; offset += 1) {
      const index = (actorIndex + offset) % hand.seats.length;
      if (pending.includes(hand.seats[index].seatNumber)) { nextActorIndex = index; break; }
    }
    if (nextActorIndex === -1) throw new Error('A flop check requires another pending actor');
  }
  return preservePrivateHandState(hand, {
    ...hand,
    currentActorSeat: nextActorIndex === -1 ? actorSeat : hand.seats[nextActorIndex].seatNumber,
    seats: hand.seats.map((seat) => ({ ...seat, holeCards: seat.holeCards && [cloneCard(seat.holeCards[0]), cloneCard(seat.holeCards[1])] as [Card, Card] })),
  }, pending);
}

function nextFlopActorSeat(hand: StartedHand, actorIndex: number, pending: readonly number[]): number {
  for (let offset = 1; offset <= hand.seats.length; offset += 1) {
    const seat = hand.seats[(actorIndex + offset) % hand.seats.length];
    if (pending.includes(seat.seatNumber)) return seat.seatNumber;
  }
  return hand.seats[actorIndex].seatNumber;
}

function clonedFlopSeats(hand: StartedHand, actorIndex: number, update?: (seat: StartedHandSeat) => void): StartedHandSeat[] {
  return hand.seats.map((seat, index) => {
    const clone: StartedHandSeat = { ...seat, holeCards: seat.holeCards && [cloneCard(seat.holeCards[0]), cloneCard(seat.holeCards[1])] as [Card, Card] };
    if (index === actorIndex) update?.(clone);
    return clone;
  });
}

/** Applies a legal flop call, including a short all-in call, and advances pending action. */
function applyPostflopCall(hand: StartedHand, actorSeat: number, street: 'flop' | 'turn' | 'river'): StartedHand {
  if (!Number.isSafeInteger(actorSeat)) throw new Error('Calling actor seat must be a safe integer');
  if (hand.currentActorSeat !== actorSeat) throw new Error('Only the active actor may call');
  if (!Number.isSafeInteger(hand.pot) || hand.pot < 0) throw new Error('Started hand must contain a non-negative safe pot');
  const legal = getPostflopLegalActions(hand, street);
  const actorIndex = hand.seats.findIndex((seat) => seat.seatNumber === actorSeat);
  const actor = hand.seats[actorIndex];
  if (!actor?.holeCards || actor.stack <= 0 || !legal.canCall) throw new Error('A flop call requires an eligible actor with chips owed');
  const nextStack = actor.stack - legal.callAmount;
  const nextBet = actor.currentBet + legal.callAmount;
  const nextPot = hand.pot + legal.callAmount;
  if (!Number.isSafeInteger(nextStack) || !Number.isSafeInteger(nextBet) || !Number.isSafeInteger(nextPot)) throw new Error('Flop call results must be safe integers');
  const pending = pendingAfterAction(hand, actorSeat);
  return preservePrivateHandState(hand, { ...hand, pot: nextPot, currentActorSeat: nextFlopActorSeat(hand, actorIndex, pending), seats: clonedFlopSeats(hand, actorIndex, (seat) => { seat.stack = nextStack; seat.currentBet = nextBet; seat.totalCommitted += legal.callAmount; }) }, pending);
}

/** Applies a legal flop fold, retaining committed chips while removing the actor from action. */
function applyPostflopFold(hand: StartedHand, actorSeat: number, street: 'flop' | 'turn' | 'river'): StartedHand {
  if (!Number.isSafeInteger(actorSeat)) throw new Error('Folding actor seat must be a safe integer');
  if (hand.currentActorSeat !== actorSeat) throw new Error('Only the active actor may fold');
  if (!Number.isSafeInteger(hand.pot) || hand.pot < 0) throw new Error('Started hand must contain a non-negative safe pot');
  const legal = getPostflopLegalActions(hand, street);
  const actorIndex = hand.seats.findIndex((seat) => seat.seatNumber === actorSeat);
  const actor = hand.seats[actorIndex];
  if (!actor?.holeCards || actor.stack <= 0 || actor.isFolded || !legal.canFold) throw new Error('A flop fold requires an eligible actor with another contestant');
  const pending = pendingAfterAction(hand, actorSeat);
  return preservePrivateHandState(hand, { ...hand, currentActorSeat: nextFlopActorSeat(hand, actorIndex, pending), seats: clonedFlopSeats(hand, actorIndex, (seat) => { seat.isFolded = true; }) }, pending);
}

/** Applies a legal full flop raise to a total committed-bet target and reopens action. */
function applyPostflopRaise(hand: StartedHand, actorSeat: number, raiseTo: number, street: 'flop' | 'turn' | 'river'): StartedHand {
  if (!Number.isSafeInteger(actorSeat)) throw new Error('Raising actor seat must be a safe integer');
  if (!Number.isSafeInteger(raiseTo) || raiseTo < 0) throw new Error('Flop raise target must be a non-negative safe integer');
  if (hand.currentActorSeat !== actorSeat) throw new Error('Only the active actor may raise');
  if (!Number.isSafeInteger(hand.pot) || hand.pot < 0) throw new Error('Started hand must contain a non-negative safe pot');
  const legal = getPostflopLegalActions(hand, street);
  const actorIndex = hand.seats.findIndex((seat) => seat.seatNumber === actorSeat);
  const actor = hand.seats[actorIndex];
  if (!actor?.holeCards || actor.stack <= 0 || !legal.canRaise || legal.minRaiseTo === null || legal.maxRaiseTo === null || raiseTo < legal.minRaiseTo || raiseTo > legal.maxRaiseTo) throw new Error('Flop raise target is outside the legal full raise range');
  const amount = raiseTo - actor.currentBet;
  const nextStack = actor.stack - amount;
  const nextPot = hand.pot + amount;
  if (!Number.isSafeInteger(nextStack) || !Number.isSafeInteger(nextPot)) throw new Error('Flop raise results must be safe integers');
  const pending = pendingAfterAction(hand, actorSeat, true);
  return preservePrivateHandState(hand, { ...hand, currentBet: raiseTo, minimumRaiseIncrement: raiseTo - hand.currentBet, pot: nextPot, currentActorSeat: nextFlopActorSeat(hand, actorIndex, pending), seats: clonedFlopSeats(hand, actorIndex, (seat) => { seat.stack = nextStack; seat.currentBet = raiseTo; seat.totalCommitted += amount; }) }, pending, []);
}

/** Applies a raising flop all-in; a short raise does not alter the full-raise increment. */
function applyPostflopAllIn(hand: StartedHand, actorSeat: number, street: 'flop' | 'turn' | 'river'): StartedHand {
  if (!Number.isSafeInteger(actorSeat)) throw new Error('All-in actor seat must be a safe integer');
  if (hand.currentActorSeat !== actorSeat) throw new Error('Only the active actor may go all-in');
  if (!Number.isSafeInteger(hand.pot) || hand.pot < 0) throw new Error('Started hand must contain a non-negative safe pot');
  const legal = getPostflopLegalActions(hand, street);
  const actorIndex = hand.seats.findIndex((seat) => seat.seatNumber === actorSeat);
  const actor = hand.seats[actorIndex];
  if (!actor?.holeCards || actor.stack <= 0 || hand.raiseLockedSeats?.includes(actorSeat)) throw new Error('A flop all-in requires an eligible actor with an unlocked raise');
  const allInTo = actor.currentBet + actor.stack;
  const nextPot = hand.pot + actor.stack;
  if (!Number.isSafeInteger(allInTo) || !Number.isSafeInteger(nextPot) || allInTo <= hand.currentBet) throw new Error('A flop all-in must be a raise with safe results');
  const isFullRaise = allInTo >= (legal.minRaiseTo ?? Number.MAX_SAFE_INTEGER);
  const pending = isFullRaise ? pendingAfterAction(hand, actorSeat, true) : hand.seats.filter((seat) => seat.seatNumber !== actorSeat && seat.holeCards && !seat.isFolded && seat.stack > 0 && seat.currentBet < allInTo).map((seat) => seat.seatNumber);
  const locked = isFullRaise ? [] : [...new Set([...(hand.raiseLockedSeats ?? []), ...hand.seats.filter((seat) => seat.seatNumber !== actorSeat && seat.holeCards && !seat.isFolded && seat.stack > 0 && seat.currentBet < allInTo && !hand.pendingActorSeats.includes(seat.seatNumber)).map((seat) => seat.seatNumber)])];
  return preservePrivateHandState(hand, { ...hand, currentBet: allInTo, minimumRaiseIncrement: isFullRaise ? allInTo - hand.currentBet : hand.minimumRaiseIncrement, pot: nextPot, currentActorSeat: nextFlopActorSeat(hand, actorIndex, pending), seats: clonedFlopSeats(hand, actorIndex, (seat) => { seat.stack = 0; seat.currentBet = allInTo; seat.totalCommitted += actor.stack; }) }, pending, locked);
}

/** Advances a settled flop to the turn, burning one server-private card then dealing one. */
function advancePostflopToNext(hand: StartedHand, street: 'flop' | 'turn'): StartedHand {
  if (!authoritativeHands.has(hand)) throw new Error('A flop hand must be authoritative private state');
  const isTurn = street === 'turn';
  const expectedCommunityCards = isTurn ? 4 : 3;
  const expectedBurnedCards = isTurn ? 2 : 1;
  if (!hand || typeof hand !== 'object' || hand.street !== street || !Array.isArray(hand.communityCards) || hand.communityCards.length !== expectedCommunityCards || !Array.isArray(hand.remainingDeck) || !Array.isArray(hand.burnedCards) || hand.burnedCards.length !== expectedBurnedCards || !Array.isArray(hand.pendingActorSeats) || !Number.isSafeInteger(hand.pot) || hand.pot < 0 || !Number.isSafeInteger(hand.streetPot) || hand.streetPot < 0 || !Number.isSafeInteger(hand.bigBlindAmount) || hand.bigBlindAmount <= 0) throw new Error('A flop hand must contain valid private deck and betting state');
  const contestingSeats = hand.seats.filter((seat) => seat?.holeCards && !seat.isFolded);
  if (contestingSeats.length < 2 || hand.pendingActorSeats.length > 0 || !Number.isSafeInteger(hand.currentBet) || hand.currentBet < 0 || contestingSeats.some((seat) => !Number.isSafeInteger(seat.currentBet) || seat.currentBet < 0 || (seat.stack > 0 && seat.currentBet !== hand.currentBet) || !Number.isSafeInteger(seat.stack) || seat.stack < 0)) throw new Error('Flop betting must be settled before advancing to the turn');
  const streetCommitments = hand.seats.reduce((total, seat) => total + seat.currentBet, 0);
  if (!Number.isSafeInteger(streetCommitments) || hand.pot !== hand.streetPot + streetCommitments) throw new Error('Flop pot must equal its street-start pot plus committed bets');
  if (hand.remainingDeck.length < 2) throw new Error('A flop requires private cards for a turn burn and deal');
  const allDealtCards = hand.seats.filter((seat) => seat?.holeCards).flatMap((seat) => seat.holeCards!);
  const allPrivateCards = [...allDealtCards, ...hand.communityCards, ...hand.remainingDeck, ...hand.burnedCards];
  if (allPrivateCards.length !== 52 || new Set(allPrivateCards.map((card) => `${card?.rank}-${card?.suit}`)).size !== 52 || allPrivateCards.some((card) => !card || !rankValues.has(card.rank) || !suits.includes(card.suit))) {
    throw new Error('Flop private state must contain 52 distinct valid cards');
  }
  const dealerIndex = hand.seats.findIndex((seat) => seat.seatNumber === hand.dealerSeat);
  if (dealerIndex === -1) throw new Error('A turn requires a valid dealer');
  let currentActorSeat = hand.dealerSeat;
  for (let offset = 1; offset <= hand.seats.length; offset += 1) {
    const seat = hand.seats[(dealerIndex + offset) % hand.seats.length];
    if (seat.holeCards && !seat.isFolded && seat.stack > 0) { currentActorSeat = seat.seatNumber; break; }
  }
  const [turnBurn, turnCard, ...remainingDeck] = hand.remainingDeck;
  const pendingActorSeats = hand.seats.filter((seat) => seat.holeCards && !seat.isFolded && seat.stack > 0).map((seat) => seat.seatNumber);
  return attachPrivateHandState({
    ...hand, currentActorSeat, currentBet: 0, minimumRaiseIncrement: hand.bigBlindAmount,
    seats: hand.seats.map((seat) => ({ ...seat, currentBet: 0, holeCards: seat.holeCards && [cloneCard(seat.holeCards[0]), cloneCard(seat.holeCards[1])] as [Card, Card] })),
  }, { street: isTurn ? 'river' : 'turn', communityCards: [...hand.communityCards, turnCard], remainingDeck, burnedCards: [...hand.burnedCards, turnBurn], bigBlindAmount: hand.bigBlindAmount, streetPot: hand.pot, pendingActorSeats });
}

export function getFlopLegalActions(hand: StartedHand): FlopLegalActions { return getPostflopLegalActions(hand, 'flop'); }
export function applyFlopCheck(hand: StartedHand, actorSeat: number): StartedHand { return applyPostflopCheck(hand, actorSeat, 'flop'); }
export function applyFlopCall(hand: StartedHand, actorSeat: number): StartedHand { return applyPostflopCall(hand, actorSeat, 'flop'); }
export function applyFlopFold(hand: StartedHand, actorSeat: number): StartedHand { return applyPostflopFold(hand, actorSeat, 'flop'); }
export function applyFlopRaise(hand: StartedHand, actorSeat: number, raiseTo: number): StartedHand { return applyPostflopRaise(hand, actorSeat, raiseTo, 'flop'); }
export function applyFlopAllIn(hand: StartedHand, actorSeat: number): StartedHand { return applyPostflopAllIn(hand, actorSeat, 'flop'); }

/** Turn actions share the postflop rules but retain a turn-only public boundary. */
export function getTurnLegalActions(hand: StartedHand): FlopLegalActions { return getPostflopLegalActions(hand, 'turn'); }
export function applyTurnCheck(hand: StartedHand, actorSeat: number): StartedHand { return applyPostflopCheck(hand, actorSeat, 'turn'); }
export function applyTurnCall(hand: StartedHand, actorSeat: number): StartedHand { return applyPostflopCall(hand, actorSeat, 'turn'); }
export function applyTurnFold(hand: StartedHand, actorSeat: number): StartedHand { return applyPostflopFold(hand, actorSeat, 'turn'); }
export function applyTurnRaise(hand: StartedHand, actorSeat: number, raiseTo: number): StartedHand { return applyPostflopRaise(hand, actorSeat, raiseTo, 'turn'); }
export function applyTurnAllIn(hand: StartedHand, actorSeat: number): StartedHand { return applyPostflopAllIn(hand, actorSeat, 'turn'); }

/** River actions share the authoritative postflop rules and finish river betting. */
export function getRiverLegalActions(hand: StartedHand): FlopLegalActions { return getPostflopLegalActions(hand, 'river'); }
export function applyRiverCheck(hand: StartedHand, actorSeat: number): StartedHand { return applyPostflopCheck(hand, actorSeat, 'river'); }
export function applyRiverCall(hand: StartedHand, actorSeat: number): StartedHand { return applyPostflopCall(hand, actorSeat, 'river'); }
export function applyRiverFold(hand: StartedHand, actorSeat: number): StartedHand { return applyPostflopFold(hand, actorSeat, 'river'); }
export function applyRiverRaise(hand: StartedHand, actorSeat: number, raiseTo: number): StartedHand { return applyPostflopRaise(hand, actorSeat, raiseTo, 'river'); }
export function applyRiverAllIn(hand: StartedHand, actorSeat: number): StartedHand { return applyPostflopAllIn(hand, actorSeat, 'river'); }

/** Advances a settled flop to the turn, burning one server-private card then dealing one. */
export function advanceFlopToTurn(hand: StartedHand): StartedHand { return advancePostflopToNext(hand, 'flop'); }

/** Advances a settled turn to the river, burning one server-private card then dealing one. */
export function advanceTurnToRiver(hand: StartedHand): StartedHand { return advancePostflopToNext(hand, 'turn'); }

/** Advances a settled river to showdown without consuming any additional private cards. */
export function advanceRiverToShowdown(hand: StartedHand): StartedHand {
  if (!authoritativeHands.has(hand) || hand.street !== 'river') {
    throw new Error('River showdown requires authoritative river state');
  }
  if (!Array.isArray(hand.communityCards) || hand.communityCards.length !== 5 || !Array.isArray(hand.burnedCards) || hand.burnedCards.length !== 3 || !Array.isArray(hand.remainingDeck) || !Array.isArray(hand.pendingActorSeats) || hand.pendingActorSeats.length !== 0 || !Number.isSafeInteger(hand.pot) || hand.pot < 0 || !Number.isSafeInteger(hand.streetPot) || hand.streetPot < 0 || !Number.isSafeInteger(hand.currentBet) || hand.currentBet < 0 || !Number.isSafeInteger(hand.bigBlindAmount) || hand.bigBlindAmount <= 0) {
    throw new Error('River showdown requires settled private river state');
  }
  const contestingSeats = hand.seats.filter((seat) => seat?.holeCards && !seat.isFolded);
  if (contestingSeats.length < 2 || !contestingSeats.some((seat) => seat.stack > 0) || contestingSeats.some((seat) => !Number.isSafeInteger(seat.currentBet) || seat.currentBet < 0 || !Number.isSafeInteger(seat.stack) || seat.stack < 0 || (seat.stack > 0 && seat.currentBet !== hand.currentBet))) {
    throw new Error('River showdown requires at least two settled contesting players including a non-all-in contestant');
  }
  const streetCommitments = hand.seats.reduce((total, seat) => total + seat.currentBet, 0);
  if (!Number.isSafeInteger(streetCommitments) || hand.pot !== hand.streetPot + streetCommitments) {
    throw new Error('River showdown pot must equal its street-start pot plus committed bets');
  }
  const dealtCards = hand.seats.filter((seat) => seat?.holeCards).flatMap((seat) => seat.holeCards!);
  const allCards = [...dealtCards, ...hand.communityCards, ...hand.burnedCards, ...hand.remainingDeck];
  if (allCards.length !== 52 || new Set(allCards.map((card) => `${card?.rank}-${card?.suit}`)).size !== 52 || allCards.some((card) => !card || !rankValues.has(card.rank) || !suits.includes(card.suit))) {
    throw new Error('River showdown requires 52 distinct valid private cards');
  }
  return attachPrivateHandState({
    ...hand,
    currentActorSeat: hand.dealerSeat,
    currentBet: 0,
    minimumRaiseIncrement: hand.bigBlindAmount,
    seats: hand.seats.map((seat) => ({ ...seat, currentBet: 0, holeCards: seat.holeCards && [cloneCard(seat.holeCards[0]), cloneCard(seat.holeCards[1])] as [Card, Card] })),
  }, {
    street: 'showdown',
    communityCards: hand.communityCards,
    remainingDeck: hand.remainingDeck,
    burnedCards: hand.burnedCards,
    bigBlindAmount: hand.bigBlindAmount,
    streetPot: hand.pot,
    pendingActorSeats: [],
    raiseLockedSeats: [],
  });
}

/**
 * Runs the remaining board only after postflop betting is settled and every
 * non-folded player is all-in. The server-private shuffled deck stays inside
 * the authoritative hand capability; payout resolution remains a separate
 * showdown concern.
 */
export function runOutAllInToShowdown(hand: StartedHand): StartedHand {
  if (!authoritativeHands.has(hand)) throw new Error('An all-in runout requires authoritative private state');
  if (hand.street !== 'flop' && hand.street !== 'turn' && hand.street !== 'river') {
    throw new Error('An all-in runout requires a postflop hand');
  }
  const expectedCommunityCards = hand.street === 'flop' ? 3 : hand.street === 'turn' ? 4 : 5;
  const expectedBurnedCards = hand.street === 'flop' ? 1 : hand.street === 'turn' ? 2 : 3;
  const contestingSeats = hand.seats.filter((seat) => seat?.holeCards && !seat.isFolded);
  if (contestingSeats.length < 2 || hand.pendingActorSeats.length !== 0 || contestingSeats.some((seat) => !Number.isSafeInteger(seat.stack) || seat.stack !== 0 || !Number.isSafeInteger(seat.currentBet) || seat.currentBet < 0 || seat.currentBet > hand.currentBet)) {
    throw new Error('An all-in runout requires a settled round with only all-in contestants');
  }
  if (!Array.isArray(hand.communityCards) || hand.communityCards.length !== expectedCommunityCards || !Array.isArray(hand.burnedCards) || hand.burnedCards.length !== expectedBurnedCards || !Array.isArray(hand.remainingDeck) || !Number.isSafeInteger(hand.pot) || hand.pot < 0 || !Number.isSafeInteger(hand.streetPot) || hand.streetPot < 0 || hand.pot !== hand.streetPot + hand.seats.reduce((total, seat) => total + seat.currentBet, 0)) {
    throw new Error('An all-in runout requires consistent postflop betting state');
  }
  const dealtCards = hand.seats.filter((seat) => seat?.holeCards).flatMap((seat) => seat.holeCards!);
  const allCards = [...dealtCards, ...hand.communityCards, ...hand.burnedCards, ...hand.remainingDeck];
  if (allCards.length !== 52 || new Set(allCards.map((card) => `${card?.rank}-${card?.suit}`)).size !== 52 || allCards.some((card) => !card || !rankValues.has(card.rank) || !suits.includes(card.suit))) {
    throw new Error('An all-in runout requires 52 distinct valid private cards');
  }

  const cardsNeeded = 5 - hand.communityCards.length;
  const burnsNeeded = cardsNeeded;
  if (hand.remainingDeck.length < cardsNeeded + burnsNeeded) throw new Error('An all-in runout requires enough private deck cards');
  const communityCards = [...hand.communityCards];
  const burnedCards = [...hand.burnedCards];
  let remainingDeck = [...hand.remainingDeck];
  for (let index = 0; index < cardsNeeded; index += 1) {
    const [burn, communityCard, ...afterDeal] = remainingDeck;
    burnedCards.push(burn);
    communityCards.push(communityCard);
    remainingDeck = afterDeal;
  }
  return attachPrivateHandState({
    ...hand,
    currentActorSeat: hand.dealerSeat,
    currentBet: 0,
    minimumRaiseIncrement: hand.bigBlindAmount,
    seats: hand.seats.map((seat) => ({ ...seat, currentBet: 0, holeCards: seat.holeCards && [cloneCard(seat.holeCards[0]), cloneCard(seat.holeCards[1])] as [Card, Card] })),
  }, {
    street: 'showdown', communityCards, remainingDeck, burnedCards,
    bigBlindAmount: hand.bigBlindAmount, streetPot: hand.pot, pendingActorSeats: [], raiseLockedSeats: [],
  });
}

export interface ShowdownPot {
  amount: number;
  eligibleSeatNumbers: readonly number[];
  winnerSeatNumbers: readonly number[];
}

export interface SettledShowdown {
  pot: 0;
  seats: readonly StartedHandSeat[];
  pots: readonly ShowdownPot[];
  uncalledReturns: readonly { seatNumber: number; amount: number }[];
}

/** Constructs main/side pots from total commitments and awards each eligible showdown winner. */
export function settleShowdown(hand: StartedHand): SettledShowdown {
  if (!authoritativeHands.has(hand) || hand.street !== 'showdown' || hand.communityCards.length !== 5 || hand.pendingActorSeats.length !== 0) {
    throw new Error('Showdown settlement requires authoritative settled showdown state');
  }
  if (!Number.isSafeInteger(hand.pot) || hand.pot < 0 || hand.seats.some((seat) => (!seat.holeCards && seat.totalCommitted > 0) || !Number.isSafeInteger(seat.totalCommitted) || seat.totalCommitted < 0 || !Number.isSafeInteger(seat.stack) || seat.stack < 0)) {
    throw new Error('Showdown settlement requires valid committed chips and hole cards');
  }
  const committed = hand.seats.reduce((total, seat) => total + seat.totalCommitted, 0);
  if (!Number.isSafeInteger(committed) || committed !== hand.pot) throw new Error('Showdown pot must equal total committed chips');
  const levels = [...new Set(hand.seats.map((seat) => seat.totalCommitted).filter((amount) => amount > 0))].sort((left, right) => left - right);
  let priorLevel = 0;
  const uncalledReturns: { seatNumber: number; amount: number }[] = [];
  const pots = levels.flatMap((level) => {
    const contributors = hand.seats.filter((seat) => seat.totalCommitted >= level);
    const amount = (level - priorLevel) * contributors.length;
    priorLevel = level;
    if (contributors.length === 1) {
      uncalledReturns.push({ seatNumber: contributors[0].seatNumber, amount });
      return [];
    }
    const eligible = contributors.filter((seat) => !seat.isFolded);
    if (!Number.isSafeInteger(amount) || amount <= 0 || eligible.length === 0) throw new Error('Showdown pots require eligible players and safe amounts');
    let winners = [eligible[0]];
    for (const contender of eligible.slice(1)) {
      const comparison = compareBestFiveCardHands([...contender.holeCards!, ...hand.communityCards], [...winners[0].holeCards!, ...hand.communityCards]);
      if (comparison === 1) winners = [contender];
      else if (comparison === 0) winners.push(contender);
    }
    return [{ amount, eligibleSeatNumbers: eligible.map((seat) => seat.seatNumber), winnerSeatNumbers: winners.map((seat) => seat.seatNumber) }];
  });
  const stacks = new Map(hand.seats.map((seat) => [seat.seatNumber, seat.stack]));
  for (const returned of uncalledReturns) stacks.set(returned.seatNumber, stacks.get(returned.seatNumber)! + returned.amount);
  for (const pot of pots) {
    const share = Math.floor(pot.amount / pot.winnerSeatNumbers.length);
    let remainder = pot.amount % pot.winnerSeatNumbers.length;
    const dealerIndex = hand.seats.findIndex((seat) => seat.seatNumber === hand.dealerSeat);
    if (dealerIndex === -1) throw new Error('Showdown settlement requires a seated dealer');
    const clockwiseWinners = [...pot.winnerSeatNumbers].sort((left, right) => {
      const leftIndex = hand.seats.findIndex((seat) => seat.seatNumber === left);
      const rightIndex = hand.seats.findIndex((seat) => seat.seatNumber === right);
      return ((leftIndex - dealerIndex - 1 + hand.seats.length) % hand.seats.length) - ((rightIndex - dealerIndex - 1 + hand.seats.length) % hand.seats.length);
    });
    for (const seatNumber of clockwiseWinners) stacks.set(seatNumber, stacks.get(seatNumber)! + share + (remainder-- > 0 ? 1 : 0));
  }
  return Object.freeze({
    pot: 0 as const,
    seats: Object.freeze(hand.seats.map((seat) => Object.freeze({ ...seat, stack: stacks.get(seat.seatNumber)!, ...(seat.isFolded ? { holeCards: undefined } : {}) }))),
    pots: Object.freeze(pots.map((pot) => Object.freeze({ ...pot, eligibleSeatNumbers: Object.freeze(pot.eligibleSeatNumbers), winnerSeatNumbers: Object.freeze(pot.winnerSeatNumbers) }))),
    uncalledReturns: Object.freeze(uncalledReturns.map((returned) => Object.freeze({ ...returned }))),
  });
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
