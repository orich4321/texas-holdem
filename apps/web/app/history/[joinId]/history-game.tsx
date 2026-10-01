'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { googleLoginPath, SERVER_URL } from '../../account-api';
import { AppBrand } from '../../ui';

type Card = { rank: string; suit: string } | null;
type HandList = { joinId: string; status: string; hands: { key: string; number: number; settledAt: string }[] };
type HandDetail = {
  key: string; board: Card[];
  players: { playerId: string; displayName: string; seatNumber: number; folded: boolean; holeCards: Card[] }[];
  pots: { amount: number; winnerSeatNumbers: number[]; payouts: { seatNumber: number; amount: number }[] }[];
  replay: { sequence: number; kind: string; street: string; board: Card[]; pot: number; actorPlayerId: string;
    action: { type: string; amount: number; raiseTo: number; raiseKind: string } | null;
    players: { playerId: string; stack: number; currentBet: number; totalCommitted: number; folded: boolean; holeCards: Card[] }[] }[];
};
const suits: Record<string, string> = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };
const actionNames: Record<string, string> = { fold: 'פרישה', check: 'צ׳ק', call: 'השוואה', raise: 'העלאה', 'all-in': 'אול אין' };
const streetNames: Record<string, string> = { preflop: 'פרה־פלופ', flop: 'פלופ', turn: 'טרן', river: 'ריבר', showdown: 'שואודאון' };

function HistoryCard({ card }: { card: Card }) {
  if (!card) return <span className="playing-card playing-card-back" aria-label="קלף שלא נחשף">♠</span>;
  return <span className={`playing-card${card.suit === 'hearts' || card.suit === 'diamonds' ? ' playing-card-red' : ''}`} aria-label={`${card.rank} ${card.suit}`}><b>{card.rank}</b><i>{suits[card.suit] ?? '?'}</i></span>;
}

export default function HistoryGame({ joinId, onBack }: { joinId: string; onBack?: () => void }) {
  const [game, setGame] = useState<HandList>();
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<HandDetail>();
  const [step, setStep] = useState<number>();
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string>();
  const [signInRequired, setSignInRequired] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void globalThis.fetch(`${SERVER_URL}/auth/history/${encodeURIComponent(joinId)}`, { credentials: 'include', cache: 'no-store', signal: controller.signal })
      .then(async (response) => { if (response.status === 401) { setSignInRequired(true); return; } if (!response.ok) throw new Error('Game unavailable'); setGame(await response.json() as HandList); })
      .catch(() => { if (!controller.signal.aborted) setError('לא הצלחנו לטעון את המשחק הזה.'); });
    return () => controller.abort();
  }, [joinId]);
  useEffect(() => {
    if (!game?.hands.length) return;
    setSelected(game.hands[game.hands.length - 1].key);
  }, [game]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void globalThis.fetch(`${SERVER_URL}/auth/history/${encodeURIComponent(joinId)}/hands/${encodeURIComponent(selected)}`, { credentials: 'include', cache: 'no-store', signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error('Hand unavailable'); const hand = await response.json() as HandDetail; setDetail(hand); setStep(0); setPlaying(false); })
      .catch(() => { if (!controller.signal.aborted) setError('לא הצלחנו לטעון את היד הזאת.'); });
    return () => controller.abort();
  }, [joinId, selected]);
  useEffect(() => {
    if (!playing || !detail) return;
    const timer = globalThis.setInterval(() => setStep((current) => {
      if ((current ?? 0) >= detail.replay.length - 1) { setPlaying(false); return current; }
      return (current ?? 0) + 1;
    }), 1500);
    return () => globalThis.clearInterval(timer);
  }, [playing, detail]);
  const activeStep = detail?.replay[step ?? 0];
  const actingPlayer = detail?.players.find((player) => player.playerId === activeStep?.actorPlayerId);
  const actionLabel = activeStep?.action ? `${actingPlayer?.displayName ?? 'שחקן'} · ${activeStep.action.raiseKind === 'bet' ? 'הימור' : actionNames[activeStep.action.type] ?? activeStep.action.type}${activeStep.action.raiseTo ? ` ל־${activeStep.action.raiseTo}` : activeStep.action.amount ? ` ${activeStep.action.amount}` : ''}` : '';
  const stepLabel = activeStep?.kind === 'deal' ? 'חולקו קלפים והוצבו בליינדים'
    : activeStep?.kind === 'action' ? actionLabel
      : activeStep?.kind === 'result' ? 'תוצאות היד וחלוקת הקופה'
        : activeStep?.kind === 'reveal' ? `${actingPlayer?.displayName ?? 'שחקן'} חשף/ה קלף`
          : activeStep?.kind === 'rabbit' ? `נחשף ${streetNames[activeStep.street] ?? 'קלף'} להמחשה בלבד`
          : activeStep?.kind === 'board' || activeStep?.kind === 'showdown' ? `נפתח ${streetNames[activeStep.street] ?? 'הלוח'}` : '';
  const content = <section className="history-panel history-detail-panel"><div className="history-heading"><span>שולחן {joinId.slice(0, 6).toUpperCase()}</span><h1>שחזור יד</h1><p>קלפים שנחשפו במשחק גלויים כבר מתחילת השחזור, כדי לראות מה קרה מאחורי הקלעים. קלפים חסויים נשארים סגורים.</p></div>
      {error ? <p role="alert">{error}</p> : null}
      {signInRequired ? <a className="entry-primary" href={googleLoginPath(`/history/${joinId}`)}>התחברות עם Google לצפייה בידיים</a> : null}
      {!game && !error && !signInRequired ? <p role="status">טוענים את המשחק…</p> : null}
      {game?.hands.length === 0 ? <p>עדיין לא הסתיימה יד במשחק הזה.</p> : null}
      <div className="history-hand-picker" aria-label="בחירת יד">{game?.hands.map((hand) => <button type="button" key={hand.key} className={selected === hand.key ? 'is-selected' : ''} onClick={() => { setDetail(undefined); setSelected(hand.key); }}>יד {hand.number}</button>)}</div>
      {detail && activeStep ? <div className="history-hand-content">
        <div className="history-replay-status"><strong>{stepLabel}</strong><span>{streetNames[activeStep.street] ?? activeStep.street} · {activeStep.kind === 'result' ? 'הקופה חולקה' : `קופה ${activeStep.pot.toLocaleString('he-IL')}`}</span></div>
        <div className="history-board"><span>לוח המשחק</span><div>{Array.from({ length: 5 }, (_, index) => <HistoryCard card={activeStep.board[index] ?? null} key={index} />)}</div></div>
        <div className="history-hand-players">{detail.players.map((player) => {
          const won = detail.pots.reduce((sum, pot) => sum + pot.payouts.filter((payout) => payout.seatNumber === player.seatNumber).reduce((chips, payout) => chips + payout.amount, 0), 0);
          const current = activeStep.players.find((seat) => seat.playerId === player.playerId);
          return <article className={activeStep.actorPlayerId === player.playerId && activeStep.kind === 'action' ? 'history-player-active' : ''} key={player.playerId}><div><strong>{player.displayName}</strong><small>{current?.folded ? 'פרש/ה · ' : ''}{(current?.stack ?? 0).toLocaleString('he-IL')} צ׳יפים{current?.currentBet ? ` · הימור ${current.currentBet}` : ''}{activeStep.kind === 'result' && won ? ` · זכה/תה ב־${won.toLocaleString('he-IL')}` : ''}</small></div><div className="history-hole-cards">{(current?.holeCards ?? [null, null]).map((card, index) => <HistoryCard card={card} key={index} />)}</div></article>;
        })}</div>
        {activeStep.kind === 'result' ? <div className="history-pots">{detail.pots.map((pot, index) => <p key={index}>קופה {index + 1}: {pot.amount.toLocaleString('he-IL')} · {pot.payouts.map((payout) => `${detail.players.find((player) => player.seatNumber === payout.seatNumber)?.displayName ?? 'שחקן'} +${payout.amount}`).join(', ')}</p>)}</div> : null}
      </div> : null}
      {detail && activeStep ? <div className="history-replay-controls"><input type="range" min="0" max={Math.max(0, detail.replay.length - 1)} value={step ?? 0} aria-label="מעבר בין שלבי היד" onChange={(event) => { setPlaying(false); setStep(Number(event.target.value)); }} /><div><button type="button" disabled={!step} onClick={() => { setPlaying(false); setStep((current) => Math.max(0, (current ?? 0) - 1)); }}>הקודם</button><button type="button" onClick={() => { if ((step ?? 0) >= detail.replay.length - 1) setStep(0); setPlaying((value) => !value); }}>{playing ? 'עצירה ❚❚' : 'ניגון ▶'}</button><button type="button" disabled={step === detail.replay.length - 1} onClick={() => { setPlaying(false); setStep((current) => Math.min(detail.replay.length - 1, (current ?? 0) + 1)); }}>הבא</button></div><small>{(step ?? 0) + 1} מתוך {detail.replay.length}</small></div> : null}
    </section>;
  if (onBack) return <div className="history-embedded-game"><button type="button" className="history-back-button" onClick={onBack}>← כל המשחקים</button>{content}</div>;
  return <main className="history-shell"><header className="history-topbar"><Link href="/"><AppBrand compact /></Link><Link href="/history">← כל המשחקים</Link></header>{content}</main>;
}
