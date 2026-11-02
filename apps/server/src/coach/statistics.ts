import type { CoachHand, Metric } from './types.js';

const definitions = [
  ['vpip', 'VPIP', 'כניסה מרצון לקופה בפרה־פלופ, בתשלום או העלאה; בליינדים כפויים אינם נספרים.'],
  ['pfr', 'PFR', 'ידיים שבהן בוצעה העלאה בפרה־פלופ, מתוך הידיים עם אפשרות לפעול.'],
  ['threeBet', '3-Bet', 'העלאה מול העלאה ראשונה: מתוך הידיים שבהן הייתה אפשרות אמיתית להעלות מול העלאה אחת.'],
  ['foldToThreeBet', 'Fold to 3-Bet', 'פרישה מול העלאה חוזרת לאחר שהשחקן ביצע את ההעלאה הראשונה.'],
  ['callOpen', 'Call Open Raise', 'שולם מול העלאה ראשונה, בלי השקעה מרצון קודמת ביד.'],
  ['openRaise', 'Open Raise', 'העלאה ראשונה בקופה שטרם נכנס אליה שחקן מרצונו.'],
  ['limp', 'Limp', 'שולם בפרה־פלופ לפני העלאה כלשהי.'],
  ['squeeze', 'Squeeze', 'העלאה מול העלאה ראשונה ושולם אחד לפחות, בלי השקעה קודמת מרצון.'],
  ['steal', 'Steal Attempt', 'פתיחה בהעלאה מ־CO, BTN או SB בקופה שלא נפתחה.'],
  ['foldToSteal', 'Fold to Steal', 'פרישה מבליינד מול פתיחה יחידה מעמדה מאוחרת.'],
  ['flopCbet', 'Flop C-Bet', 'הימור ראשון בפלופ של המעלה האחרון בפרה־פלופ; רק כשלא היה הימור קודם.'],
  ['turnCbet', 'Turn C-Bet', 'המשך הימור בטרן אחרי C-Bet בפלופ שלא נענה בהעלאה, בלי הימור לפניו בטרן.'],
  ['foldToCbet', 'Fold to C-Bet', 'פרישה בהזדמנות הראשונה מול הימור המשך בפלופ או בטרן, לפני העלאה נוספת.'],
  ['aggressionFrequency', 'Aggression Frequency', 'הימורים והעלאות מתוך הימורים, העלאות, תשלומים ופרישות אחרי הפלופ. צ׳קים אינם במכנה.'],
  ['checkRaise', 'Check-Raise', 'העלאה אחרי צ׳ק באותו רחוב, מתוך ההזדמנויות שבהן הייתה אפשרות להעלות מול הימור.'],
  ['wtsd', 'WTSD', 'הגעה לשואודאון מתוך הידיים שבהן השחקן ראה פלופ.'],
  ['wsd', 'W$SD', 'זכייה בחלק מקופה בשואודאון מתוך ההגעות לשואודאון; כולל פיצול קופה.'],
  ['wwsf', 'WWSF', 'זכייה בחלק מקופה מתוך הידיים שבהן השחקן ראה פלופ.'],
] as const;
const round = (n: number) => Math.round(n * 100) / 100;

/** All metrics use observed opportunities, never LLM arithmetic. One preflop
 * opportunity per hand/metric; postflop opportunities per street encounter.
 * Blinded/all-in-without-choice seats are not voluntary opportunities.
 */
export function calculateStatistics(hands: readonly CoachHand[], playerId: string) {
  const counts = new Map<string, { n: number; d: number }>(definitions.map(([key]) => [key, { n: 0, d: 0 }]));
  let aggression = 0, calls = 0;
  const positions = new Map<string, { hands: number; net: number }>();
  const sizes = new Map<string, { count: number; total: number }>();
  const streets = new Map<string, { opportunities: number; bets: number }>();
  const observe = (key: string, yes: boolean) => { const value = counts.get(key)!; value.d++; if (yes) value.n++; };
  const ownHands = hands.filter((h) => h.players.some((p) => p.playerId === playerId));
  for (const hand of ownHands) {
    if (hand.warnings.some((w) => w.includes('אינם זמינים'))) continue;
    const ownActions = hand.actions.filter((a) => a.playerId === playerId);
    const pf = hand.actions.filter((a) => a.street === 'preflop');
    const firstOwn = pf.find((a) => a.playerId === playerId);
    const isRaise = (a: typeof pf[number]) => (a.type === 'raise' || a.type === 'all-in') && a.raiseTo > 0 && a.amount > a.toCall;
    const isVoluntary = (a: typeof pf[number]) => (a.type === 'call' || a.type === 'raise' || a.type === 'all-in') && a.amount > 0;
    const ownPf = pf.filter((a) => a.playerId === playerId);
    if (firstOwn) {
      observe('vpip', ownPf.some(isVoluntary)); observe('pfr', ownPf.some(isRaise));
      const prior = pf.filter((a) => a.sequence < firstOwn.sequence);
      const unopened = !prior.some(isVoluntary);
      if (unopened && firstOwn.canRaise) observe('openRaise', isRaise(firstOwn));
      if (!prior.some(isRaise) && firstOwn.toCall > 0) observe('limp', firstOwn.type === 'call' || (firstOwn.type === 'all-in' && !isRaise(firstOwn)));
      if (unopened && firstOwn.canRaise && ['CO', 'BTN', 'SB', 'BTN/SB'].includes(positionOf(hand, playerId))) observe('steal', isRaise(firstOwn));
    }
    let threeObserved = false, foldThreeObserved = false;
    for (const own of ownPf) {
      const prior = pf.filter((a) => a.sequence < own.sequence);
      const raises = prior.filter(isRaise);
      const voluntaryPrior = prior.some((a) => a.playerId === playerId && isVoluntary(a));
      if (raises.length === 1 && raises[0].playerId !== playerId) {
        if (own.canRaise && !threeObserved) { observe('threeBet', isRaise(own)); threeObserved = true; }
        if (!voluntaryPrior) {
          observe('callOpen', own.type === 'call' || (own.type === 'all-in' && !isRaise(own)));
          if (own.canRaise && prior.some((a) => a.sequence > raises[0].sequence && a.type === 'call')) observe('squeeze', isRaise(own));
          if (['SB', 'BB', 'BTN/SB'].includes(positionOf(hand, playerId)) && ['CO', 'BTN', 'SB', 'BTN/SB'].includes(positionOf(hand, raises[0].playerId))
            && !prior.some((a) => a.sequence < raises[0].sequence && isVoluntary(a))) observe('foldToSteal', own.type === 'fold');
        }
      }
      if (raises.length === 2 && raises[0].playerId === playerId && raises[1].playerId !== playerId && !foldThreeObserved && own.toCall > 0) {
        observe('foldToThreeBet', own.type === 'fold'); foldThreeObserved = true;
      }
    }
    const pfAggressor = pf.filter(isRaise).at(-1)?.playerId;
    let flopCbetter: string | undefined;
    let flopUnraised = true;
    for (const street of ['flop', 'turn', 'river']) {
      const actions = hand.actions.filter((a) => a.street === street);
      let cbetter: string | undefined;
      let cbetActive = false;
      const seen = new Set<string>();
      let betCount = 0;
      for (const action of actions) {
        const raising = isRaise(action);
        const candidate = street === 'flop' ? pfAggressor : street === 'turn' && flopUnraised ? flopCbetter : undefined;
        if (candidate === action.playerId && betCount === 0 && !seen.has(action.playerId) && action.activePlayers >= 2) {
          if (action.playerId === playerId && action.canRaise) observe(street === 'flop' ? 'flopCbet' : 'turnCbet', raising);
          if (raising) { cbetter = action.playerId; cbetActive = true; if (street === 'flop') flopCbetter = action.playerId; }
        }
        if (action.playerId === playerId) {
          const previousOwn = actions.filter((a) => a.playerId === playerId && a.sequence < action.sequence);
          if (cbetActive && cbetter !== playerId && action.toCall > 0 && !previousOwn.some((a) => a.toCall > 0)) observe('foldToCbet', action.type === 'fold');
          if (action.toCall > 0 && action.canRaise && previousOwn.some((a) => a.type === 'check') && !previousOwn.some((a) => a.toCall > 0)) observe('checkRaise', raising);
          if (raising || action.type === 'call' || action.type === 'fold' || action.type === 'all-in') observe('aggressionFrequency', raising);
          if (raising) aggression++;
          if (action.type === 'call' || (action.type === 'all-in' && !raising)) calls++;
        }
        if (raising) { if (betCount > 0) { cbetActive = false; if (street === 'flop') flopUnraised = false; } betCount++; }
        seen.add(action.playerId);
      }
    }
    for (const a of ownActions) {
      const sizing = sizes.get(a.type) ?? { count: 0, total: 0 };
      if (a.amount > 0) { sizing.count++; sizing.total += a.amount; sizes.set(a.type, sizing); }
      const s = streets.get(a.street) ?? { opportunities: 0, bets: 0 };
      s.opportunities++; if (isRaise(a)) s.bets++; streets.set(a.street, s);
    }
    const outcome = hand.ownPlayerId === playerId ? hand : hand.players.find((p) => p.playerId === playerId)?.outcome;
    if (outcome?.sawFlop) { observe('wtsd', outcome.wentToShowdown); observe('wwsf', outcome.won); }
    if (outcome?.wentToShowdown) observe('wsd', outcome.won);
    const pos = positionOf(hand, playerId);
    if (outcome) { const group = positions.get(pos) ?? { hands: 0, net: 0 }; group.hands++; group.net += outcome.net; positions.set(pos, group); }
  }
  const metrics: Metric[] = definitions.map(([key, label, explanation]) => {
    const { n, d } = counts.get(key)!;
    return { key, label, explanation, occurrences: n, opportunities: d, value: d ? round(n / d * 100) : null,
      unit: '%', reliability: d === 0 ? 'none' : d < 30 ? 'low' : d < 100 ? 'medium' : 'high' };
  });
  metrics.push({ key: 'af', label: 'Aggression Factor', explanation: 'מספר ההימורים וההעלאות אחרי הפלופ חלקי מספר התשלומים. ללא תשלומים אין יחס סופי שניתן להציג.', occurrences: aggression, opportunities: calls, value: calls ? round(aggression / calls) : null, unit: 'ratio', reliability: calls ? calls < 30 ? 'low' : 'medium' : 'none' });
  const outcomeOf = (h: CoachHand) => h.ownPlayerId === playerId ? h : h.players.find((p) => p.playerId === playerId)?.outcome;
  const net = round(ownHands.reduce((sum, h) => sum + (outcomeOf(h)?.net ?? 0), 0));
  return { metrics, dealt: ownHands.length, voluntary: counts.get('vpip')!.n, wins: ownHands.filter((h) => outcomeOf(h)?.won).length,
    losses: ownHands.filter((h) => (outcomeOf(h)?.net ?? 0) < 0).length, pokerNet: net,
    bb100: ownHands.length ? round(100 * ownHands.reduce((sum, h) => sum + (outcomeOf(h)?.net ?? 0) / h.bigBlind, 0) / ownHands.length) : null,
    positions: [...positions].map(([position, p]) => ({ position, ...p, net: round(p.net) })),
    betSizes: [...sizes].map(([type, s]) => ({ type, count: s.count, average: round(s.total / s.count) })),
    streets: [...streets].map(([street, s]) => ({ street, ...s, frequency: round(s.bets / s.opportunities * 100) })),
    excludedIncompleteHands: ownHands.filter((h) => h.warnings.some((w) => w.includes('אינם זמינים'))).length,
  };
}

function positionOf(hand: CoachHand, playerId: string) {
  if (playerId === hand.ownPlayerId) return hand.position;
  const seats = [...hand.players].sort((a, b) => a.seatNumber - b.seatNumber);
  const offset = (seats.findIndex((p) => p.playerId === playerId) - seats.findIndex((p) => p.seatNumber === hand.dealerSeat) + seats.length) % seats.length;
  if (offset === 0) return seats.length === 2 ? 'BTN/SB' : 'BTN';
  if (seats.length === 2 || offset === 2) return 'BB';
  if (offset === 1) return 'SB';
  return offset === seats.length - 1 ? 'CO' : 'early';
}
