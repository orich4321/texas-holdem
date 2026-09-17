'use client';

import { useEffect, useMemo, useState } from 'react';

declare const process: { env: { NEXT_PUBLIC_GAME_URL?: string; NEXT_PUBLIC_SERVER_URL?: string } };

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? process.env.NEXT_PUBLIC_GAME_URL ?? 'http://localhost:3001';

type Card = { rank: string; suit: string };
type PlayerAction = { type: 'check' | 'call' | 'fold' | 'all-in' } | { type: 'raise'; raiseTo: number };
type Showdown = {
  winners: readonly { seatNumber: number; playerId: string; playerName: string; chipsWon: number }[];
  pots: readonly { amount: number; winnerSeatNumbers: readonly number[] }[];
};
type PlayerView = {
  playerId: string;
  street: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  dealerSeat: number;
  currentActorSeat: number;
  communityCards: readonly Card[];
  pot: number;
  toCall: number;
  holeCards: readonly [Card, Card];
  seats: readonly { seatNumber: number; playerId: string; playerName: string; stack: number; currentBet: number; isFolded: boolean }[];
  showdown?: Showdown;
};
const streetNames: Record<PlayerView['street'], string> = {
  preflop: 'לפני הפלופ', flop: 'פלופ', turn: 'טרן', river: 'ריבר', showdown: 'חשיפה',
};
const suits: Record<string, string> = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };

function isCard(value: unknown): value is Card {
  return value !== null && typeof value === 'object'
    && typeof (value as Record<string, unknown>).rank === 'string'
    && typeof (value as Record<string, unknown>).suit === 'string';
}

function isPlayerView(value: unknown): value is PlayerView {
  if (value === null || typeof value !== 'object') return false;
  const view = value as Record<string, unknown>;
  return typeof view.playerId === 'string'
    && typeof view.street === 'string'
    && typeof view.dealerSeat === 'number'
    && typeof view.currentActorSeat === 'number'
    && typeof view.pot === 'number'
    && typeof view.toCall === 'number'
    && Array.isArray(view.communityCards) && view.communityCards.every(isCard)
    && Array.isArray(view.holeCards) && view.holeCards.length === 2 && view.holeCards.every(isCard)
    && Array.isArray(view.seats);
}

function PlayingCard({ card, hidden = false, placeholder = false }: { card?: Card; hidden?: boolean; placeholder?: boolean }) {
  if (placeholder) return <span className="playing-card playing-card-slot" aria-hidden="true" />;
  if (hidden || !card) return <span className="playing-card playing-card-back" aria-label="קלף סגור">♠</span>;
  const suit = suits[card.suit] ?? '?';
  const red = card.suit === 'hearts' || card.suit === 'diamonds';
  return <span className={`playing-card${red ? ' playing-card-red' : ''}`} aria-label={`${card.rank} ${card.suit}`}><b>{card.rank}</b><i>{suit}</i></span>;
}

export default function TableClient({ joinId, isHost }: { joinId: string; isHost: boolean }) {
  const [view, setView] = useState<PlayerView>();
  const [status, setStatus] = useState('מתחברים לשולחן…');
  const [raiseTo, setRaiseTo] = useState('');
  const [pending, setPending] = useState(false);
  const [startingNextHand, setStartingNextHand] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/game`, { credentials: 'include', cache: 'no-store' });
        const next = await response.json();
        if (!response.ok || !isPlayerView(next)) throw new Error('Invalid player view');
        if (!active) return;
        setView(next);
        setStatus(next.street === 'showdown' ? 'היד הסתיימה' : 'מחוברים לשולחן');
      } catch {
        if (active) setStatus('החיבור לשולחן נכשל. מרעננים את הדף ומנסים שוב.');
      }
    };
    void refresh();
    const timer = globalThis.setInterval(() => { void refresh(); }, 1_000);
    return () => { active = false; globalThis.clearInterval(timer); };
  }, [joinId]);

  const ownSeat = useMemo(() => view?.seats.find((seat) => seat.playerId === view.playerId), [view]);
  const orderedSeats = useMemo(() => {
    if (!view) return [];
    const ownIndex = view.seats.findIndex((seat) => seat.playerId === view.playerId);
    if (ownIndex < 0) return [...view.seats];
    return [...view.seats.slice(ownIndex), ...view.seats.slice(0, ownIndex)];
  }, [view]);
  const isTurn = Boolean(view && ownSeat && view.currentActorSeat === ownSeat.seatNumber && view.street !== 'showdown');
  const activeSeat = view?.seats.find((seat) => seat.seatNumber === view.currentActorSeat);
  const suggestedRaise = view && ownSeat ? ownSeat.currentBet + view.toCall + 10 : 0;

  async function act(action: PlayerAction) {
    if (!isTurn || pending) return;
    setPending(true);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/game/actions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action),
      });
      const next = await response.json();
      if (!response.ok || !isPlayerView(next)) throw new Error('Action unavailable');
      setView(next);
      setStatus(next.street === 'showdown' ? 'היד הסתיימה' : 'מחוברים לשולחן');
    } catch {
      setStatus('הפעולה לא זמינה כרגע. נסו שוב.');
    } finally {
      setPending(false);
    }
  }

  function submitRaise() {
    const amount = Number(raiseTo || suggestedRaise);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      setStatus('צריך להזין סכום העלאה שלם וחיובי.');
      return;
    }
    void act({ type: 'raise', raiseTo: amount });
  }

  async function startNextHand() {
    if (!isHost || view?.street !== 'showdown' || startingNextHand) return;
    setStartingNextHand(true);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/game/next-hand`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) throw new Error('Next hand unavailable');
      setStatus('מחלקים את היד הבאה…');
    } catch {
      setStatus('לא הצלחנו להתחיל את היד הבאה. נסו שוב.');
    } finally {
      setStartingNextHand(false);
    }
  }

  if (!view) return <main className="table-shell"><p className="table-connection" role="status">{status}</p></main>;

  const turnMessage = view.street === 'showdown'
    ? 'היד הסתיימה — התוצאות מוכנות'
    : isTurn
      ? `התור שלכם${view.toCall ? ` · צריך להשוות ${view.toCall.toLocaleString('he-IL')}` : ' · אפשר לעשות צ׳ק'}`
      : `ממתינים ל${activeSeat?.playerName ?? 'שחקן הבא'}`;

  return (
    <main className="table-shell" dir="rtl">
      <header className="table-header">
        <a href={`/r/${joinId}`}><span aria-hidden="true">♠</span> הולדם חברים</a>
        <div><span>שלב</span><strong>{streetNames[view.street]}</strong></div>
        <div><span>קופה</span><strong>{view.pot.toLocaleString('he-IL')}</strong></div>
      </header>
      <p className={`turn-banner${isTurn ? ' turn-banner-active' : ''}`} role="status" aria-live="polite"><span aria-hidden="true" />{turnMessage}</p>
      <section className="poker-table" aria-label="שולחן טקסס הולדם">
        <div className="table-felt">
          <div className="table-pot"><span>קופה</span><strong>{view.pot.toLocaleString('he-IL')}</strong></div>
          <div className="community-cards" aria-label="קלפי קהילה">
            {Array.from({ length: 5 }, (_, index) => <PlayingCard key={index} card={view.communityCards[index]} placeholder={!view.communityCards[index]} />)}
          </div>
          <div className="table-seats">
            {orderedSeats.map((seat) => {
              const isYou = seat.playerId === view.playerId;
              const isActor = seat.seatNumber === view.currentActorSeat && view.street !== 'showdown';
              return <article key={seat.playerId} className={`table-seat${isYou ? ' table-seat-self' : ''}${isActor ? ' table-seat-active' : ''}${seat.isFolded ? ' table-seat-folded' : ''}`}>
                <span className="seat-number">{seat.seatNumber === view.dealerSeat ? 'D' : seat.seatNumber}</span>
                <strong>{seat.playerName}{isYou ? ' (אתם)' : ''}</strong>
                <small>{seat.isFolded ? 'פרש' : `${seat.stack.toLocaleString('he-IL')} צ׳יפים`}</small>
                {seat.currentBet > 0 ? <em>הימור {seat.currentBet.toLocaleString('he-IL')}</em> : null}
              </article>;
            })}
          </div>
        </div>
      </section>
      <section className="player-panel" aria-label="היד שלכם">
        <div className="your-hand"><p>היד שלכם</p><div className="hole-cards"><PlayingCard card={view.holeCards[0]} /><PlayingCard card={view.holeCards[1]} /></div></div>
        <div className="your-stack"><span>הערימה שלכם</span><strong>{ownSeat?.stack.toLocaleString('he-IL') ?? '—'}</strong><small>צ׳יפים</small></div>
        {status.includes('נכשל') || status.includes('לא זמינה') ? <p className="table-status" role="alert">{status}</p> : null}
        {isTurn ? <div className="action-bar">
          <button type="button" className="action-fold" disabled={pending} onClick={() => void act({ type: 'fold' })}>פרישה</button>
          <button type="button" className="action-primary" disabled={pending} onClick={() => void act(view.toCall === 0 ? { type: 'check' } : { type: 'call' })}>{view.toCall === 0 ? 'צ׳ק' : `השוואה · ${view.toCall.toLocaleString('he-IL')}`}</button>
          <button type="button" className="action-all-in" disabled={pending} onClick={() => void act({ type: 'all-in' })}>אול אין</button>
          <label className="raise-control"><span>העלאה עד</span><input aria-label="סכום העלאה" inputMode="numeric" value={raiseTo} onChange={(event) => setRaiseTo(event.target.value)} placeholder={String(suggestedRaise)} disabled={pending} /><button type="button" disabled={pending} onClick={submitRaise}>העלו</button></label>
        </div> : null}
      </section>
      {view.showdown ? <section className="showdown-panel" aria-live="polite" aria-label="תוצאות היד">
        <p>תוצאות היד</p>
        <h2>{view.showdown.winners.length === 1 ? `${view.showdown.winners[0].playerName} זכה/זכתה ביד` : 'היד התחלקה בין המנצחים'}</h2>
        <ul>
          {view.showdown.winners.map((winner) => <li key={winner.playerId}><strong>{winner.playerName}</strong><span>קיבל/ה {winner.chipsWon.toLocaleString('he-IL')} צ׳יפים</span></li>)}
        </ul>
        {view.showdown.pots.length > 1 ? <small>{view.showdown.pots.map((pot, index) => `קופה ${index + 1}: ${pot.amount.toLocaleString('he-IL')}`).join(' · ')}</small> : null}
        {isHost ? <button type="button" className="next-hand-button" disabled={startingNextHand} onClick={() => void startNextHand()}>{startingNextHand ? 'מחלקים…' : 'התחלת היד הבאה'}</button> : <small>המארח יכול להתחיל את היד הבאה.</small>}
      </section> : null}
    </main>
  );
}
