import { z } from 'zod';
import { DIMENSIONS, ENGINE_VERSION, type CoachHand, type Evaluation, type StoredCoachHand } from './types.js';
import { calculateStatistics } from './statistics.js';

const text = z.string().trim().min(1).max(1600);
export const evaluationSchema = z.object({
  decisionId: z.string().max(100),
  rating: z.enum(['excellent', 'good', 'reasonable', 'borderline', 'small_mistake', 'major_mistake', 'severe_mistake', 'uncertain']),
  confidence: z.enum(['low', 'medium', 'high']), dimensions: z.array(z.enum(DIMENSIONS)).min(1).max(7),
  explanation: text, alternative: text, assumptions: text, nextTime: text,
}).strict();
export const batchSchema = z.object({ hands: z.array(z.object({
  handKey: z.string().max(100), summary: text, evaluations: z.array(evaluationSchema).max(200),
}).strict()).max(6) }).strict();
const insight = z.object({ title: z.string().min(1).max(160), explanation: text, decisionIds: z.array(z.string().max(100)).min(1).max(12), exercise: text }).strict();
export const narrativeSchema = z.object({
  summary: text, style: text, strengths: z.array(insight).max(8), improvements: z.array(insight).max(8),
  nextGame: z.array(insight).max(8), opponents: z.array(z.object({ playerId: z.string().max(100), explanation: text }).strict()).max(9),
}).strict();

export function validateBatch(value: unknown, hands: readonly CoachHand[]) {
  const parsed = batchSchema.parse(value);
  if (parsed.hands.length !== hands.length) throw new Error('AI_INVALID_REFERENCES');
  const seen = new Set<string>();
  for (const result of parsed.hands) {
    const hand = hands.find((h) => h.key === result.handKey);
    if (!hand || seen.has(hand.key)) throw new Error('AI_INVALID_REFERENCES');
    seen.add(hand.key);
    const expected = new Set(hand.decisions.map((d) => d.id));
    if (result.evaluations.length !== expected.size) throw new Error('AI_INCOMPLETE_DECISIONS');
    for (const e of result.evaluations) {
      if (!expected.delete(e.decisionId)) throw new Error('AI_INVALID_REFERENCES');
      if (new Set(e.dimensions).size !== e.dimensions.length) throw new Error('AI_INVALID_REFERENCES');
      const decision = hand.decisions.find((d) => d.id === e.decisionId)!;
      if (e.dimensions.includes('preflop') && decision.street !== 'preflop') throw new Error('AI_INVALID_REFERENCES');
      if (e.dimensions.includes('postflop') && decision.street === 'preflop') throw new Error('AI_INVALID_REFERENCES');
    }
  }
  return parsed.hands;
}

export function validateNarrative(value: unknown, stored: readonly StoredCoachHand[], allowedIds?: ReadonlySet<string>) {
  const parsed = narrativeSchema.parse(value);
  const ids = new Set(stored.flatMap((h) => h.hand.decisions.map((d) => d.id)));
  for (const item of [...parsed.strengths, ...parsed.improvements, ...parsed.nextGame]) {
    if (item.decisionIds.some((id) => !ids.has(id) || allowedIds && !allowedIds.has(id))) throw new Error('AI_INVALID_REFERENCES');
  }
  const opponents = new Map<string, number>();
  for (const { hand } of stored) for (const a of hand.actions) {
    if (a.playerId !== hand.ownPlayerId) opponents.set(a.playerId, (opponents.get(a.playerId) ?? 0) + 1);
  }
  if (parsed.opponents.some((p) => (opponents.get(p.playerId) ?? 0) < 30)) throw new Error('AI_INVALID_REFERENCES');
  return { ...parsed, opponents: parsed.opponents.map((p) => ({ ...p, evidenceCount: opponents.get(p.playerId)! })) };
}

const points: Record<Evaluation['rating'], number | null> = { excellent: 100, good: 90, reasonable: 80, borderline: 65, small_mistake: 50, major_mistake: 25, severe_mistake: 0, uncertain: null };
const weights = { low: 0.25, medium: 0.6, high: 1 };
export function calculateScores(evaluations: readonly Evaluation[]) {
  function score(items: readonly Evaluation[], minimum: number) {
    const eligible = items.filter((e) => points[e.rating] !== null && e.confidence !== 'low');
    const weight = eligible.reduce((sum, e) => sum + weights[e.confidence], 0);
    return { score: eligible.length < minimum ? null : Math.round(eligible.reduce((sum, e) => sum + points[e.rating]! * weights[e.confidence], 0) / weight),
      opportunities: items.length, evaluated: eligible.length, confidence: eligible.length < minimum ? 'none' : eligible.length < 30 ? 'low' : eligible.length < 100 ? 'medium' : 'high' };
  }
  return { overall: score(evaluations, 5), domains: DIMENSIONS.map((domain) => ({ domain, ...score(evaluations.filter((e) => e.dimensions.includes(domain)), 3) })),
    rubric: 'coach-v1: מצוין 100, טוב 90, סביר 80, גבולי 65, טעות קטנה 50, משמעותית 25, חמורה 0. ממוצע משוקלל בביטחון: בינוני 0.6, גבוה 1. ביטחון נמוך/לא ניתן להעריך אינם מקבלים ציון. דרושות 5 החלטות לציון כללי ו־3 לתחום. התוצאה הכספית אינה חלק מהציון. זהו אומדן אימון, לא דירוג GTO ולא תחליף ל־Solver.' };
}

export function buildFinalReport(stored: readonly StoredCoachHand[], identity: { playerId: string; displayName: string; date: string; participants: number; net: number }, narrative: ReturnType<typeof validateNarrative>, model: string) {
  const evaluations = stored.flatMap((s) => s.analysis.evaluations);
  return {
    version: ENGINE_VERSION, model, generatedAt: new Date().toISOString(), identity,
    statistics: calculateStatistics(stored.map((s) => s.hand), identity.playerId),
    opponentsStatistics: [...new Set(stored.flatMap((s) => s.hand.players.map((p) => p.playerId)))].filter((id) => id !== identity.playerId).map((id) => ({ playerId: id, ...calculateStatistics(stored.map((s) => s.hand), id) })),
    scores: calculateScores(evaluations), narrative,
    hands: stored.map(({ hand, analysis }) => ({ ...hand, analysis })),
    disclaimer: 'הערכה אסטרטגית של AI, לא Solver. החלטות נבחנו בלי מידע עתידי. מדגם קטן עלול להטעות; ניצחון או הפסד אינם הוכחה לאיכות החלטה. נתוני הרווח בפוקר אינם כוללים חיובי ג׳קפוט; הרווח הסופי בחשבון מוצג בנפרד.',
  };
}
export type FinalReport = ReturnType<typeof buildFinalReport>;
