'use client';

import { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';

declare const process: { env: { NODE_ENV?: string; NEXT_PUBLIC_GAME_URL?: string; NEXT_PUBLIC_SERVER_URL?: string } };

const SERVER_URL = process.env.NODE_ENV === 'production'
  ? '/server'
  : process.env.NEXT_PUBLIC_SERVER_URL ?? process.env.NEXT_PUBLIC_GAME_URL ?? 'http://localhost:3001';

type Card = { rank: string; suit: string };
type PlayerAction = { type: 'check' | 'call' | 'fold' | 'all-in' } | { type: 'raise'; raiseTo: number };
type Showdown = {
  winners: readonly { seatNumber: number; playerId: string; playerName: string; chipsWon: number }[];
  pots: readonly { amount: number; winnerSeatNumbers: readonly number[] }[];
};
type ExposedHand = {
  seatNumber: number;
  playerId: string;
  playerName: string;
  holeCards: readonly [Card, Card];
  reason: 'all-in' | 'winner' | 'voluntary';
};
type AllInRunout = { nextStreet: 'flop' | 'turn' | 'river' | 'showdown' };
type PlayerView = {
  playerId: string;
  street: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  dealerSeat: number;
  currentActorSeat: number;
  communityCards: readonly Card[];
  pot: number;
  toCall: number;
  raise?: { minRaiseTo: number; maxRaiseTo: number; minimumIncrement: number };
  holeCards: readonly [Card, Card];
  seats: readonly { seatNumber: number; playerId: string; playerName: string; stack: number; currentBet: number; isFolded: boolean }[];
  exposedHands: readonly ExposedHand[];
  allInRunout?: AllInRunout;
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

function isExposedHand(value: unknown): value is ExposedHand {
  if (value === null || typeof value !== 'object') return false;
  const hand = value as Record<string, unknown>;
  return typeof hand.seatNumber === 'number'
    && typeof hand.playerId === 'string'
    && typeof hand.playerName === 'string'
    && (hand.reason === 'all-in' || hand.reason === 'winner' || hand.reason === 'voluntary')
    && Array.isArray(hand.holeCards) && hand.holeCards.length === 2 && hand.holeCards.every(isCard);
}

function isAllInRunout(value: unknown): value is AllInRunout {
  return value !== null && typeof value === 'object'
    && ['flop', 'turn', 'river', 'showdown'].includes((value as Record<string, unknown>).nextStreet as string);
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
    && Array.isArray(view.seats)
    && Array.isArray(view.exposedHands) && view.exposedHands.every(isExposedHand)
    && (view.raise === undefined || (view.raise !== null && typeof view.raise === 'object'
      && ['minRaiseTo', 'maxRaiseTo', 'minimumIncrement'].every((key) => typeof (view.raise as Record<string, unknown>)[key] === 'number')))
    && (view.allInRunout === undefined || isAllInRunout(view.allInRunout));
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
  const [raiseTo, setRaiseTo] = useState<number>();
  const [pending, setPending] = useState(false);
  const [startingNextHand, setStartingNextHand] = useState(false);
  const [advancingRunout, setAdvancingRunout] = useState(false);
  const [revealingHand, setRevealingHand] = useState(false);

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
        if (active) setStatus('החיבור נותק זמנית — מתחברים מחדש…');
      }
    };

    // Socket.IO is the low-latency path. The authenticated HTTP refresh below
    // remains the recovery path for suspended mobile browsers and serverless
    // environments where a WebSocket cannot stay open indefinitely.
    const socketOptions = {
      path: SERVER_URL.startsWith('http') ? '/socket.io' : '/server/socket.io',
      withCredentials: true,
      auth: { roomJoinId: joinId },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 10_000,
      randomizationFactor: 0.35,
      timeout: 8_000,
    };
    const socket = SERVER_URL.startsWith('http')
      ? io(SERVER_URL, socketOptions)
      : io(socketOptions);
    socket.on('connect', () => { void refresh(); });
    socket.on('game:state', (next: unknown) => {
      if (!active || !isPlayerView(next)) return;
      setView(next);
      setStatus(next.street === 'showdown' ? 'היד הסתיימה' : 'מחוברים לשולחן');
    });
    socket.on('game:error', () => { void refresh(); });
    socket.on('disconnect', () => {
      if (active) setStatus('החיבור נותק זמנית — מתחברים מחדש…');
    });

    const restoreAfterResume = () => { void refresh(); };
    const onVisibilityChange = () => {
      if (globalThis.document.visibilityState === 'visible') restoreAfterResume();
    };
    void refresh();
    const timer = globalThis.setInterval(() => { void refresh(); }, 3_000);
    globalThis.addEventListener('focus', restoreAfterResume);
    globalThis.addEventListener('online', restoreAfterResume);
    globalThis.document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      socket.close();
      globalThis.clearInterval(timer);
      globalThis.removeEventListener('focus', restoreAfterResume);
      globalThis.removeEventListener('online', restoreAfterResume);
      globalThis.document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [joinId]);

  const ownSeat = useMemo(() => view?.seats.find((seat) => seat.playerId === view.playerId), [view]);
  const orderedSeats = useMemo(() => {
    if (!view) return [];
    const ownIndex = view.seats.findIndex((seat) => seat.playerId === view.playerId);
    if (ownIndex < 0) return [...view.seats];
    return [...view.seats.slice(ownIndex), ...view.seats.slice(0, ownIndex)];
  }, [view]);
  const isTurn = Boolean(view && ownSeat && view.currentActorSeat === ownSeat.seatNumber && view.street !== 'showdown' && !view.allInRunout);
  const activeSeat = view?.seats.find((seat) => seat.seatNumber === view.currentActorSeat);
  const exposedBySeat = useMemo(() => new Map(view?.exposedHands.map((hand) => [hand.seatNumber, hand])), [view]);

  useEffect(() => {
    if (!view?.raise) {
      setRaiseTo(undefined);
      return;
    }
    setRaiseTo((current) => current !== undefined && current >= view.raise!.minRaiseTo && current <= view.raise!.maxRaiseTo
      ? current
      : view.raise!.minRaiseTo);
  }, [view?.raise?.minRaiseTo, view?.raise?.maxRaiseTo]);

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
    if (!view?.raise || raiseTo === undefined) return;
    void act({ type: 'raise', raiseTo });
  }

  function selectQuickRaise(fraction: number) {
    if (!view?.raise || !ownSeat) return;
    const afterCalling = ownSeat.currentBet + view.toCall;
    const target = afterCalling + Math.ceil(view.pot * fraction);
    setRaiseTo(Math.max(view.raise.minRaiseTo, Math.min(view.raise.maxRaiseTo, target)));
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

  async function advanceAllInRunout() {
    if (!isHost || !view?.allInRunout || advancingRunout) return;
    setAdvancingRunout(true);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/game/runout/next`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) throw new Error('All-in board unavailable');
      setStatus(`נחשף ${streetNames[view.allInRunout.nextStreet]}…`);
    } catch {
      setStatus('לא הצלחנו לחשוף את שלב ה־all-in. נסו שוב.');
    } finally {
      setAdvancingRunout(false);
    }
  }

  async function revealHand() {
    if (view?.street !== 'showdown' || revealingHand) return;
    setRevealingHand(true);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/game/reveal`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      });
      const next = await response.json();
      if (!response.ok || !isPlayerView(next)) throw new Error('Showdown reveal unavailable');
      setView(next);
      setStatus('הקלפים שלכם נחשפו לשולחן.');
    } catch {
      setStatus('לא הצלחנו לחשוף את הקלפים. נסו שוב.');
    } finally {
      setRevealingHand(false);
    }
  }

  if (!view) return <main className="table-shell"><p className="table-connection" role="status">{status}</p></main>;

  const turnMessage = view.street === 'showdown'
    ? 'היד הסתיימה — התוצאות מוכנות'
    : view.allInRunout
      ? `כולם באול אין — ממתינים לחשיפת ${streetNames[view.allInRunout.nextStreet]}`
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
              const isActor = seat.seatNumber === view.currentActorSeat && view.street !== 'showdown' && !view.allInRunout;
              const exposed = exposedBySeat.get(seat.seatNumber);
              return <article key={seat.playerId} className={`table-seat${isYou ? ' table-seat-self' : ''}${isActor ? ' table-seat-active' : ''}${seat.isFolded ? ' table-seat-folded' : ''}`}>
                <span className="seat-number">{seat.seatNumber === view.dealerSeat ? 'D' : seat.seatNumber}</span>
                <strong>{seat.playerName}{isYou ? ' (אתם)' : ''}</strong>
                <small>{seat.isFolded ? 'פרש' : `${seat.stack.toLocaleString('he-IL')} צ׳יפים`}</small>
                {seat.currentBet > 0 ? <em>הימור {seat.currentBet.toLocaleString('he-IL')}</em> : null}
                {exposed ? <div className="seat-revealed-cards" aria-label={`הקלפים של ${seat.playerName}`}><PlayingCard card={exposed.holeCards[0]} /><PlayingCard card={exposed.holeCards[1]} /></div> : null}
              </article>;
            })}
          </div>
        </div>
      </section>
      <section className="player-panel" aria-label="היד שלכם">
        <div className="your-hand"><p>היד שלכם</p><div className="hole-cards"><PlayingCard card={view.holeCards[0]} /><PlayingCard card={view.holeCards[1]} /></div></div>
        <div className="your-stack"><span>הערימה שלכם</span><strong>{ownSeat?.stack.toLocaleString('he-IL') ?? '—'}</strong><small>צ׳יפים</small></div>
        {status.includes('נכשל') || status.includes('לא זמינה') ? <p className="table-status" role="alert">{status}</p> : null}
        {isTurn ? <div className="action-bar" aria-label="פעולות בתור שלכם">
          <button type="button" className="action-fold" disabled={pending} onClick={() => void act({ type: 'fold' })}><span aria-hidden="true">✕</span> פרישה</button>
          <button type="button" className="action-primary" disabled={pending} onClick={() => void act(view.toCall === 0 ? { type: 'check' } : { type: 'call' })}><span aria-hidden="true">✓</span> {view.toCall === 0 ? 'צ׳ק' : `השוואה · ${view.toCall.toLocaleString('he-IL')}`}</button>
          <button type="button" className="action-all-in" disabled={pending} onClick={() => void act({ type: 'all-in' })}><span aria-hidden="true">⚡</span> אול אין</button>
          {view.raise ? <div className="raise-control" aria-label="בחירת סכום העלאה">
            <div className="raise-amount"><span>העלאה עד</span><strong>{(raiseTo ?? view.raise.minRaiseTo).toLocaleString('he-IL')}</strong><small>צ׳יפים</small></div>
            <input
              type="range"
              aria-label="בחירת סכום העלאה"
              min={view.raise.minRaiseTo}
              max={view.raise.maxRaiseTo}
              step={1}
              value={raiseTo ?? view.raise.minRaiseTo}
              onChange={(event) => setRaiseTo(Number(event.target.value))}
              disabled={pending}
            />
            <div className="raise-bounds"><span>{view.raise.minRaiseTo.toLocaleString('he-IL')}</span><span>אול אין {view.raise.maxRaiseTo.toLocaleString('he-IL')}</span></div>
            <div className="raise-quick-actions" aria-label="סכומי העלאה מהירים">
              <button type="button" disabled={pending} onClick={() => selectQuickRaise(0.5)}>½ קופה</button>
              <button type="button" disabled={pending} onClick={() => selectQuickRaise(0.75)}>¾ קופה</button>
              <button type="button" disabled={pending} onClick={() => selectQuickRaise(1)}>קופה</button>
              <button type="button" disabled={pending} onClick={() => setRaiseTo(view.raise!.maxRaiseTo)}>אול אין</button>
            </div>
            <button type="button" className="raise-submit" disabled={pending} onClick={submitRaise}><span aria-hidden="true">+</span> העלאה לסכום שנבחר</button>
          </div> : null}
        </div> : null}
        {view.allInRunout ? <div className="all-in-runout-panel" role="status">
          <div><span aria-hidden="true">⚡</span><p><strong>כולם באול אין</strong><small>הקלפים של המשתתפים פתוחים. המארח חושף את {streetNames[view.allInRunout.nextStreet]}.</small></p></div>
          {isHost ? <button type="button" disabled={advancingRunout} onClick={() => void advanceAllInRunout()}>{advancingRunout ? 'חושפים…' : `חשיפת ${streetNames[view.allInRunout.nextStreet]}`}</button> : <small>ממתינים למארח.</small>}
        </div> : null}
      </section>
      {view.showdown ? <section className="showdown-panel" aria-live="polite" aria-label="תוצאות היד">
        <p>תוצאות היד</p>
        <h2>{view.showdown.winners.length === 1 ? `${view.showdown.winners[0].playerName} זכה/זכתה ביד` : 'היד התחלקה בין המנצחים'}</h2>
        <ul>
          {view.showdown.winners.map((winner) => <li key={winner.playerId}><strong>{winner.playerName}</strong><span>קיבל/ה {winner.chipsWon.toLocaleString('he-IL')} צ׳יפים</span></li>)}
        </ul>
        {view.showdown.pots.length > 1 ? <small>{view.showdown.pots.map((pot, index) => `קופה ${index + 1}: ${pot.amount.toLocaleString('he-IL')}`).join(' · ')}</small> : null}
        {view.exposedHands.length > 0 ? <div className="showdown-hands" aria-label="קלפים שנחשפו">
          {view.exposedHands.map((hand) => <div key={hand.playerId}><span>{hand.playerName}{hand.reason === 'winner' ? ' · מנצח/ת' : ''}</span><PlayingCard card={hand.holeCards[0]} /><PlayingCard card={hand.holeCards[1]} /></div>)}
        </div> : null}
        {ownSeat && !ownSeat.isFolded && !view.exposedHands.some((hand) => hand.playerId === view.playerId) ? <button type="button" className="reveal-hand-button" disabled={revealingHand} onClick={() => void revealHand()}>{revealingHand ? 'חושפים…' : 'חשיפת הקלפים שלי'}</button> : null}
        {isHost ? <button type="button" className="next-hand-button" disabled={startingNextHand} onClick={() => void startNextHand()}>{startingNextHand ? 'מחלקים…' : 'התחלת היד הבאה'}</button> : <small>המארח יכול להתחיל את היד הבאה.</small>}
      </section> : null}
    </main>
  );
}
