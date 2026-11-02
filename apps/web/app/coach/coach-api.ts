import { SERVER_URL } from '../account-api';
export const coachPath = (joinId: string) => `${SERVER_URL}/auth/history/${encodeURIComponent(joinId)}/coach`;
export const coachLabels: Record<string, string> = {
  NOT_GENERATED: 'יועץ AI', PENDING: 'ממתין לניתוח', PROCESSING: 'מנתח את המשחק…',
  COMPLETED: 'צפה בדוח AI', FAILED: 'נסה שוב', RATE_LIMITED: 'ממתין למכסת AI',
};
export type CoachState = { status: string; available: boolean; totalHands?: number; completedHands?: number;
  queueState?: 'RUNNING' | 'WAITING' | 'QUOTA_WAIT' | 'RETRY_WAIT';
  overallScore?: number | null; errorCode?: string | null; nextAttemptAt?: string; privacyNotice?: string };

export function coachProgressText(state: CoachState) {
  if (state.queueState === 'RUNNING' || state.status === 'PROCESSING') return 'מנתחים כעת את ההחלטות שלך. ההתקדמות נשמרת אוטומטית.';
  if (state.queueState === 'RETRY_WAIT') return 'הניתוח ממתין לניסיון נוסף. הידיים שכבר נותחו נשמרו.';
  if (state.queueState === 'QUOTA_WAIT' || state.status === 'RATE_LIMITED') return 'ממתינים למכסה החינמית. הניתוח ימשיך אוטומטית כשיתאפשר.';
  return 'הדוח בתור לעיבוד ומתקדם לצד דוחות נוספים. אפשר לסגור את המסך ולחזור מההיסטוריה.';
}
export type Card = { rank: string; suit: string } | null;
export type Evaluation = { decisionId: string; rating: string; confidence: string; dimensions: string[]; explanation: string; alternative: string; assumptions: string; nextTime: string };
export type Insight = { title: string; explanation: string; decisionIds: string[]; exercise: string };
export type CoachReport = {
  version: string; model: string; generatedAt: string; disclaimer: string;
  identity: { playerId: string; displayName: string; date: string; participants: number; net: number };
  scores: { overall: { score: number | null; evaluated: number; opportunities: number; confidence: string }; domains: { domain: string; score: number | null; evaluated: number; confidence: string }[]; rubric: string };
  statistics: { dealt: number; voluntary: number; wins: number; losses: number; pokerNet: number; bb100: number | null; excludedIncompleteHands: number;
    metrics: { key: string; label: string; explanation: string; occurrences: number; opportunities: number; value: number | null; unit: string; reliability: string }[];
    positions: { position: string; hands: number; net: number }[]; betSizes: { type: string; count: number; average: number }[];
    streets: { street: string; opportunities: number; bets: number; frequency: number }[] };
  narrative: { summary: string; style: string; strengths: Insight[]; improvements: Insight[]; nextGame: Insight[]; opponents: { playerId: string; explanation: string; evidenceCount: number }[] };
  hands: { key: string; number: number; position: string; dealt: boolean; ownCards: Card[]; board: Card[]; net: number; warnings: string[];
    players: { playerId: string; displayName: string; holeCards: Card[] }[];
    actions: { sequence: number; playerId: string; type: string; amount: number; raiseTo: number; street: string }[];
    decisions: { id: string; street: string; position: string; ownCards: Card[]; board: Card[]; pot: number; stackBB: number; toCall: number; action: { type: string; amount: number; raiseTo: number } }[];
    analysis: { summary: string; evaluations: Evaluation[] } }[];
};
