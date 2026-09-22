'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { AppBrand } from '../../ui';
import { parsePositiveInteger } from '../../numeric-input';
import { ProfileImage } from '../../profile-image';

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
  handCount: number;
};
type PlayerView = {
  sequence?: number;
  hostPlayerId?: string;
  gameCompleted?: boolean;
  finalSummaryVisible?: boolean;
  isSittingOut?: boolean;
  playerId: string;
  street: 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  dealerSeat: number;
  currentActorSeat: number;
  communityCards: readonly Card[];
  pot: number;
  toCall: number;
  raise?: { minRaiseTo: number; maxRaiseTo: number; minimumIncrement: number };
  holeCards: readonly [Card, Card] | readonly [];
  seats: readonly { seatNumber: number; playerId: string; playerName: string; avatarDataUrl?: string; stack: number; currentBet: number; isFolded: boolean }[];
  exposedHands: readonly ExposedHand[];
  allInRunout?: AllInRunout;
  showdown?: Showdown;
};
type ManagementView = {
  smallBlind: number;
  bigBlind: number;
  nextHandIsFinal: boolean;
  players: readonly { id: string; displayName: string; currentStack: number; isHost: boolean; leaveAfterHand: boolean; pendingChips: number; isSittingOut: boolean; rebuyDecisionPending: boolean }[];
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
    && typeof summary.handCount === 'number';
}

function isPlayerView(value: unknown): value is PlayerView {
  if (value === null || typeof value !== 'object') return false;
  const view = value as Record<string, unknown>;
  return typeof view.playerId === 'string'
    && (view.sequence === undefined || typeof view.sequence === 'number')
    && (view.hostPlayerId === undefined || typeof view.hostPlayerId === 'string')
    && (view.gameCompleted === undefined || typeof view.gameCompleted === 'boolean')
    && (view.finalSummaryVisible === undefined || typeof view.finalSummaryVisible === 'boolean')
    && (view.isSittingOut === undefined || typeof view.isSittingOut === 'boolean')
    && typeof view.street === 'string'
    && typeof view.dealerSeat === 'number'
    && typeof view.currentActorSeat === 'number'
    && typeof view.pot === 'number'
    && typeof view.toCall === 'number'
    && Array.isArray(view.communityCards) && view.communityCards.every(isCard)
    && Array.isArray(view.holeCards) && (view.holeCards.length === 2 || (view.holeCards.length === 0 && view.isSittingOut === true)) && view.holeCards.every(isCard)
    && Array.isArray(view.seats) && view.seats.every((seat) => seat !== null && typeof seat === 'object'
      && typeof (seat as Record<string, unknown>).playerName === 'string'
      && ((seat as Record<string, unknown>).avatarDataUrl === undefined || typeof (seat as Record<string, unknown>).avatarDataUrl === 'string'))
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
  const [revealingSummary, setRevealingSummary] = useState(false);
  const [continueDialogOpen, setContinueDialogOpen] = useState(false);
  const [continuingHand, setContinuingHand] = useState(false);
  const [advancingRunout, setAdvancingRunout] = useState(false);
  const [revealingHand, setRevealingHand] = useState(false);
  const [showRaiseControls, setShowRaiseControls] = useState(false);
  const [waitingForNextHand, setWaitingForNextHand] = useState(false);
  const [finalSummary, setFinalSummary] = useState<FinalSummary>();
  const [downloadingSummary, setDownloadingSummary] = useState(false);
  const [managingPlayerId, setManagingPlayerId] = useState<string>();
  const [managementOpen, setManagementOpen] = useState(false);
  const [playersOpen, setPlayersOpen] = useState(false);
  const [management, setManagement] = useState<ManagementView>();
  const [managementBusy, setManagementBusy] = useState(false);
  const [smallBlind, setSmallBlind] = useState('1');
  const [bigBlind, setBigBlind] = useState('2');
  const [topUpAmounts, setTopUpAmounts] = useState<Record<string, string>>({});
  const selectedSmallBlind = parsePositiveInteger(smallBlind);
  const selectedBigBlind = parsePositiveInteger(bigBlind);
  const validBlinds = selectedSmallBlind !== undefined && selectedSmallBlind <= 100_000
    && selectedBigBlind !== undefined && selectedBigBlind <= 100_000 && selectedBigBlind > selectedSmallBlind;
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
    // Vercel's portable realtime path is authenticated HTTP polling. Schedule
    // the next read only after the prior one finishes so slow mobile networks
    // cannot build a stale request queue, while keeping turn hand-offs fast.
    let pollTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const poll = async () => {
      if (globalThis.document.visibilityState === 'visible') await refresh();
      if (active) pollTimer = globalThis.setTimeout(() => { void poll(); }, 250);
    };
    void poll();
    globalThis.addEventListener('focus', restoreAfterResume);
    globalThis.addEventListener('online', restoreAfterResume);
    globalThis.document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      socket.close();
      socketRef.current = null;
      if (pollTimer !== undefined) globalThis.clearTimeout(pollTimer);
      globalThis.removeEventListener('focus', restoreAfterResume);
      globalThis.removeEventListener('online', restoreAfterResume);
      globalThis.document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [joinId]);

  const ownSeat = useMemo(() => view?.seats.find((seat) => seat.playerId === view.playerId), [view]);
  const bustedPlayers = management?.players.filter((player) => player.rebuyDecisionPending) ?? [];
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
    && !view.finalSummaryVisible
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
    if (view?.street !== 'showdown' || !view.gameCompleted || !view.finalSummaryVisible) return;
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
  }, [joinId, view?.gameCompleted, view?.finalSummaryVisible, view?.street]);

  useEffect(() => {
    if (!isTurn || !view?.raise) setShowRaiseControls(false);
  }, [isTurn, view?.raise]);

  useEffect(() => {
    if (!isCurrentHost || view?.gameCompleted) setManagementOpen(false);
  }, [isCurrentHost, view?.gameCompleted]);

  useEffect(() => {
    if (view?.street !== 'showdown' || !view.gameCompleted || view.finalSummaryVisible) setContinueDialogOpen(false);
  }, [view?.street, view?.gameCompleted, view?.finalSummaryVisible]);

  useEffect(() => {
    if (!managementOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setManagementOpen(false);
    };
    globalThis.document.addEventListener('keydown', closeOnEscape);
    return () => globalThis.document.removeEventListener('keydown', closeOnEscape);
  }, [managementOpen]);

  useEffect(() => {
    if (isCurrentHost && view?.street === 'showdown' && !view.finalSummaryVisible) void loadManagement();
  }, [isCurrentHost, view?.street, view?.sequence, view?.finalSummaryVisible]);

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

  async function revealFinalSummary() {
    if (!isCurrentHost || !view?.gameCompleted || view.finalSummaryVisible || revealingSummary) return;
    setRevealingSummary(true);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/game/final-summary/reveal`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) throw new Error('Final summary reveal unavailable');
      setStatus('מציגים את הסיכום הסופי לכולם…');
    } catch {
      setStatus('לא הצלחנו להציג את הסיכום הסופי. נסו שוב.');
    } finally {
      setRevealingSummary(false);
    }
  }

  async function continueAfterFinalHand(finalHand: boolean) {
    if (!isCurrentHost || !view?.gameCompleted || view.finalSummaryVisible || continuingHand) return;
    setContinuingHand(true);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/game/continue`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ finalHand }),
      });
      if (!response.ok) throw new Error('Continuation unavailable');
      setContinueDialogOpen(false);
      setStatus(finalHand ? 'מחלקים עוד יד אחרונה…' : 'ממשיכים לשחק…');
    } catch {
      setStatus('לא הצלחנו להתחיל עוד יד. נסו שוב.');
    } finally {
      setContinuingHand(false);
    }
  }

  async function loadManagement() {
    if (!isCurrentHost) return;
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/management`, { credentials: 'include', cache: 'no-store' });
      const next = await response.json() as ManagementView;
      if (!response.ok || !Array.isArray(next.players)) throw new Error('Management unavailable');
      setManagement(next);
      setSmallBlind(String(next.smallBlind));
      setBigBlind(String(next.bigBlind));
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
    if (!isCurrentHost || managementBusy || !validBlinds) return;
    setManagementBusy(true);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/management/blinds`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ smallBlind: selectedSmallBlind, bigBlind: selectedBigBlind }),
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
      setTopUpAmounts((current) => ({ ...current, [targetPlayerId]: '' }));
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

  async function declineRebuy(targetPlayerId: string, playerName: string) {
    if (!isCurrentHost || managementBusy) return;
    setManagementBusy(true);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/management/players/${encodeURIComponent(targetPlayerId)}/rebuy/decline`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      });
      if (!response.ok) throw new Error('Rebuy decision unavailable');
      await loadManagement();
      setStatus(`${playerName} מחוץ לשולחן. אפשר להחזיר אותו בהמשך דרך ניהול השולחן.`);
    } catch { setStatus('לא הצלחנו לעדכן את החלטת המארח. נסו שוב.'); } finally { setManagementBusy(false); }
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

  async function downloadFinalSummary() {
    if (!finalSummary || !isCurrentHost || downloadingSummary) return;
    setDownloadingSummary(true);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/final-summary/download`, { credentials: 'include', cache: 'no-store' });
      if (!response.ok) throw new Error('Summary download unavailable');
      const blob = await response.blob();
      const url = globalThis.URL.createObjectURL(blob);
      const link = globalThis.document.createElement('a');
      link.href = url;
      link.download = `texas-holdem-${joinId}-summary.json`;
      link.click();
      globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(url), 1_000);
    } catch {
      setStatus('לא הצלחנו להוריד את סיכום המשחק. נסו שוב.');
    } finally {
      setDownloadingSummary(false);
    }
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
    : view.isSittingOut && !ownSeat
      ? 'אתם מחוץ לשולחן · המארח יכול להחזיר אתכם עם ז׳יטונים ליד הבאה'
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
                <ProfileImage className="table-seat-avatar" dataUrl={seat.avatarDataUrl} fallback={seat.playerName.slice(0, 1)} />
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
        <div className="your-hand"><p><span aria-hidden="true">◆</span> {view.holeCards.length ? 'הקלפים שלכם' : 'מחוץ לשולחן'}</p><div className="hole-cards">{view.holeCards.length ? <><PlayingCard card={view.holeCards[0]} /><PlayingCard card={view.holeCards[1]} /></> : <small>ממתינים להחזרה ליד הבאה</small>}</div></div>
        <div className="your-stack"><span>הערימה שלכם</span><strong><i aria-hidden="true" />{ownSeat?.stack.toLocaleString('he-IL') ?? (view.isSittingOut ? '0' : '—')}</strong><small>צ׳יפים</small></div>
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
        {view.showdown && (!view.gameCompleted || !view.finalSummaryVisible) ? <div className="between-hands-controls" aria-label="פעולות בין ידיים">
          {canRevealAtShowdown ? <button type="button" className="reveal-hand-button" disabled={revealingHand} onClick={() => void revealHand()}>{revealingHand ? 'חושפים…' : 'לחשוף את היד שלי'}</button> : null}
          {view.gameCompleted
            ? isCurrentHost ? <div className="final-hand-decisions"><button type="button" disabled={revealingSummary || continuingHand} onClick={() => void revealFinalSummary()}>{revealingSummary ? 'מציגים…' : 'הצגת הסיכום'}</button><button type="button" disabled={revealingSummary || continuingHand} onClick={() => setContinueDialogOpen(true)}>עוד יד</button></div> : <small>היד האחרונה הסתיימה. ממתינים להחלטת המארח.</small>
            : isCurrentHost ? <button type="button" className="next-hand-button" disabled={startingNextHand || bustedPlayers.length > 0} onClick={() => void startNextHand()}>{startingNextHand ? 'מחלקים…' : bustedPlayers.length ? 'קודם מחליטים לגבי שחקנים שהתרוקנו' : management?.nextHandIsFinal ? 'התחלת היד האחרונה' : 'היד הבאה'}</button> : <small>המארח יכול להתחיל את היד הבאה.</small>}
        </div> : null}
      </section>
      {isCurrentHost && view.street === 'showdown' && !view.finalSummaryVisible && bustedPlayers.length > 0 ? <div className="rebuy-backdrop"><section className="rebuy-dialog" role="dialog" aria-modal="true" aria-labelledby="rebuy-title">
        <p>החלטת מארח בין ידיים</p><h2 id="rebuy-title">נגמרו לשחקנים הז׳יטונים</h2><small>אפשר להחזיר אותם ליד הבאה, או להשאיר אותם בחדר מחוץ לשולחן. גם בהמשך תוכלו להוסיף להם ז׳יטונים מאותו חשבון שחקן.</small>
        {bustedPlayers.map((player) => <div key={player.id} className="rebuy-player"><strong>{player.displayName}{player.isHost ? ' · אתם' : ''}</strong><div><input aria-label={`כמות ז׳יטונים ל${player.displayName}`} type="number" inputMode="numeric" min="1" placeholder="כמות ז׳יטונים" value={topUpAmounts[player.id] ?? ''} onChange={(event) => setTopUpAmounts((current) => ({ ...current, [player.id]: event.target.value }))} /><button type="button" disabled={managementBusy || parsePositiveInteger(topUpAmounts[player.id] ?? '') === undefined} onClick={() => void addChips(player.id, player.displayName, parsePositiveInteger(topUpAmounts[player.id] ?? '') ?? 0)}>הוספת ז׳יטונים</button><button type="button" className="rebuy-decline" disabled={managementBusy} onClick={() => void declineRebuy(player.id, player.displayName)}>לא להוסיף כרגע</button></div></div>)}
      </section></div> : null}
      {continueDialogOpen && isCurrentHost && view?.gameCompleted && !view.finalSummaryVisible ? <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !continuingHand) setContinueDialogOpen(false);
      }}><section className="continue-hand-dialog" role="dialog" aria-modal="true" aria-labelledby="continue-hand-title">
        <p>ממשיכים לשחק</p>
        <h2 id="continue-hand-title">האם היד הבאה תהיה האחרונה?</h2>
        <div><button type="button" disabled={continuingHand} onClick={() => void continueAfterFinalHand(true)}>{continuingHand ? 'מחלקים…' : 'כן, עוד יד אחרונה'}</button><button type="button" disabled={continuingHand} onClick={() => void continueAfterFinalHand(false)}>{continuingHand ? 'מחלקים…' : 'לא, ממשיכים כרגיל'}</button></div>
        <button type="button" className="continue-cancel" disabled={continuingHand} onClick={() => setContinueDialogOpen(false)}>ביטול</button>
      </section></div> : null}
      {managementOpen && isCurrentHost ? <div className="management-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setManagementOpen(false);
      }}><section className="management-sheet" role="dialog" aria-modal="true" aria-labelledby="management-title">
        <header><div><small>הרשאות מארח</small><h2 id="management-title">ניהול שולחן</h2></div><button type="button" aria-label="סגירת ניהול" onClick={() => setManagementOpen(false)}>×</button></header>
        <p className="management-note">שינויים בערימות, בליינדים ויציאות יחולו לפני היד הבאה.</p>
        <div className="management-grid">
          <section className="management-card"><h3>היד האחרונה</h3><p>{management?.nextHandIsFinal ? 'היד הבאה מסומנת כאחרונה.' : 'המשחק ימשיך כרגיל.'}</p><button type="button" className={management?.nextHandIsFinal ? 'management-cancel' : 'management-gold'} disabled={managementBusy} onClick={() => void scheduleFinalHand(!management?.nextHandIsFinal)}>{management?.nextHandIsFinal ? 'ביטול הסימון' : 'סימון סיבוב אחרון'}</button></section>
          <section className="management-card"><h3>בליינדים מהיד הבאה</h3><div className="blind-inputs"><label>סמול<input type="number" inputMode="numeric" min="1" value={smallBlind} onChange={(event) => setSmallBlind(event.target.value)} /></label><label>ביג<input type="number" inputMode="numeric" min="2" value={bigBlind} onChange={(event) => setBigBlind(event.target.value)} /></label></div><button type="button" disabled={managementBusy || !validBlinds} onClick={() => void saveBlinds()}>שמירת בליינדים</button></section>
          <section className="management-card management-invite"><h3>הוספת שחקנים</h3><p>הקישור תמיד פותח את מסך האורח.</p><button type="button" onClick={() => void copyInvitationForNextHand()}>העתקת קישור הזמנה</button></section>
        </div>
        <button type="button" className="management-roster-toggle" aria-expanded={playersOpen} onClick={() => setPlayersOpen((open) => !open)}><span>רשימת שחקנים</span><strong>{management?.players.length ?? 0}</strong><i aria-hidden="true">{playersOpen ? '−' : '+'}</i></button>
        {playersOpen ? <section className="management-players"><h3>שחקנים וניהול ערימות</h3>{management?.players.map((player) => <article key={player.id} className={player.leaveAfterHand ? 'player-management-leaving' : ''}>
          <div><strong>{player.displayName}{player.isHost ? ' · מארח' : ''}</strong><small>{player.currentStack.toLocaleString('he-IL')} ז׳יטונים{player.isSittingOut ? ' · מחוץ לשולחן' : ''}{player.pendingChips ? ` · ${player.pendingChips.toLocaleString('he-IL')}+ ממתינים ליד הבאה` : ''}{player.leaveAfterHand ? ' · יוצא ביד הבאה' : ''}</small></div>
          <div className="player-management-actions">
            {!player.leaveAfterHand ? <><input aria-label={`ז׳יטונים ל${player.displayName}`} type="number" inputMode="numeric" min="1" placeholder="כמות" value={topUpAmounts[player.id] ?? ''} onChange={(event) => setTopUpAmounts((current) => ({ ...current, [player.id]: event.target.value }))} /><button type="button" disabled={managementBusy || parsePositiveInteger(topUpAmounts[player.id] ?? '') === undefined} onClick={() => void addChips(player.id, player.displayName, parsePositiveInteger(topUpAmounts[player.id] ?? '') ?? 0)}>{player.isSittingOut ? 'החזרה לשולחן' : 'הוספה'}</button>{player.pendingChips > 0 ? <button type="button" className="management-cancel" disabled={managementBusy} onClick={() => void cancelChips(player.id)}>ביטול תוספת</button> : null}</> : null}
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
        <small>{finalSummary.handCount} ידיים הסתיימו{isCurrentHost ? ' · פירוט הפעולות והתשלומים נשמר בקובץ.' : '.'}</small>
        {isCurrentHost ? <button type="button" disabled={downloadingSummary} onClick={() => void downloadFinalSummary()}>{downloadingSummary ? 'מורידים…' : 'הורדת סיכום JSON'}</button> : null}
      </section></div> : null}
    </main>
  );
}
