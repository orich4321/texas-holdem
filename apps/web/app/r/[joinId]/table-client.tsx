'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

declare const process: { env: { NEXT_PUBLIC_SERVER_URL?: string } };

const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3001';

type Card = { rank: string; suit: string };
type PlayerAction = { type: 'check' | 'call' | 'fold' | 'all-in' } | { type: 'raise'; raiseTo: number };
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
};
type BrowserSocket = {
  on(event: string, listener: (payload?: unknown) => void): void;
  emit(event: string, payload?: unknown): void;
  disconnect(): void;
};
type SocketFactory = (url: string, options: { auth: { roomJoinId: string }; withCredentials: boolean }) => BrowserSocket;

declare global { interface Window { io?: SocketFactory } }

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

function loadSocketClient(): Promise<SocketFactory> {
  if (globalThis.window.io) return Promise.resolve(globalThis.window.io);
  return new Promise((resolve, reject) => {
    const existing = globalThis.document.querySelector<HTMLScriptElement>('script[data-poker-socket-client]');
    const script = existing ?? globalThis.document.createElement('script');
    const ready = () => globalThis.window.io ? resolve(globalThis.window.io) : reject(new Error('Socket client unavailable'));
    script.addEventListener('load', ready, { once: true });
    script.addEventListener('error', () => reject(new Error('Socket client failed to load')), { once: true });
    if (!existing) {
      script.async = true;
      script.dataset.pokerSocketClient = 'true';
      script.src = `${SERVER_URL}/socket.io/socket.io.js`;
      globalThis.document.head.append(script);
    }
  });
}

function PlayingCard({ card, hidden = false }: { card?: Card; hidden?: boolean }) {
  if (hidden || !card) return <span className="playing-card playing-card-back" aria-label="קלף סגור">♠</span>;
  const suit = suits[card.suit] ?? '?';
  const red = card.suit === 'hearts' || card.suit === 'diamonds';
  return <span className={`playing-card${red ? ' playing-card-red' : ''}`} aria-label={`${card.rank} ${card.suit}`}><b>{card.rank}</b><i>{suit}</i></span>;
}

export default function TableClient({ joinId }: { joinId: string }) {
  const [view, setView] = useState<PlayerView>();
  const [status, setStatus] = useState('מתחברים לשולחן…');
  const [raiseTo, setRaiseTo] = useState('');
  const [pending, setPending] = useState(false);
  const socketRef = useRef<BrowserSocket | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void loadSocketClient()
      .then((createSocket) => {
        if (!active) return;
        const socket = createSocket(SERVER_URL, { auth: { roomJoinId: joinId }, withCredentials: true });
        socketRef.current = socket;
        socket.on('connect', () => { if (active) setStatus('מחוברים לשולחן'); });
        socket.on('connect_error', () => { if (active) setStatus('החיבור לשולחן נכשל. מרעננים את הדף ומנסים שוב.'); });
        socket.on('game:error', () => { if (active) { setPending(false); setStatus('הפעולה לא זמינה כרגע. נסו שוב.'); } });
        socket.on('game:state', (next) => {
          if (!active || !isPlayerView(next)) return;
          setView(next);
          setPending(false);
          setStatus(next.street === 'showdown' ? 'היד הסתיימה' : 'מחוברים לשולחן');
        });
      })
      .catch(() => { if (active) setStatus('לא הצלחנו לטעון את חיבור המשחק.'); });
    return () => { active = false; socketRef.current?.disconnect(); socketRef.current = undefined; };
  }, [joinId]);

  const ownSeat = useMemo(() => view?.seats.find((seat) => seat.playerId === view.playerId), [view]);
  const isTurn = Boolean(view && ownSeat && view.currentActorSeat === ownSeat.seatNumber && view.street !== 'showdown');
  const suggestedRaise = view && ownSeat ? ownSeat.currentBet + view.toCall + 10 : 0;

  function act(action: PlayerAction) {
    if (!isTurn || pending || !socketRef.current) return;
    setPending(true);
    socketRef.current.emit('game:action', action);
  }

  function submitRaise() {
    const amount = Number(raiseTo || suggestedRaise);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      setStatus('צריך להזין סכום העלאה שלם וחיובי.');
      return;
    }
    act({ type: 'raise', raiseTo: amount });
  }

  if (!view) return <main className="table-shell"><p className="table-connection" role="status">{status}</p></main>;

  return (
    <main className="table-shell" dir="rtl">
      <header className="table-header"><a href={`/r/${joinId}`}>הולדם חברים</a><span>{streetNames[view.street]}</span><strong>קופה {view.pot.toLocaleString('he-IL')}</strong></header>
      <section className="poker-table" aria-label="שולחן טקסס הולדם">
        <div className="table-felt">
          <div className="table-pot"><span>קופה</span><strong>{view.pot.toLocaleString('he-IL')}</strong></div>
          <div className="community-cards" aria-label="קלפי קהילה">
            {Array.from({ length: 5 }, (_, index) => <PlayingCard key={index} card={view.communityCards[index]} hidden={!view.communityCards[index]} />)}
          </div>
          <div className="table-seats">
            {view.seats.map((seat) => {
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
        <div><p>הקלפים שלכם</p><div className="hole-cards"><PlayingCard card={view.holeCards[0]} /><PlayingCard card={view.holeCards[1]} /></div></div>
        <p className="table-status" role="status">{isTurn ? `התור שלכם${view.toCall ? ` — להשוות ${view.toCall.toLocaleString('he-IL')}` : ''}` : status}</p>
        {isTurn ? <div className="action-bar">
          <button type="button" className="action-fold" disabled={pending} onClick={() => act({ type: 'fold' })}>פרישה</button>
          <button type="button" disabled={pending} onClick={() => act(view.toCall === 0 ? { type: 'check' } : { type: 'call' })}>{view.toCall === 0 ? 'צ׳ק' : `השוואה ${view.toCall}`}</button>
          <button type="button" disabled={pending} onClick={() => act({ type: 'all-in' })}>אול אין</button>
          <label className="raise-control">העלאה<input inputMode="numeric" value={raiseTo} onChange={(event) => setRaiseTo(event.target.value)} placeholder={String(suggestedRaise)} disabled={pending} /><button type="button" disabled={pending} onClick={submitRaise}>העלו</button></label>
        </div> : null}
      </section>
    </main>
  );
}
