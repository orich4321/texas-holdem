'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { AppBrand } from '../../ui';

declare const process: { env: { NODE_ENV?: string; NEXT_PUBLIC_GAME_URL?: string; NEXT_PUBLIC_SERVER_URL?: string } };

const SERVER_URL = process.env.NODE_ENV === 'production'
  ? '/server'
  : process.env.NEXT_PUBLIC_SERVER_URL ?? process.env.NEXT_PUBLIC_GAME_URL ?? 'http://localhost:3001';

type Card = { rank: string; suit: string };
type PlayerAction = { type: 'check' | 'call' | 'fold' | 'all-in' } | { type: 'raise'; raiseTo: number };
type Showdown = {
  winners: readonly { seatNumber: number; playerId: string; playerName: string; chipsWon: number; winningCards?: readonly Card[] }[];
  pots: readonly { amount: number; winnerSeatNumbers: readonly number[] }[];
  uncalledReturns: readonly { seatNumber: number; amount: number }[];
};
type ExposedHand = {
  seatNumber: number;
  playerId: string;
  playerName: string;
  holeCards: readonly [Card, Card];
  reason: 'all-in' | 'winner' | 'voluntary';
};
type AllInRunout = { nextStreet: 'flop' | 'turn' | 'river' | 'showdown' };
type FinalSummary = {
  version: number;
  room: { joinId: string; initialStack: number; smallBlind: number; bigBlind: number };
  standings: readonly { displayName: string; initialStack: number; addedChips?: number; totalBuyIn?: number; finalStack: number; net: number }[];
  hands: readonly unknown[];
  events: readonly unknown[];
};
type PlayerView = {
  sequence?: number;
  hostPlayerId?: string;
  gameCompleted?: boolean;
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
type ManagementView = {
  smallBlind: number;
  bigBlind: number;
  nextHandIsFinal: boolean;
  players: readonly { id: string; displayName: string; currentStack: number; isHost: boolean; leaveAfterHand: boolean; pendingChips: number }[];
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

function isFinalSummary(value: unknown, joinId: string): value is FinalSummary {
  if (value === null || typeof value !== 'object') return false;
  const summary = value as Record<string, unknown>;
  return (summary.version === 1 || summary.version === 2 || summary.version === 3)
    && summary.room !== null && typeof summary.room === 'object'
    && (summary.room as Record<string, unknown>).joinId === joinId
    && Array.isArray(summary.standings)
    && summary.standings.every((standing) => standing !== null && typeof standing === 'object'
      && ['displayName', 'initialStack', 'finalStack', 'net'].every((key) => typeof (standing as Record<string, unknown>)[key] === (key === 'displayName' ? 'string' : 'number')))
    && Array.isArray(summary.hands) && Array.isArray(summary.events);
}

function isPlayerView(value: unknown): value is PlayerView {
  if (value === null || typeof value !== 'object') return false;
  const view = value as Record<string, unknown>;
  return typeof view.playerId === 'string'
    && (view.sequence === undefined || typeof view.sequence === 'number')
    && (view.hostPlayerId === undefined || typeof view.hostPlayerId === 'string')
    && (view.gameCompleted === undefined || typeof view.gameCompleted === 'boolean')
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

function cardKey(card: Card) {
  return `${card.rank}-${card.suit}`;
}

function PlayingCard({ card, hidden = false, placeholder = false, highlighted = false }: { card?: Card; hidden?: boolean; placeholder?: boolean; highlighted?: boolean }) {
  if (placeholder) return <span className="playing-card playing-card-slot" aria-hidden="true" />;
  if (hidden || !card) return <span className="playing-card playing-card-back" aria-label="קלף סגור">♠</span>;
  const suit = suits[card.suit] ?? '?';
  const red = card.suit === 'hearts' || card.suit === 'diamonds';
  return <span className={`playing-card${red ? ' playing-card-red' : ''}${highlighted ? ' playing-card-winning' : ''}`} aria-label={`${card.rank} ${card.suit}`}><b>{card.rank}</b><i>{suit}</i></span>;
}

export default function TableClient({ joinId, isHost }: { joinId: string; isHost: boolean }) {
  const [view, setView] = useState<PlayerView>();
  const [status, setStatus] = useState('מתחברים לשולחן…');
  const [raiseTo, setRaiseTo] = useState<number>();
  const [pending, setPending] = useState(false);
  const [startingNextHand, setStartingNextHand] = useState(false);
  const [advancingRunout, setAdvancingRunout] = useState(false);
  const [revealingHand, setRevealingHand] = useState(false);
  const [showRaiseControls, setShowRaiseControls] = useState(false);
  const [waitingForNextHand, setWaitingForNextHand] = useState(false);
  const [finalSummary, setFinalSummary] = useState<FinalSummary>();
  const [managingPlayerId, setManagingPlayerId] = useState<string>();
  const [managementOpen, setManagementOpen] = useState(false);
  const [playersOpen, setPlayersOpen] = useState(false);
  const [management, setManagement] = useState<ManagementView>();
  const [managementBusy, setManagementBusy] = useState(false);
  const [smallBlind, setSmallBlind] = useState(5);
  const [bigBlind, setBigBlind] = useState(10);
  const [topUpAmounts, setTopUpAmounts] = useState<Record<string, number>>({});
  const socketRef = useRef<ReturnType<typeof io> | null>(null);
  const latestSequenceRef = useRef(-1);
  const actionPendingRef = useRef(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/game`, { credentials: 'include', cache: 'no-store' });
        const next = await response.json();
        if (response.status === 409 && (next as { error?: { code?: string } })?.error?.code === 'GAME_NOT_AVAILABLE') {
          if (active) {
            setWaitingForNextHand(true);
            setStatus('הצטרפתם בין ידיים — ממתינים למארח שיתחיל את היד הבאה…');
          }
          return;
        }
        if (!response.ok || !isPlayerView(next)) throw new Error('Invalid player view');
        if (!active) return;
        if ((next.sequence ?? 0) < latestSequenceRef.current) return;
        latestSequenceRef.current = next.sequence ?? latestSequenceRef.current;
        setWaitingForNextHand(false);
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
    socketRef.current = socket;
    socket.on('connect', () => { void refresh(); });
    socket.on('game:state', (next: unknown) => {
      if (!active || !isPlayerView(next)) return;
      if ((next.sequence ?? 0) < latestSequenceRef.current) return;
      latestSequenceRef.current = next.sequence ?? latestSequenceRef.current;
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
    const timer = globalThis.setInterval(() => {
      if (globalThis.document.visibilityState === 'visible') void refresh();
    }, 650);
    globalThis.addEventListener('focus', restoreAfterResume);
    globalThis.addEventListener('online', restoreAfterResume);
    globalThis.document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      socket.close();
      socketRef.current = null;
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
  const winnerSeatNumbers = useMemo(() => new Set(view?.showdown?.winners.map((winner) => winner.seatNumber) ?? []), [view?.showdown]);
  const winningCardKeys = useMemo(() => new Set(view?.showdown?.winners.flatMap((winner) => winner.winningCards?.map(cardKey) ?? []) ?? []), [view?.showdown]);
  const uncalledReturnBySeat = useMemo(() => new Map(view?.showdown?.uncalledReturns?.map((returned) => [returned.seatNumber, returned.amount]) ?? []), [view?.showdown]);
  const displayedPot = view?.showdown?.pots.reduce((total, pot) => total + pot.amount, 0) ?? view?.pot ?? 0;
  const canRevealAtShowdown = Boolean(
    view?.street === 'showdown'
    && ownSeat
    && !ownSeat.isFolded
    && view.seats.filter((seat) => !seat.isFolded).length >= 2
    && !view.exposedHands.some((hand) => hand.playerId === view.playerId),
  );
  const isCurrentHost = Boolean(view && (view.hostPlayerId ? view.hostPlayerId === view.playerId : isHost));

  useEffect(() => {
    if (!view?.raise) {
      setRaiseTo(undefined);
      return;
    }
    setRaiseTo((current) => current !== undefined && current >= view.raise!.minRaiseTo && current <= view.raise!.maxRaiseTo
      ? current
      : view.raise!.minRaiseTo);
  }, [view?.raise?.minRaiseTo, view?.raise?.maxRaiseTo]);

  useEffect(() => {
    if (view?.street !== 'showdown' || !view.gameCompleted) return;
    let active = true;
    let retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/final-summary`, { credentials: 'include', cache: 'no-store' });
        const body = await response.json();
        if (active && response.ok && isFinalSummary(body, joinId)) {
          setFinalSummary(body);
          return;
        }
      } catch {
        // The completed room and its summary are committed together, but a
        // retry also covers a transient serverless cold start or network gap.
      }
      if (active) retryTimer = globalThis.setTimeout(() => { void load(); }, 350);
    };
    void load();
    return () => {
      active = false;
      if (retryTimer !== undefined) globalThis.clearTimeout(retryTimer);
    };
  }, [joinId, view?.gameCompleted, view?.street]);

  useEffect(() => {
    if (!isTurn || !view?.raise) setShowRaiseControls(false);
  }, [isTurn, view?.raise]);

  useEffect(() => {
    if (!isCurrentHost) setManagementOpen(false);
  }, [isCurrentHost]);

  useEffect(() => {
    if (!managementOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setManagementOpen(false);
    };
    globalThis.document.addEventListener('keydown', closeOnEscape);
    return () => globalThis.document.removeEventListener('keydown', closeOnEscape);
  }, [managementOpen]);

  async function act(action: PlayerAction) {
    if (!isTurn || actionPendingRef.current) return;
    actionPendingRef.current = true;
    setPending(true);
    const clientActionId = globalThis.crypto.randomUUID();
    const submittedSequence = view?.sequence ?? -1;
    try {
      const socket = socketRef.current;
      // A standalone game server can acknowledge actions over Socket.IO.
      // On the same-origin Vercel deployment, send the authoritative HTTP
      // request immediately instead of paying a WebSocket timeout first.
      if (SERVER_URL.startsWith('http') && socket?.connected) {
        const acknowledged = await new Promise<PlayerView | undefined>((resolve) => {
          const timeout = globalThis.setTimeout(() => resolve(undefined), 1_200);
          socket.emit('game:action', { clientActionId, action }, (result: unknown) => {
            globalThis.clearTimeout(timeout);
            const candidate = result && typeof result === 'object' ? (result as { view?: unknown }).view : undefined;
            resolve(isPlayerView(candidate) ? candidate : undefined);
          });
        });
        if (acknowledged) {
          latestSequenceRef.current = Math.max(latestSequenceRef.current, acknowledged.sequence ?? 0);
          setView(acknowledged);
          setStatus(acknowledged.street === 'showdown' ? 'היד הסתיימה' : 'מחוברים לשולחן');
          return;
        }
      }
      let next: unknown;
      let accepted = false;
      for (let attempt = 0; attempt < 2 && !accepted; attempt += 1) {
        try {
          const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/game/actions`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientActionId, action }),
          });
          next = await response.json();
          accepted = response.ok && isPlayerView(next);
        } catch {
          accepted = false;
        }
        if (!accepted && attempt === 0) await new Promise((resolve) => globalThis.setTimeout(resolve, 180));
      }
      if (!accepted || !isPlayerView(next)) throw new Error('Action unavailable');
      latestSequenceRef.current = Math.max(latestSequenceRef.current, next.sequence ?? 0);
      setView(next);
      setStatus(next.street === 'showdown' ? 'היד הסתיימה' : 'מחוברים לשולחן');
    } catch {
      try {
        const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/game`, { credentials: 'include', cache: 'no-store' });
        const recovered = await response.json();
        if (response.ok && isPlayerView(recovered) && (recovered.sequence ?? -1) > submittedSequence) {
          latestSequenceRef.current = Math.max(latestSequenceRef.current, recovered.sequence ?? 0);
          setView(recovered);
          setStatus(recovered.street === 'showdown' ? 'היד הסתיימה' : 'מחוברים לשולחן');
        } else {
          setStatus('הפעולה לא זמינה כרגע. נסו שוב.');
        }
      } catch {
        setStatus('הפעולה לא זמינה כרגע. נסו שוב.');
      }
    } finally {
      actionPendingRef.current = false;
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
    const steps = Math.ceil((target - view.raise.minRaiseTo) / view.raise.minimumIncrement);
    const legalTarget = view.raise.minRaiseTo + Math.max(0, steps) * view.raise.minimumIncrement;
    setRaiseTo(Math.max(view.raise.minRaiseTo, Math.min(view.raise.maxRaiseTo, legalTarget)));
  }

  async function startNextHand() {
    if (!isCurrentHost || view?.street !== 'showdown' || startingNextHand) return;
    setStartingNextHand(true);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/game/next-hand`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) throw new Error('Next hand unavailable');
      setManagement((current) => current ? { ...current, nextHandIsFinal: false } : current);
      setStatus('מחלקים את היד הבאה…');
    } catch {
      setStatus('לא הצלחנו להתחיל את היד הבאה. נסו שוב.');
    } finally {
      setStartingNextHand(false);
    }
  }

  async function loadManagement() {
    if (!isCurrentHost) return;
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/management`, { credentials: 'include', cache: 'no-store' });
      const next = await response.json() as ManagementView;
      if (!response.ok || !Array.isArray(next.players)) throw new Error('Management unavailable');
      setManagement(next);
      setSmallBlind(next.smallBlind);
      setBigBlind(next.bigBlind);
    } catch {
      setStatus('לא הצלחנו לטעון את ניהול השולחן. נסו שוב.');
    }
  }

  async function scheduleFinalHand(enabled: boolean) {
    if (!isCurrentHost || managementBusy) return;
    if (enabled && !globalThis.confirm('לסמן את היד הבאה כיד האחרונה של המשחק?')) return;
    setManagementBusy(true);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/game/final-hand`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error('Final hand unavailable');
      await loadManagement();
      setStatus(enabled ? 'היד הבאה סומנה כיד האחרונה.' : 'סימון היד האחרונה בוטל.');
    } catch {
      setStatus('לא הצלחנו לעדכן את היד האחרונה. נסו שוב.');
    } finally { setManagementBusy(false); }
  }

  async function removePlayerBetweenHands(targetPlayerId: string, playerName: string, enabled: boolean) {
    if (!isCurrentHost || managingPlayerId) return;
    if (enabled && !globalThis.confirm(`להוציא את ${playerName} לפני היד הבאה?`)) return;
    setManagingPlayerId(targetPlayerId);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/management/players/${encodeURIComponent(targetPlayerId)}/removal`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error('Player removal unavailable');
      await loadManagement();
      setStatus(enabled ? `${playerName} ייצא/תצא לפני היד הבאה.` : `היציאה של ${playerName} בוטלה.`);
    } catch {
      setStatus('לא הצלחנו לעדכן את יציאת השחקן/ית.');
    } finally {
      setManagingPlayerId(undefined);
    }
  }

  async function saveBlinds() {
    if (!isCurrentHost || managementBusy) return;
    setManagementBusy(true);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/management/blinds`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ smallBlind, bigBlind }),
      });
      if (!response.ok) throw new Error('Blind update unavailable');
      await loadManagement();
      setStatus('הבליינדים החדשים יחולו מהיד הבאה.');
    } catch { setStatus('ערכי הבליינדים אינם תקינים.'); } finally { setManagementBusy(false); }
  }

  async function addChips(targetPlayerId: string, playerName: string, amount: number) {
    if (!isCurrentHost || managementBusy || !Number.isSafeInteger(amount) || amount < 1) return;
    setManagementBusy(true);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/management/players/${encodeURIComponent(targetPlayerId)}/chips`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount }),
      });
      if (!response.ok) throw new Error('Chip adjustment unavailable');
      await loadManagement();
      setStatus(`${amount.toLocaleString('he-IL')} ז׳יטונים יתווספו ל${playerName} ביד הבאה.`);
    } catch { setStatus('לא הצלחנו לתזמן את תוספת הז׳יטונים.'); } finally { setManagementBusy(false); }
  }

  async function cancelChips(targetPlayerId: string) {
    if (!isCurrentHost || managementBusy) return;
    setManagementBusy(true);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/management/players/${encodeURIComponent(targetPlayerId)}/chips`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: 0 }),
      });
      if (!response.ok) throw new Error('Chip adjustment unavailable');
      await loadManagement();
      setStatus('תוספת הז׳יטונים הממתינה בוטלה.');
    } catch { setStatus('לא הצלחנו לבטל את תוספת הז׳יטונים.'); } finally { setManagementBusy(false); }
  }

  async function transferHost(targetPlayerId: string | undefined, leaveAfterHand: boolean) {
    if (!isCurrentHost || managementBusy || !globalThis.confirm('להעביר את ניהול השולחן? לאחר האישור ההרשאות יעברו מיד.')) return;
    setManagementBusy(true);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/management/transfer-host`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetPlayerId, leaveAfterHand }),
      });
      if (!response.ok) throw new Error('Host transfer unavailable');
      setManagementOpen(false);
      setStatus(leaveAfterHand ? 'הניהול הועבר. תצאו לפני היד הבאה.' : 'הניהול הועבר. נשארתם כשחקנים רגילים.');
    } catch { setStatus('לא הצלחנו להעביר את ניהול השולחן.'); } finally { setManagementBusy(false); }
  }

  async function copyInvitationForNextHand() {
    try {
      await globalThis.navigator.clipboard.writeText(new URL(`/r/${encodeURIComponent(joinId)}`, globalThis.location.origin).toString());
      setStatus('קישור ההזמנה הועתק. חברים יכולים להצטרף בין ידיים וייכנסו ליד הבאה.');
    } catch {
      setStatus('לא הצלחנו להעתיק את הקישור. אפשר להעתיק אותו משורת הכתובת.');
    }
  }

  function downloadFinalSummary() {
    if (!finalSummary) return;
    const blob = new Blob([JSON.stringify(finalSummary, null, 2)], { type: 'application/json' });
    const url = globalThis.URL.createObjectURL(blob);
    const link = globalThis.document.createElement('a');
    link.href = url;
    link.download = `texas-holdem-${joinId}-summary.json`;
    link.click();
    globalThis.URL.revokeObjectURL(url);
  }

  async function advanceAllInRunout() {
    if (!isCurrentHost || !view?.allInRunout || advancingRunout) return;
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

  if (!view) return <main className="table-shell"><p className="table-connection" role="status">{waitingForNextHand ? '♠ ' : ''}{status}</p></main>;

  const turnMessage = view.street === 'showdown'
    ? 'היד הסתיימה'
    : view.allInRunout
      ? `כולם באול אין — ממתינים לחשיפת ${streetNames[view.allInRunout.nextStreet]}`
    : isTurn
      ? `התור שלכם${view.toCall ? ` · צריך להשוות ${view.toCall.toLocaleString('he-IL')}` : ' · אפשר לעשות צ׳ק'}`
      : `ממתינים ל${activeSeat?.playerName ?? 'שחקן הבא'}`;

  return (
    <main className="table-shell" dir="rtl">
      <header className="table-header">
        <a href={`/r/${joinId}`} aria-label="חזרה ללובי"><AppBrand compact /></a>
        {isCurrentHost ? <button type="button" className="table-management-button" aria-expanded={managementOpen} onClick={() => {
          setManagementOpen(true);
          void loadManagement();
        }}><span aria-hidden="true">⚙</span> ניהול שולחן</button> : null}
        <div className="table-round"><span>שלב במשחק</span><strong>{streetNames[view.street]}</strong></div>
        <div className="table-header-pot"><span>{view.showdown ? 'קופה שחולקה' : 'קופה נוכחית'}</span><strong><i aria-hidden="true" />{displayedPot.toLocaleString('he-IL')}</strong></div>
      </header>
      <p className={`turn-banner${isTurn ? ' turn-banner-active' : ''}`} role="status" aria-live="polite"><span aria-hidden="true" />{turnMessage}</p>
      <section className="poker-table" aria-label="שולחן טקסס הולדם">
        <div className="table-felt">
          <div className="table-pot"><span><i aria-hidden="true" /> {view.showdown ? 'קופה שחולקה' : 'קופה'}</span><strong>{displayedPot.toLocaleString('he-IL')}</strong></div>
          <div className="community-cards" aria-label="קלפי קהילה">
            {Array.from({ length: 5 }, (_, index) => <PlayingCard key={index} card={view.communityCards[index]} placeholder={!view.communityCards[index]} highlighted={Boolean(view.communityCards[index] && winningCardKeys.has(cardKey(view.communityCards[index])))} />)}
          </div>
          <div className="table-seats">
            {orderedSeats.map((seat) => {
              const isYou = seat.playerId === view.playerId;
              const isActor = seat.seatNumber === view.currentActorSeat && view.street !== 'showdown' && !view.allInRunout;
              const exposed = exposedBySeat.get(seat.seatNumber);
              const isWinner = winnerSeatNumbers.has(seat.seatNumber);
              return <article key={seat.playerId} className={`table-seat${isYou ? ' table-seat-self' : ''}${isActor ? ' table-seat-active' : ''}${isWinner ? ' table-seat-winner' : ''}${seat.isFolded ? ' table-seat-folded' : ''}`}>
                <span className={`seat-number${seat.seatNumber === view.dealerSeat ? ' dealer-button' : ''}`}>{seat.seatNumber === view.dealerSeat ? 'D' : seat.seatNumber}</span>
                <strong>{seat.playerName}{isYou ? ' · אתם' : ''}</strong>
                <small>{seat.isFolded ? 'פרש/ה מהיד' : <><i aria-hidden="true" />{seat.stack.toLocaleString('he-IL')} צ׳יפים</>}</small>
                {seat.currentBet > 0 ? <em>הימור {seat.currentBet.toLocaleString('he-IL')}</em> : null}
                {uncalledReturnBySeat.has(seat.seatNumber) ? <em>הוחזרו {uncalledReturnBySeat.get(seat.seatNumber)!.toLocaleString('he-IL')} צ׳יפים שלא הושוו</em> : null}
                {exposed ? <div className="seat-revealed-cards" aria-label={`הקלפים של ${seat.playerName}`}><PlayingCard card={exposed.holeCards[0]} highlighted={winningCardKeys.has(cardKey(exposed.holeCards[0]))} /><PlayingCard card={exposed.holeCards[1]} highlighted={winningCardKeys.has(cardKey(exposed.holeCards[1]))} /></div> : null}
              </article>;
            })}
          </div>
        </div>
      </section>
      <section className="player-panel" aria-label="היד שלכם">
        <div className="your-hand"><p><span aria-hidden="true">◆</span> הקלפים שלכם</p><div className="hole-cards"><PlayingCard card={view.holeCards[0]} /><PlayingCard card={view.holeCards[1]} /></div></div>
        <div className="your-stack"><span>הערימה שלכם</span><strong><i aria-hidden="true" />{ownSeat?.stack.toLocaleString('he-IL') ?? '—'}</strong><small>צ׳יפים</small></div>
        {status.includes('נכשל') || status.includes('לא זמינה') ? <p className="table-status" role="alert">{status}</p> : null}
        {isTurn ? <div className="action-bar" aria-label="פעולות בתור שלכם">
          <button type="button" className="action-fold" disabled={pending} onClick={() => void act({ type: 'fold' })}><span aria-hidden="true">✕</span> פרישה</button>
          <button type="button" className="action-primary" disabled={pending} onClick={() => void act(view.toCall === 0 ? { type: 'check' } : { type: 'call' })}><span aria-hidden="true">✓</span> {view.toCall === 0 ? 'צ׳ק' : `השוואה · ${view.toCall.toLocaleString('he-IL')}`}</button>
          {view.raise ? <button type="button" className="action-raise-toggle" disabled={pending} aria-expanded={showRaiseControls} onClick={() => setShowRaiseControls((shown) => !shown)}><span aria-hidden="true">＋</span> הימור</button> : null}
          {view.raise && showRaiseControls ? <div className="raise-control" aria-label="בחירת סכום העלאה">
            <div className="raise-amount"><span>העלאה עד</span><strong>{(raiseTo ?? view.raise.minRaiseTo).toLocaleString('he-IL')}</strong><small>צ׳יפים</small></div>
            <input
              type="range"
              aria-label="בחירת סכום העלאה"
              min={view.raise.minRaiseTo}
              max={view.raise.maxRaiseTo}
              step={view.raise.minimumIncrement}
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
          {isCurrentHost ? <button type="button" disabled={advancingRunout} onClick={() => void advanceAllInRunout()}>{advancingRunout ? 'חושפים…' : `חשיפת ${streetNames[view.allInRunout.nextStreet]}`}</button> : <small>ממתינים למארח.</small>}
        </div> : null}
        {view.showdown && !view.gameCompleted && !finalSummary ? <div className="between-hands-controls" aria-label="פעולות בין ידיים">
          {canRevealAtShowdown ? <button type="button" className="reveal-hand-button" disabled={revealingHand} onClick={() => void revealHand()}>{revealingHand ? 'חושפים…' : 'לחשוף את היד שלי'}</button> : null}
          {isCurrentHost ? <button type="button" className="next-hand-button" disabled={startingNextHand} onClick={() => void startNextHand()}>{startingNextHand ? 'מחלקים…' : management?.nextHandIsFinal ? 'התחלת היד האחרונה' : 'היד הבאה'}</button> : <small>המארח יכול להתחיל את היד הבאה.</small>}
        </div> : null}
      </section>
      {managementOpen && isCurrentHost ? <div className="management-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setManagementOpen(false);
      }}><section className="management-sheet" role="dialog" aria-modal="true" aria-labelledby="management-title">
        <header><div><small>הרשאות מארח</small><h2 id="management-title">ניהול שולחן</h2></div><button type="button" aria-label="סגירת ניהול" onClick={() => setManagementOpen(false)}>×</button></header>
        <p className="management-note">שינויים בערימות, בליינדים ויציאות יחולו לפני היד הבאה.</p>
        <div className="management-grid">
          <section className="management-card"><h3>היד האחרונה</h3><p>{management?.nextHandIsFinal ? 'היד הבאה מסומנת כאחרונה.' : 'המשחק ימשיך כרגיל.'}</p><button type="button" className={management?.nextHandIsFinal ? 'management-cancel' : 'management-gold'} disabled={managementBusy} onClick={() => void scheduleFinalHand(!management?.nextHandIsFinal)}>{management?.nextHandIsFinal ? 'ביטול הסימון' : 'סימון סיבוב אחרון'}</button></section>
          <section className="management-card"><h3>בליינדים מהיד הבאה</h3><div className="blind-inputs"><label>סמול<input type="number" inputMode="numeric" min="1" value={smallBlind} onChange={(event) => setSmallBlind(Number(event.target.value))} /></label><label>ביג<input type="number" inputMode="numeric" min="2" value={bigBlind} onChange={(event) => setBigBlind(Number(event.target.value))} /></label></div><button type="button" disabled={managementBusy} onClick={() => void saveBlinds()}>שמירת בליינדים</button></section>
          <section className="management-card management-invite"><h3>הוספת שחקנים</h3><p>הקישור תמיד פותח את מסך האורח.</p><button type="button" onClick={() => void copyInvitationForNextHand()}>העתקת קישור הזמנה</button></section>
        </div>
        <button type="button" className="management-roster-toggle" aria-expanded={playersOpen} onClick={() => setPlayersOpen((open) => !open)}><span>רשימת שחקנים</span><strong>{management?.players.length ?? 0}</strong><i aria-hidden="true">{playersOpen ? '−' : '+'}</i></button>
        {playersOpen ? <section className="management-players"><h3>שחקנים וניהול ערימות</h3>{management?.players.map((player) => <article key={player.id} className={player.leaveAfterHand ? 'player-management-leaving' : ''}>
          <div><strong>{player.displayName}{player.isHost ? ' · מארח' : ''}</strong><small>{player.currentStack.toLocaleString('he-IL')} ז׳יטונים{player.pendingChips ? ` · ${player.pendingChips.toLocaleString('he-IL')}+ ממתינים` : ''}{player.leaveAfterHand ? ' · יוצא ביד הבאה' : ''}</small></div>
          <div className="player-management-actions">
            {!player.leaveAfterHand ? <><input aria-label={`ז׳יטונים ל${player.displayName}`} type="number" inputMode="numeric" min="1" placeholder="כמות" value={topUpAmounts[player.id] ?? ''} onChange={(event) => setTopUpAmounts((current) => ({ ...current, [player.id]: Number(event.target.value) }))} /><button type="button" disabled={managementBusy} onClick={() => void addChips(player.id, player.displayName, topUpAmounts[player.id] ?? 0)}>הוספה</button>{player.pendingChips > 0 ? <button type="button" className="management-cancel" disabled={managementBusy} onClick={() => void cancelChips(player.id)}>ביטול תוספת</button> : null}</> : null}
            {!player.isHost ? <button type="button" className="management-danger" disabled={Boolean(managingPlayerId)} onClick={() => void removePlayerBetweenHands(player.id, player.displayName, !player.leaveAfterHand)}>{player.leaveAfterHand ? 'ביטול יציאה' : 'הוצאה ביד הבאה'}</button> : null}
            {!player.isHost && !player.leaveAfterHand ? <><button type="button" className="management-transfer" disabled={managementBusy} onClick={() => void transferHost(player.id, false)}>העברת ניהול</button><button type="button" className="management-danger" disabled={managementBusy} onClick={() => void transferHost(player.id, true)}>העברה ויציאה שלי</button></> : null}
          </div>
        </article>)}</section> : null}
        {ownSeat?.stack === 0 ? <button type="button" className="busted-host-exit" disabled={managementBusy} onClick={() => void transferHost(undefined, true)}>נגמרו לי הז׳יטונים · יציאה ומינוי אוטומטי</button> : null}
      </section></div> : null}
      {finalSummary ? <div className="modal-backdrop"><section className="final-summary" aria-live="polite" aria-label="סיכום המשחק">
        <p>המשחק הסתיים</p>
        <h2>סיכום סופי</h2>
        <ul>{finalSummary.standings.map((standing) => <li key={standing.displayName}><strong>{standing.displayName}</strong><span>{standing.finalStack.toLocaleString('he-IL')} צ׳יפים · כניסות {(standing.totalBuyIn ?? standing.initialStack).toLocaleString('he-IL')} · {standing.net >= 0 ? '+' : ''}{standing.net.toLocaleString('he-IL')}</span></li>)}</ul>
        <small>{finalSummary.hands.length} ידיים הסתיימו · פירוט הפעולות והתשלומים נשמר בקובץ.</small>
        <button type="button" onClick={downloadFinalSummary}>הורדת סיכום JSON</button>
      </section></div> : null}
    </main>
  );
}
