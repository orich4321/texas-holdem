'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { coachLabels, coachPath, type Card, type CoachReport, type CoachState, type Insight } from './coach-api';
import { evaluationSeverity as severity, filterCoachHands } from './coach-view';

const ratingNames: Record<string, string> = { excellent: 'טובה מאוד', good: 'טובה', reasonable: 'סבירה', borderline: 'גבולית', small_mistake: 'טעות קטנה', major_mistake: 'טעות משמעותית', severe_mistake: 'טעות חמורה', uncertain: 'לא ניתן להעריך' };
const confidence: Record<string, string> = { none: 'אין מספיק מידע', low: 'נמוכה', medium: 'בינונית', high: 'גבוהה' };
const streets: Record<string, string> = { preflop: 'פרה־פלופ', flop: 'פלופ', turn: 'טרן', river: 'ריבר' };
const actions: Record<string, string> = { fold: 'פרישה', check: 'צ׳ק', call: 'שולם', raise: 'העלאה', 'all-in': 'אול אין' };
const domains: Record<string, string> = { preflop: 'החלטות פרה־פלופ', postflop: 'החלטות אחרי הפלופ', position: 'מודעות לעמדה', sizing: 'גודל הימור', aggression: 'אגרסיביות', valueBluff: 'בלוף וערך', adaptation: 'התאמה ליריבים' };
const suits: Record<string, string> = { spades: '♠', clubs: '♣', hearts: '♥', diamonds: '♦' };
const fmt = (n: number) => n.toLocaleString('he-IL', { maximumFractionDigits: 2 });
const signed = (n: number) => `${n > 0 ? '+' : ''}${fmt(n)}`;

function Cards({ cards }: { cards: Card[] }) {
  return <span className="coach-cards" dir="ltr">{cards.map((card, index) => <span key={index} className={`coach-card${card && ['hearts', 'diamonds'].includes(card.suit) ? ' red' : ''}${card ? '' : ' back'}`} aria-label={card ? `${card.rank} ${card.suit}` : 'קלף מוסתר'}>{card ? <>{card.rank}<i>{suits[card.suit]}</i></> : '♠'}</span>)}</span>;
}

export function CoachScreen({ joinId }: { joinId: string }) {
  const [state, setState] = useState<CoachState>();
  const [report, setReport] = useState<CoachReport>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('overview');
  const [filter, setFilter] = useState('all');
  const [street, setStreet] = useState('all');
  const [position, setPosition] = useState('all');
  const [certainty, setCertainty] = useState('all');
  const [sort, setSort] = useState('number');
  const [domain, setDomain] = useState('all');
  const [selectedHand, setSelectedHand] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      if (document.hidden) { timer = setTimeout(() => void load(), 15_000); return; }
      try {
        const response = await fetch(coachPath(joinId), { credentials: 'include', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 401 ? 'יש להתחבר לחשבון כדי לצפות בדוח האישי.' : response.status === 404 ? 'הדוח אינו זמין: המשחק חייב להסתיים ולהופיע בארכיון שלך.' : 'לא הצלחנו לטעון את היועץ. נסו שוב.');
        const current = await response.json() as CoachState;
        setState(current); setError('');
        if (current.status === 'COMPLETED') {
          const saved = await fetch(`${coachPath(joinId)}/report`, { credentials: 'include', cache: 'no-store', signal: controller.signal });
          if (!saved.ok) throw new Error('לא הצלחנו לפתוח את הדוח השמור.');
          setReport(await saved.json() as CoachReport);
        } else if (['PENDING', 'PROCESSING', 'RATE_LIMITED'].includes(current.status)) {
          const wait = current.nextAttemptAt ? Math.max(15_000, Math.min(60_000, Date.parse(current.nextAttemptAt) - Date.now())) : 15_000;
          timer = setTimeout(() => void load(), wait);
        } else if (current.status === 'FAILED' && current.nextAttemptAt && Date.parse(current.nextAttemptAt) > Date.now()) {
          timer = setTimeout(() => void load(), Math.min(60_000, Date.parse(current.nextAttemptAt) - Date.now() + 100));
        }
      } catch (e) {
        if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : 'שגיאת חיבור.'); timer = setTimeout(() => void load(), 30_000); }
      }
    }
    void load();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [joinId, busy]);

  async function generate() {
    if (busy || !state?.available) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(coachPath(joinId), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error('לא הצלחנו להתחיל בניתוח. בדקו שהמשחק הסתיים ונסו שוב.');
      setState(await response.json() as CoachState);
    } catch (e) { setError(e instanceof Error ? e.message : 'החיבור נכשל.'); }
    finally { setBusy(false); }
  }

  const hands = useMemo(() => filterCoachHands(report?.hands ?? [], { filter, street, position, certainty, sort, domain }), [report, filter, street, position, certainty, sort, domain]);

  function goToDecision(id: string) {
    setTab('hands'); setFilter('all'); setStreet('all'); setPosition('all'); setCertainty('all'); setDomain('all');
    setSelectedHand(id.split(':')[0]);
    setTimeout(() => document.getElementById(`decision-${id}`)?.scrollIntoView({ block: 'center', behavior: 'auto' }), 0);
  }
  function insights(title: string, values: Insight[]) {
    return <section className="coach-section"><h2>{title}</h2>{values.length ? values.map((item, i) => <article className="coach-insight" key={i}><h3>{item.title}</h3><p>{item.explanation}</p><p><b>תרגול: </b>{item.exercise}</p><div>{item.decisionIds.map((id) => <button type="button" key={id} onClick={() => goToDecision(id)}>יד {report?.hands.find((h) => h.key === id.split(':')[0])?.number} ↗</button>)}</div></article>) : <p>אין מספיק ראיות כדי לקבוע דפוס אמין בתחום הזה.</p>}</section>;
  }

  return <main className="coach-shell" dir="rtl"><header className="coach-topbar"><Link href="/">← הבית</Link><span>POKER COACH <i>✧</i></span><Link href={`/history/${encodeURIComponent(joinId)}`}>שחזור המשחק</Link></header>
    {error ? <p className="coach-message" role="alert">{error}</p> : null}
    {!state && !error ? <p role="status">טוענים את היועץ האישי…</p> : null}
    {state && !report ? <section className="coach-intro"><span className="coach-eyebrow">מאמן אישי · ניתוח אחרי המשחק</span><h1>{coachLabels[state.status] ?? 'יועץ AI'}</h1><p>הבחירות שלך, לא המזל שלך.<br />סקירה של כל הידיים, סטטיסטיקות מדויקות ותוכנית למשחק הבא.</p>
      {state.status === 'NOT_GENERATED' || state.status === 'FAILED' ? <>
        <p className="coach-privacy">{state.privacyNotice}</p><p>דוח אחד לכל משחק, נשמר בחשבון שלך. זהו ניתוח AI ולא חישוב Solver.</p>
        {!state.available ? <p className="coach-message">היועץ מוכן באתר, אך עדיין לא הופעל מפתח Gemini מפרויקט חינמי. לא בוצעה קריאת AI ולא נוצר חיוב.</p> : <button type="button" className="coach-primary" disabled={busy || state.nextAttemptAt != null && Date.parse(state.nextAttemptAt) > Date.now()} onClick={() => void generate()}>{busy ? 'מכינים ניתוח…' : state.status === 'FAILED' ? 'המשך מהנקודה שנשמרה' : 'יצירת הדוח האישי שלי'}</button>}
        {state.status === 'FAILED' ? <p>הניתוח נעצר; כל הידיים שכבר נותחו נשמרו. {state.nextAttemptAt ? `אפשר לנסות שוב אחרי ${new Date(state.nextAttemptAt).toLocaleTimeString('he-IL')}.` : ''}</p> : null}
      </> : <div className="coach-progress" role="status"><progress max={state.totalHands || 1} value={state.completedHands || 0} /><strong>{state.completedHands ?? 0} מתוך {state.totalHands ?? 0} ידיים נשמרו</strong><p>{state.status === 'RATE_LIMITED' ? 'ממתינים למכסה החינמית. אין מעבר למסלול בתשלום.' : 'הניתוח ממשיך בשרת. אפשר לסגור את המסך ולחזור מההיסטוריה.'}</p>{state.nextAttemptAt && Date.parse(state.nextAttemptAt) > Date.now() ? <small>ניסיון חוזר לא לפני {new Date(state.nextAttemptAt).toLocaleString('he-IL')}</small> : null}</div>}
    </section> : null}
    {report ? <>
      <section className="coach-hero"><div><span className="coach-eyebrow">הדוח האישי של {report.identity.displayName}</span><h1>לשחק טוב יותר.<br />החלטה אחרי החלטה.</h1><p>{new Date(report.identity.date).toLocaleDateString('he-IL')} · {report.identity.participants} שחקנים · {report.hands.length} ידיים נסקרו</p><small>ביטחון בהערכה: {confidence[report.scores.overall.confidence]}</small></div><div className="coach-score"><strong>{report.scores.overall.score ?? 'N/A'}</strong><span>{report.scores.overall.score == null ? 'אין מספיק החלטות להערכה' : 'איכות החלטות / 100'}</span></div></section>
      <nav className="coach-tabs" aria-label="פרקי הדוח">{[['overview', 'תמונה כללית'], ['stats', 'סטטיסטיקות'], ['hands', 'כל הידיים'], ['plan', 'תוכנית אימון']].map(([id, label]) => <button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}</nav>
      {tab === 'overview' ? <>
        <div className="coach-kpis"><article><span>קלפים חולקו</span><strong>{report.statistics.dealt}</strong></article><article><span>רווח בחשבון — לא ציון</span><strong dir="ltr">{signed(report.identity.net)}</strong></article><article><span dir="ltr">BB/100 — פוקר בלבד</span><strong dir="ltr">{report.statistics.bb100 == null ? 'N/A' : signed(report.statistics.bb100)}</strong></article><article><span>החלטות שנבחנו</span><strong>{report.hands.reduce((n, h) => n + h.analysis.evaluations.length, 0)}</strong></article></div>
        <section className="coach-section"><h2>תמונת המשחק שלך</h2><p>{report.narrative.summary}</p><h3>סגנון המשחק</h3><p>{report.narrative.style}</p></section>
        <section className="coach-section"><h2>מפת הכישורים</h2><div className="coach-domain-grid">{report.scores.domains.map((s) => {
          const examples = report.hands.flatMap((h) => h.analysis.evaluations).filter((e) => e.dimensions.includes(s.domain));
          const best = [...examples].sort((a, b) => severity[a.rating] - severity[b.rating])[0];
          const worst = [...examples].sort((a, b) => severity[b.rating] - severity[a.rating])[0];
          return <article key={s.domain}><span>{domains[s.domain]}</span><strong>{s.score ?? 'N/A'}</strong><progress max="100" value={s.score ?? 0} /><small>{s.evaluated} החלטות · ביטחון {confidence[s.confidence]}</small><details><summary>מה השפיע על ההערכה?</summary>{[...new Map([best, worst].filter((e) => e != null).map((e) => [e.decisionId, e])).values()].map((e) => <div key={e.decisionId}><p><b>{ratingNames[e.rating]}: </b>{e.explanation}</p><p>{e.nextTime}</p></div>)}{examples.length === 0 ? <p>אין מספיק החלטות בתחום זה.</p> : null}</details><button type="button" onClick={() => { setTab('hands'); setFilter('all'); setStreet('all'); setPosition('all'); setCertainty('all'); setDomain(s.domain); }}>צפייה בהחלטות ↗</button></article>;
        })}</div><details><summary>איך מחושב הציון?</summary><p>{report.scores.rubric}</p></details></section>
        {insights('הטעויות המשמעותיות — ומה אפשר לשנות', report.narrative.improvements)}
        {insights('החלטות שכדאי לשמר', report.narrative.strengths)}
        <section className="coach-section"><h2>החלטות בולטות מהמשחק</h2>{[['טעויות לבדיקה', true], ['בחירות מוצלחות', false]].map(([title, mistakes]) => {
          const examples = report.hands.flatMap((h) => h.analysis.evaluations.map((e) => ({ ...e, number: h.number })))
            .filter((e) => mistakes ? severity[e.rating] >= 5 : severity[e.rating] <= 1)
            .sort((a, b) => mistakes ? severity[b.rating] - severity[a.rating] : severity[a.rating] - severity[b.rating]).slice(0, 4);
          return <div key={String(title)}><h3>{title}</h3>{examples.length ? examples.map((e) => <article className="coach-insight" key={e.decisionId}><button type="button" onClick={() => goToDecision(e.decisionId)}>יד {e.number} · {ratingNames[e.rating]} ↗</button><p>{e.explanation}</p></article>) : <p>אין מספיק ראיות להדגשת החלטות מהסוג הזה.</p>}</div>;
        })}</section>
      </> : null}
      {tab === 'stats' ? <section className="coach-section"><h2>מספרים מהמשחק, לא מהמודל</h2><p>בכל מדד מוצגים מספר המופעים ומספר ההזדמנויות האמיתיות. אמינות נמוכה מצביעה על מדגם קטן.</p><p>{report.statistics.dealt} ידיים חולקו · {report.statistics.voluntary} כניסות מרצון · {report.statistics.wins} ידיים עם זכייה בחלק מקופה · {report.statistics.losses} ידיים עם רווח שלילי</p>{report.statistics.excludedIncompleteHands ? <p role="note">{report.statistics.excludedIncompleteHands} ידיים עם ארכיון חלקי לא נכללו במדדים התלויים במידע החסר.</p> : null}<div className="coach-metric-grid">{report.statistics.metrics.map((m) => <article key={m.key}><header><b dir="ltr">{m.label}</b><strong dir="ltr">{m.value == null ? 'N/A' : `${fmt(m.value)}${m.unit === '%' ? '%' : ''}`}</strong></header>{m.unit === '%' ? <progress max="100" value={m.value ?? 0} /> : null}<p>{m.explanation}</p><small>{m.occurrences} מתוך {m.opportunities} · אמינות {confidence[m.reliability]}</small></article>)}</div>
        <h3>רווח בפוקר לפי עמדה</h3><div className="coach-position-list">{report.statistics.positions.map((p) => <article key={p.position}><b dir="ltr">{p.position}</b><span>{p.hands} ידיים</span><strong dir="ltr">{signed(p.net)}</strong></article>)}</div>
        <h3>גדלי תשלום ממוצעים</h3>{report.statistics.betSizes.map((s) => <p key={s.type}>{actions[s.type] ?? s.type}: {fmt(s.average)} צ׳יפים ({s.count} פעולות בתשלום)</p>)}
        <h3>תדירות הימורים לפי רחוב</h3>{report.statistics.streets.map((s) => <p key={s.street}>{streets[s.street]}: {s.bets} מתוך {s.opportunities} פעולות ({fmt(s.frequency)}%)</p>)}
      </section> : null}
      {tab === 'hands' ? <section className="coach-section"><h2>כל הידיים · {hands.length} מתוך {report.hands.length}</h2><div className="coach-filters">
        <label>סינון<select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">כל הידיים</option><option value="errors">עם טעויות</option><option value="good">החלטות טובות</option><option value="severe">טעויות משמעותיות</option></select></label>
        <label>רחוב<select value={street} onChange={(e) => setStreet(e.target.value)}><option value="all">הכול</option>{Object.entries(streets).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>עמדה<select value={position} onChange={(e) => setPosition(e.target.value)}><option value="all">הכול</option>{[...new Set(report.hands.map((h) => h.position))].map((p) => <option key={p}>{p}</option>)}</select></label>
        <label>ביטחון<select value={certainty} onChange={(e) => setCertainty(e.target.value)}><option value="all">הכול</option>{['low', 'medium', 'high'].map((c) => <option key={c} value={c}>{confidence[c]}</option>)}</select></label>
        <label>תחום<select value={domain} onChange={(e) => setDomain(e.target.value)}><option value="all">הכול</option>{Object.entries(domains).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label>מיון<select value={sort} onChange={(e) => setSort(e.target.value)}><option value="number">מספר היד</option><option value="severity">חומרת טעות</option></select></label>
      </div>{hands.map((hand) => <details className="coach-hand" key={hand.key} open={selectedHand === hand.key} onToggle={(e) => { if (e.currentTarget.open) setSelectedHand(hand.key); else if (selectedHand === hand.key) setSelectedHand(undefined); }}><summary><b>יד {hand.number} · <bdi>{hand.position}</bdi></b><Cards cards={hand.ownCards} /><span>{hand.analysis.evaluations.length} החלטות</span></summary><p>{hand.analysis.summary}</p>{hand.warnings.map((w) => <p key={w}>{w}</p>)}
        {hand.decisions.map((d) => { const e = hand.analysis.evaluations.find((item) => item.decisionId === d.id); return <article className={`coach-decision rating-${e?.rating}`} id={`decision-${d.id}`} key={d.id}><header><h3>{streets[d.street]} · {actions[d.action.type] ?? d.action.type}{d.action.raiseTo ? ` ל־${fmt(d.action.raiseTo)}` : d.action.amount ? ` ${fmt(d.action.amount)}` : ''}</h3><span>{e ? ratingNames[e.rating] : 'אין הערכה'} · ביטחון {e ? confidence[e.confidence] : '—'}</span></header><div className="coach-decision-context"><Cards cards={d.board} /><span>קופה {fmt(d.pot)} · ערימה <bdi>{fmt(d.stackBB)} BB</bdi> · לתשלום {fmt(d.toCall)}</span></div>{e ? <><p>{e.explanation}</p><p><b>חלופה: </b>{e.alternative}</p><p><b>הנחות: </b>{e.assumptions}</p><p><b>לפעם הבאה: </b>{e.nextTime}</p></> : null}</article>; })}
        <details className="coach-timeline"><summary>ציר הזמן המלא ותוצאה — בנפרד מהערכת ההחלטות</summary><ol>{hand.actions.map((a) => <li key={a.sequence}>{streets[a.street]} · {hand.players.find((p) => p.playerId === a.playerId)?.displayName ?? 'שחקן'} · {actions[a.type] ?? a.type}{a.raiseTo ? ` ל־${fmt(a.raiseTo)}` : a.amount ? ` ${fmt(a.amount)}` : ''}</li>)}</ol><Cards cards={hand.board} /><p>רווח בפוקר ביד: <bdi>{signed(hand.net)}</bdi></p><div className="coach-visible-hands">{hand.players.map((p) => <div key={p.playerId}><span>{p.displayName}</span><Cards cards={p.holeCards} /></div>)}</div><Link href={`/history/${encodeURIComponent(joinId)}`}>פתיחת נגן השחזור ↗</Link></details>
      </details>)}</section> : null}
      {tab === 'plan' ? <>{insights('נקודות לשימור', report.narrative.strengths)}{insights('נקודות לשיפור', report.narrative.improvements)}{insights('תוכנית למשחק הבא', report.narrative.nextGame)}<section className="coach-section"><h2>התאמה ליריבים</h2>{report.narrative.opponents.length ? report.narrative.opponents.map((o) => <article className="coach-insight" key={o.playerId}><h3>{report.hands.flatMap((h) => h.players).find((p) => p.playerId === o.playerId)?.displayName ?? 'יריב'}</h3><p>{o.explanation}</p><small>{o.evidenceCount} ראיות גלויות</small></article>) : <p>אין מספיק ראיות לקביעת המלצות אמינות מול יריב ספציפי. לא הוסקו דפוסים מקלפים מוסתרים.</p>}</section></> : null}
      <footer className="coach-footer"><p>{report.disclaimer}</p><small>דוח שמור · {report.version} · <bdi>{report.model}</bdi> · {new Date(report.generatedAt).toLocaleDateString('he-IL')}</small></footer>
    </> : null}
  </main>;
}
