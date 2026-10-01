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
  actions: { sequence: number; playerId: string; type: string; amount: number; raiseTo: number }[];
};
const suits: Record<string, string> = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };
const actionNames: Record<string, string> = { fold: 'פרישה', check: 'צ׳ק', call: 'השוואה', raise: 'העלאה', 'all-in': 'אול אין' };

function HistoryCard({ card }: { card: Card }) {
  if (!card) return <span className="playing-card playing-card-back" aria-label="קלף שלא נחשף">♠</span>;
  return <span className={`playing-card${card.suit === 'hearts' || card.suit === 'diamonds' ? ' playing-card-red' : ''}`} aria-label={`${card.rank} ${card.suit}`}><b>{card.rank}</b><i>{suits[card.suit] ?? '?'}</i></span>;
}

export default function HistoryGame({ joinId }: { joinId: string }) {
  const [game, setGame] = useState<HandList>();
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<HandDetail>();
  const [step, setStep] = useState<number>();
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
      .then(async (response) => { if (!response.ok) throw new Error('Hand unavailable'); const hand = await response.json() as HandDetail; setDetail(hand); setStep(hand.actions.length); })
      .catch(() => { if (!controller.signal.aborted) setError('לא הצלחנו לטעון את היד הזאת.'); });
    return () => controller.abort();
  }, [joinId, selected]);
  const activeAction = detail && step !== undefined && step > 0 ? detail.actions[step - 1] : undefined;
  return <main className="history-shell">
    <header className="history-topbar"><Link href="/"><AppBrand compact /></Link><Link href="/history">← כל המשחקים</Link></header>
    <section className="history-panel history-detail-panel"><div className="history-heading"><span>שולחן {joinId.slice(0, 6).toUpperCase()}</span><h1>הידיים שלי</h1><p>בחרו יד, ואז עברו בין הפעולות שלה. קלפים חסויים נשארים סגורים.</p></div>
      {error ? <p role="alert">{error}</p> : null}
      {signInRequired ? <a className="entry-primary" href={googleLoginPath(`/history/${joinId}`)}>התחברות עם Google לצפייה בידיים</a> : null}
      {!game && !error && !signInRequired ? <p role="status">טוענים את המשחק…</p> : null}
      {game?.hands.length === 0 ? <p>עדיין לא הסתיימה יד במשחק הזה.</p> : null}
      <div className="history-hand-picker" aria-label="בחירת יד">{game?.hands.map((hand) => <button type="button" key={hand.key} className={selected === hand.key ? 'is-selected' : ''} onClick={() => { setDetail(undefined); setSelected(hand.key); }}>יד {hand.number}</button>)}</div>
      {detail ? <div className="history-hand-content">
        <div className="history-board"><span>הלוח בסיום היד</span><div>{detail.board.map((card, index) => <HistoryCard card={card} key={index} />)}</div></div>
        <div className="history-hand-players">{detail.players.map((player) => {
          const won = detail.pots.reduce((sum, pot) => sum + pot.payouts.filter((payout) => payout.seatNumber === player.seatNumber).reduce((chips, payout) => chips + payout.amount, 0), 0);
          return <article className={activeAction?.playerId === player.playerId ? 'history-player-active' : ''} key={player.playerId}><div><strong>{player.displayName}</strong><small>{player.folded ? 'פרש/ה' : won ? `זכה/תה ב־${won.toLocaleString('he-IL')} צ׳יפים` : 'בשואודאון'}</small></div><div className="history-hole-cards">{player.holeCards.map((card, index) => <HistoryCard card={card} key={index} />)}</div></article>;
        })}</div>
        <div className="history-pots">{detail.pots.map((pot, index) => <p key={index}>קופה {index + 1}: {pot.amount.toLocaleString('he-IL')} · {pot.payouts.map((payout) => `${detail.players.find((player) => player.seatNumber === payout.seatNumber)?.displayName ?? 'שחקן'} +${payout.amount}`).join(', ')}</p>)}</div>
        <div className="history-timeline"><button type="button" disabled={!step} onClick={() => setStep((current) => Math.max(0, (current ?? 0) - 1))}>הפעולה הקודמת</button><span>{activeAction ? `${detail.players.find((player) => player.playerId === activeAction.playerId)?.displayName ?? 'שחקן'} · ${actionNames[activeAction.type] ?? activeAction.type}${activeAction.raiseTo ? ` ל־${activeAction.raiseTo}` : activeAction.amount ? ` ${activeAction.amount}` : ''}` : 'תחילת היד'}<small>{step ?? 0} / {detail.actions.length}</small></span><button type="button" disabled={step === detail.actions.length} onClick={() => setStep((current) => Math.min(detail.actions.length, (current ?? 0) + 1))}>הפעולה הבאה</button></div>
      </div> : null}
    </section>
  </main>;
}
