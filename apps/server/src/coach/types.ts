export const ENGINE_VERSION = 'coach-v1.0.0';
export type Card = { rank: string; suit: string };
export type Street = 'preflop' | 'flop' | 'turn' | 'river';
export type Seat = { playerId: string; seatNumber: number; stack: number; currentBet: number; totalCommitted: number; isFolded: boolean };
export type Action = { sequence: number; playerId: string; type: string; amount: number; raiseTo: number };
export type Decision = {
  id: string; handKey: string; playerId: string; street: Street; position: string;
  board: Card[]; ownCards: (Card | null)[]; pot: number; stack: number; stackBB: number;
  toCall: number; activePlayers: number; currentBet: number; bigBlind: number;
  seats: Seat[]; minRaiseTo: number | null; maxRaiseTo: number | null;
  canRaise: boolean; priorActions: (Action & { street: Street })[]; action: Action;
};
export type CoachHand = {
  key: string; number: number; bigBlind: number; dealerSeat: number; ownPlayerId: string;
  position: string; dealt: boolean; ownCards: (Card | null)[];
  players: { playerId: string; seatNumber: number; displayName: string; folded: boolean; holeCards: (Card | null)[];
    outcome?: { sawFlop: boolean; wentToShowdown: boolean; won: boolean; net: number } }[];
  actions: (Action & { street: Street; pot: number; toCall: number; canRaise: boolean; activePlayers: number })[];
  decisions: Decision[]; board: Card[]; sawFlop: boolean; wentToShowdown: boolean;
  won: boolean; net: number; warnings: string[];
};
export const DIMENSIONS = ['preflop', 'postflop', 'position', 'sizing', 'aggression', 'valueBluff', 'adaptation'] as const;
export type Dimension = typeof DIMENSIONS[number];
export type Evaluation = {
  decisionId: string; rating: 'excellent' | 'good' | 'reasonable' | 'borderline' | 'small_mistake' | 'major_mistake' | 'severe_mistake' | 'uncertain';
  confidence: 'low' | 'medium' | 'high'; dimensions: Dimension[];
  explanation: string; alternative: string; assumptions: string; nextTime: string;
};
export type HandAnalysis = { handKey: string; summary: string; evaluations: Evaluation[] };
export type Metric = { key: string; label: string; explanation: string; occurrences: number; opportunities: number; value: number | null; unit: '%' | 'ratio' | 'chips' | 'count' | 'BB/100'; reliability: 'none' | 'low' | 'medium' | 'high' };
export type StoredCoachHand = { hand: CoachHand; analysis: HandAnalysis };
