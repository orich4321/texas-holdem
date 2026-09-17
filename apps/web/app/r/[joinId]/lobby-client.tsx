'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  EMPTY_NICKNAME_MESSAGE,
  type Lobby,
  loadLobby,
  joinLobby,
  startLobbyGame,
} from '../../lobby-api';
import TableClient from './table-client';

type LobbyClientProps = { joinId: string; isHostRoute?: boolean };

export default function LobbyClient({ joinId, isHostRoute = false }: LobbyClientProps) {
  const [lobby, setLobby] = useState<Lobby>();
  const [nickname, setNickname] = useState('');
  const [loadError, setLoadError] = useState<string>();
  const [joinMessage, setJoinMessage] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState<string>();

  const refreshLobby = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(undefined);
    const result = await loadLobby(joinId, { fetch: (...args) => globalThis.fetch(...args) }, signal);
    if (signal?.aborted) return;
    if (result.ok) setLobby(result.lobby);
    else setLoadError(result.message);
    setLoading(false);
  }, [joinId]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshLobby(controller.signal);
    return () => controller.abort();
  }, [refreshLobby]);

  useEffect(() => {
    if (lobby?.status !== 'WAITING') return undefined;
    const timer = globalThis.setInterval(() => { void refreshLobby(); }, 1_000);
    return () => globalThis.clearInterval(timer);
  }, [lobby?.status, refreshLobby]);

  useEffect(() => {
    if (lobby?.isHost && !isHostRoute) {
      globalThis.location.replace(`/r/${encodeURIComponent(joinId)}/host`);
    }
  }, [isHostRoute, joinId, lobby?.isHost]);

  useEffect(() => {
    // Knowing the /host pathname never conveys authority. A session that is
    // not the persisted room owner is sent to the ordinary invitation flow.
    if (isHostRoute && lobby && !lobby.isHost) {
      globalThis.location.replace(`/r/${encodeURIComponent(joinId)}`);
    }
  }, [isHostRoute, joinId, lobby]);

  async function handleJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (joining) return;
    setJoinMessage(undefined);
    if (!nickname.trim()) {
      setJoinMessage(EMPTY_NICKNAME_MESSAGE);
      return;
    }

    setJoining(true);
    const result = await joinLobby(joinId, nickname, { fetch: (...args) => globalThis.fetch(...args) });
    if (result.ok) {
      setNickname('');
      await refreshLobby();
    } else {
      setJoinMessage(result.message);
    }
    setJoining(false);
  }

  async function copyInvitation() {
    try {
      // The invite is always the guest route, even when the host is viewing
      // their distinct route. Server-side session auth still enforces roles.
      await globalThis.navigator.clipboard.writeText(
        new URL(`/r/${encodeURIComponent(joinId)}`, globalThis.location.origin).toString(),
      );
      setCopied('הקישור הועתק. אפשר לשלוח אותו לשולחן.');
    } catch {
      setCopied('לא הצלחנו להעתיק. אפשר להעתיק את הקישור משורת הכתובת.');
    }
  }

  async function handleStart() {
    if (starting) return;
    setStarting(true);
    setJoinMessage(undefined);
    const result = await startLobbyGame(joinId, { fetch: (...args) => globalThis.fetch(...args) });
    if (result.ok) await refreshLobby();
    else setJoinMessage(result.message);
    setStarting(false);
  }

  if (loading && !lobby) {
    return <main className="lobby-shell" aria-busy="true"><p className="lobby-loading">טוענים את השולחן…</p></main>;
  }

  if (loadError && !lobby) {
    return (
      <main className="lobby-shell">
        <section className="lobby-error" aria-labelledby="lobby-error-title">
          <p aria-hidden="true">♠</p>
          <h1 id="lobby-error-title">החדר לא זמין כרגע</h1>
          <p role="alert">{loadError}</p>
          <button type="button" onClick={() => void refreshLobby()} disabled={loading}>נסו שוב</button>
        </section>
      </main>
    );
  }

  if (!lobby) return null;

  if (isHostRoute && !lobby.isHost) {
    return <main className="lobby-shell"><p className="lobby-loading" role="status">בודקים את ההרשאות ומעבירים אתכם להזמנה…</p></main>;
  }

  if (lobby.status === 'IN_PROGRESS') return <TableClient joinId={joinId} isHost={lobby.isHost} />;

  return (
    <main className="lobby-shell">
      <div className="lobby-glow lobby-glow-top" aria-hidden="true" />
      <div className="lobby-glow lobby-glow-bottom" aria-hidden="true" />
      <section className="lobby-card" aria-labelledby="lobby-title">
        <header className="lobby-header">
          <p className="lobby-kicker"><span aria-hidden="true">♠</span> שולחן פרטי</p>
          <h1 id="lobby-title">מחכים לשחקנים</h1>
          <p>הצטרפו, שתפו את הקישור, וכשהחברים כאן — מתחילים.</p>
        </header>

        <div className="lobby-host" aria-label={`המארח: ${lobby.host.displayName}`}>
          <span className="lobby-avatar" aria-hidden="true">♛</span>
          <div><span>המארח</span><strong>{lobby.host.displayName}</strong></div>
          <span className="lobby-host-chip">בשולחן</span>
        </div>

        <section className="lobby-roster" aria-labelledby="roster-title">
          <div className="lobby-roster-heading">
            <h2 id="roster-title">השחקנים בשולחן</h2>
            <span aria-label={`${lobby.players.length} ${lobby.players.length === 1 ? 'שחקן' : 'שחקנים'}`}>{lobby.players.length}</span>
          </div>
          <ul>
            {lobby.players.map((player, index) => (
              <li key={`${player.displayName}-${index}`}>
                <span className="lobby-seat" aria-hidden="true">{index + 1}</span>
                <strong>{player.displayName}</strong>
                <span>{player.currentStack.toLocaleString('he-IL')} <small>צ׳יפים</small></span>
              </li>
            ))}
          </ul>
        </section>

        <section className="lobby-settings" aria-label="הגדרות המשחק">
          <p>הגדרות המשחק</p>
          <div><span>ערימת פתיחה</span><strong>{lobby.settings.initialStack.toLocaleString('he-IL')}</strong><small>צ׳יפים</small></div>
          <div><span>בליינדים</span><strong>{lobby.settings.smallBlind}/{lobby.settings.bigBlind}</strong></div>
        </section>

        <div className="lobby-share">
          <div><strong>מזמינים עוד חברים?</strong><span>שולחים להם את הקישור האישי לשולחן.</span></div>
          <button type="button" onClick={() => void copyInvitation()}>העתקת קישור</button>
          {copied ? <p role="status" aria-live="polite">{copied}</p> : null}
        </div>

        {lobby.canStart ? (
          <button type="button" className="lobby-start" onClick={() => void handleStart()} disabled={starting}>
            {starting ? 'מחלקים קלפים…' : 'התחילו את היד'}
          </button>
        ) : null}

        {isHostRoute && lobby.isHost ? (
          <p className="lobby-already-joined" role="status">אתם המארחים וכבר יושבים בשולחן הזה.</p>
        ) : lobby.isParticipant ? (
          <p className="lobby-already-joined" role="status">אתם כבר יושבים בשולחן הזה.</p>
        ) : (
          <form className="lobby-join-form" onSubmit={handleJoin}>
            <div className="lobby-form-heading"><h2>הצטרפו לשולחן</h2><span>{lobby.settings.initialStack.toLocaleString('he-IL')} צ׳יפים</span></div>
            <label htmlFor="lobby-nickname">הכינוי שלכם</label>
            <div className="lobby-input-row">
              <input id="lobby-nickname" name="nickname" type="text" autoComplete="nickname" maxLength={24} placeholder="איך לקרוא לכם?" value={nickname} onChange={(event) => setNickname(event.target.value)} disabled={joining} aria-describedby={joinMessage ? 'join-status' : undefined} />
              <button type="submit" disabled={joining}>{joining ? 'מצטרפים…' : 'הצטרפות'}</button>
            </div>
            {joinMessage ? <p id="join-status" className="lobby-status" role="status" aria-live="polite">{joinMessage}</p> : null}
          </form>
        )}
      </section>
    </main>
  );
}
