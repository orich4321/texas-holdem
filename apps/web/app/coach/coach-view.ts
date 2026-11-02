import type { CoachReport } from './coach-api';
export const evaluationSeverity: Record<string, number> = { excellent: 0, good: 1, reasonable: 2, uncertain: 3, borderline: 4, small_mistake: 5, major_mistake: 6, severe_mistake: 7 };
export type HandFilters = { filter: string; street: string; position: string; certainty: string; sort: string; domain?: string };
export function filterCoachHands(hands: CoachReport['hands'], { filter, street, position, certainty, sort, domain }: HandFilters) {
  return hands.filter((hand) => {
    const es = hand.analysis.evaluations;
    return (filter === 'all' || filter === 'errors' && es.some((e) => evaluationSeverity[e.rating] >= 5) || filter === 'good' && es.some((e) => evaluationSeverity[e.rating] <= 1) || filter === 'severe' && es.some((e) => evaluationSeverity[e.rating] >= 6))
      && (street === 'all' || hand.decisions.some((d) => d.street === street))
      && (position === 'all' || hand.position === position)
      && (!domain || domain === 'all' || es.some((e) => e.dimensions.includes(domain)))
      && (certainty === 'all' || es.some((e) => e.confidence === certainty));
  }).sort((a, b) => sort === 'severity' ? Math.max(-1, ...b.analysis.evaluations.map((e) => evaluationSeverity[e.rating])) - Math.max(-1, ...a.analysis.evaluations.map((e) => evaluationSeverity[e.rating])) || a.number - b.number : a.number - b.number);
}
