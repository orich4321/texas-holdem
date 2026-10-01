'use client';

import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import {
  EMPTY_NICKNAME_MESSAGE,
  type Lobby,
  loadLobby,
  joinLobby,
  removeWaitingPlayer,
  startLobbyGame,
} from '../../lobby-api';
import TableClient from './table-client';
import { AppBrand, StateScreen } from '../../ui';
import { AvatarPicker } from '../../avatar-picker';
import { ProfileImage } from '../../profile-image';
import { unlockActionAudio } from '../../action-sounds';
import { googleLoginPath, loadAccount, profilePath, type AccountState } from '../../account-api';
import { usePageActivity } from '../../use-page-activity';
import { inviteFriend, loadSocial, type SocialAccount } from '../../social-api';

type LobbyClientProps = { joinId: string; isHostRoute?: boolean };

function unlockPreferredActionAudio() {
  try {
    if (globalThis.localStorage.getItem('holdem-action-sound-enabled') === 'false') return;
  } catch { /* Storage is optional. */ }
  void unlockActionAudio();
}

export default function LobbyClient({ joinId, isHostRoute = false }: LobbyClientProps) {
  const activity = usePageActivity();
  const [lobby, setLobby] = useState<Lobby>();
  const [nickname, setNickname] = useState('');
  const [avatarDataUrl, setAvatarDataUrl] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [joinMessage, setJoinMessage] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [starting, setStarting] = useState(false);
  const [removingPlayerId, setRemovingPlayerId] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const [account, setAccount] = useState<AccountState>();
  const [friends, setFriends] = useState<SocialAccount[]>([]);
  const [invitingFriendId, setInvitingFriendId] = useState<string>();
  const [inviteMessage, setInviteMessage] = useState('');
  const autoJoinAttempted = useRef(false);
  const wasNetworkActive = useRef(activity.networkActive);

  useEffect(() => {
    void loadAccount().then(setAccount).catch(() => setJoinMessage('לא הצלחנו לבדוק את החשבון. נסו לרענן את הדף.'));
  }, []);

  useEffect(() => {
    if (!account?.profile?.id || !lobby?.isHost || lobby.status !== 'WAITING') return;
    void loadSocial().then((overview) => setFriends(overview.friends)).catch(() => setInviteMessage('לא הצלחנו לטעון את רשימת החברים.'));
  }, [account?.profile?.id, lobby?.isHost, lobby?.status]);

  async function sendInvite(friend: SocialAccount) {
    setInvitingFriendId(friend.id);
    setInviteMessage('');
    try {
      await inviteFriend(joinId, friend.id);
      setInviteMessage(`ההזמנה נשלחה אל ${friend.displayName ?? friend.username}.`);
    } catch { setInviteMessage('לא הצלחנו לשלוח את ההזמנה. בדקו שהחבר עדיין זמין להצטרפות.'); }
    finally { setInvitingFriendId(undefined); }
  }

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
    if (lobby?.status !== 'WAITING' || !activity.networkActive) return undefined;
    let active = true;
    let timer: ReturnType<typeof globalThis.setTimeout>;
    const poll = async () => {
      await refreshLobby();
      if (active) timer = globalThis.setTimeout(() => { void poll(); }, 2_000);
    };
    timer = globalThis.setTimeout(() => { void poll(); }, 2_000);
    return () => { active = false; globalThis.clearTimeout(timer); };
  }, [lobby?.status, refreshLobby, activity.networkActive]);

  useEffect(() => {
    if (activity.networkActive && !wasNetworkActive.current && lobby?.status === 'WAITING') void refreshLobby();
    wasNetworkActive.current = activity.networkActive;
  }, [activity.networkActive, lobby?.status, refreshLobby]);

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

  useEffect(() => {
    if (!account?.enabled || !account.profile?.displayName || !lobby || lobby.isParticipant || lobby.status === 'COMPLETED' || (isHostRoute && !lobby.isHost) || autoJoinAttempted.current) return;
    autoJoinAttempted.current = true;
    setJoining(true);
    void joinLobby(joinId, account.profile.displayName, { fetch: (...args) => globalThis.fetch(...args) }, account.profile.avatarDataUrl ?? undefined)
      .then(async (result) => {
        if (result.ok) await refreshLobby();
        else setJoinMessage(result.message);
      })
      .finally(() => setJoining(false));
  }, [account, isHostRoute, joinId, lobby, refreshLobby]);

  async function handleJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (joining) return;
    unlockPreferredActionAudio();
    setJoinMessage(undefined);
    if (!nickname.trim()) {
      setJoinMessage(EMPTY_NICKNAME_MESSAGE);
      return;
    }

    setJoining(true);
    const result = await joinLobby(joinId, nickname, { fetch: (...args) => globalThis.fetch(...args) }, avatarDataUrl);
    if (result.ok) {
      setNickname('');
      setAvatarDataUrl(undefined);
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

  async function copyRoomCode() {
    try {
      await globalThis.navigator.clipboard.writeText(joinId.toUpperCase());
      setCopied('קוד החדר הועתק. החברים יכולים להזין אותו בעמוד כניסה לחדר.');
    } catch {
      setCopied('לא הצלחנו להעתיק. אפשר להקריא את הקוד שמופיע כאן.');
    }
  }

  async function handleStart() {
    if (starting) return;
    unlockPreferredActionAudio();
    setStarting(true);
    setJoinMessage(undefined);
    const result = await startLobbyGame(joinId, { fetch: (...args) => globalThis.fetch(...args) });
    if (result.ok) await refreshLobby();
    else setJoinMessage(result.message);
    setStarting(false);
  }

  async function handleRemovePlayer(playerId: string, displayName: string) {
    if (removingPlayerId || !globalThis.confirm(`להסיר את ${displayName} מהחדר? הוא לא יוכל להצטרף מחדש עם אותו חשבון.`)) return;
    setRemovingPlayerId(playerId);
    setJoinMessage(undefined);
    const result = await removeWaitingPlayer(joinId, playerId, { fetch: (...args) => globalThis.fetch(...args) });
    if (result.ok) await refreshLobby();
    else setJoinMessage(result.message);
    setRemovingPlayerId(undefined);
  }

  if (loading && !lobby) {
    return <StateScreen icon="♠" title="מכינים את השולחן"><p className="state-loading" aria-busy="true">טוענים את החדר הפרטי…</p></StateScreen>;
  }

  if (loadError && !lobby) {
    return (
      <StateScreen icon="!" title="החדר לא זמין כרגע">
        <div className="lobby-error" aria-labelledby="lobby-error-title">
          <p role="alert">{loadError}</p>
          <button type="button" onClick={() => void refreshLobby()} disabled={loading}>נסו שוב</button>
        </div>
      </StateScreen>
    );
  }

  if (!lobby) return null;

  if (isHostRoute && !lobby.isHost) {
    return <StateScreen icon="♠" title="בודקים הרשאות"><p role="status">מעבירים אתכם למסך ההזמנה…</p></StateScreen>;
  }

  if ((lobby.status === 'IN_PROGRESS' || lobby.status === 'COMPLETED') && lobby.isParticipant) {
    return <><TableClient joinId={joinId} isHost={lobby.isHost} networkActive={activity.networkActive} />{activity.paused ? <div className="idle-overlay" role="status"><div><strong>השולחן מושהה במכשיר הזה</strong><p>לא הייתה פעילות במשך 10 דקות. עצרנו את החיבור והרענון כדי לחסוך בתעבורה. המשחק והמושב שלכם שמורים.</p><button type="button" onClick={activity.resume}>חזרה לשולחן</button></div></div> : null}</>;
  }

  if (lobby.status === 'COMPLETED') {
    return <StateScreen icon="♠" title="המשחק כבר הסתיים"><p>רק משתתפי השולחן יכולים לפתוח את הסיכום הסופי.</p></StateScreen>;
  }

  if (!lobby.isParticipant && !lobby.isHost) {
    return (
      <main className="entry-shell join-entry-shell">
        <div className="app-aurora" aria-hidden="true" />
        <header className="entry-topbar"><AppBrand compact /><span>הזמנה פרטית</span></header>
        <section className="entry-stage">
          <div className="entry-panel join-entry-panel" aria-labelledby="join-title">
            <div className="entry-host" aria-label={`המארח: ${lobby.host.displayName}`}>
              <ProfileImage className="entry-host-avatar" dataUrl={lobby.host.avatarDataUrl} fallback="♠" />
              <div><small>הוזמנתם לשולחן של</small><strong>{lobby.host.displayName}</strong></div>
            </div>
            <div className="entry-intro">
              <h1 id="join-title">מצטרפים למשחק</h1>
              <span>{lobby.settings.initialStack.toLocaleString('he-IL')} צ׳יפים · בליינדים {lobby.settings.smallBlind}/{lobby.settings.bigBlind}</span>
            </div>
            {account?.enabled && !account.profile ? <a className="entry-primary" href={googleLoginPath(`/r/${joinId}`)}>התחברות עם Google והצטרפות</a> : null}
            {account?.enabled && account.profile && !account.profile.displayName ? <a className="entry-primary" href={profilePath(`/r/${joinId}`)}>השלמת פרופיל והצטרפות</a> : null}
            {account?.enabled && account.profile?.displayName ? <div className="join-account-status" role="status">{joining ? 'מצרפים אתכם לשולחן…' : joinMessage ?? 'מכינים את המקום שלכם בשולחן…'}{joinMessage ? <button type="button" onClick={() => { autoJoinAttempted.current = false; setJoinMessage(undefined); void refreshLobby(); }}>נסו שוב</button> : null}</div> : null}
            {account && !account.enabled ? <form className="entry-form join-entry-form" onSubmit={handleJoin}>
              <label htmlFor="lobby-nickname">השם שלכם בשולחן</label>
              <input id="lobby-nickname" name="nickname" type="text" autoComplete="nickname" maxLength={24} placeholder="איך לקרוא לכם?" value={nickname} onChange={(event) => setNickname(event.target.value)} disabled={joining} aria-describedby={joinMessage ? 'join-status' : undefined} />
              <AvatarPicker value={avatarDataUrl} onChange={setAvatarDataUrl} disabled={joining} />
              <button className="entry-primary" type="submit" disabled={joining}>{joining ? 'מצטרפים…' : 'כניסה לשולחן'}</button>
              {joinMessage ? <p id="join-status" className="entry-status" role="status" aria-live="polite">{joinMessage}</p> : null}
            </form> : null}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="lobby-shell">
      <div className="app-aurora" aria-hidden="true" />
      <header className="lobby-topbar"><AppBrand compact /><span className="private-pill"><i /> שולחן פרטי</span></header>
      <section className="lobby-card" aria-labelledby="lobby-title">
        <header className="lobby-header">
          <p className="lobby-kicker">LOBBY · {joinId.slice(0, 6).toUpperCase()}</p>
          <h1 id="lobby-title">מחכים לשחקנים</h1>
          <p>הצטרפו, שתפו את הקישור, וכשהחברים כאן — מתחילים.</p>
        </header>

        <div className="lobby-content">
          <div className="lobby-main-column">
            <div className="lobby-host" aria-label={`המארח: ${lobby.host.displayName}`}>
              <ProfileImage className="lobby-avatar" dataUrl={lobby.host.avatarDataUrl} fallback="♛" />
              <div><span>מנהל השולחן</span><strong>{lobby.host.displayName}</strong></div>
              <span className="lobby-host-chip"><i /> מחובר</span>
            </div>

            <section className="lobby-roster" aria-labelledby="roster-title">
              <div className="lobby-roster-heading">
                <h2 id="roster-title">השחקנים בשולחן</h2>
                <span aria-label={`${lobby.players.length} ${lobby.players.length === 1 ? 'שחקן' : 'שחקנים'}`}>{lobby.players.length} / 9</span>
              </div>
              <ul>
                {lobby.players.map((player, index) => (
                  <li key={player.id ?? `${player.displayName}-${index}`}>
                    <span className="lobby-seat" aria-hidden="true">{index + 1}</span>
                    <ProfileImage className="lobby-player-avatar" dataUrl={player.avatarDataUrl} fallback={player.displayName.slice(0, 1)} />
                    <strong>{player.displayName}</strong>
                    <span className="lobby-stack">{player.currentStack.toLocaleString('he-IL')} <small>צ׳יפים</small></span>
                    {lobby.isHost && index > 0 && player.id ? <button type="button" className="lobby-remove-player" disabled={Boolean(removingPlayerId) || starting} onClick={() => void handleRemovePlayer(player.id!, player.displayName)} aria-label={`הסרת ${player.displayName} מהחדר`}>{removingPlayerId === player.id ? 'מסירים…' : 'הסרה'}</button> : null}
                  </li>
                ))}
              </ul>
            </section>
            {joinMessage ? <p className="lobby-status" role="status">{joinMessage}</p> : null}
          </div>

          <aside className="lobby-side-column">
            <section className="lobby-settings" aria-label="הגדרות המשחק">
              <p>פרטי המשחק</p>
              <div><span>ערימת פתיחה</span><strong>{lobby.settings.initialStack.toLocaleString('he-IL')}</strong><small>צ׳יפים</small></div>
              <div><span>בליינדים</span><strong>{lobby.settings.smallBlind}/{lobby.settings.bigBlind}</strong></div>
            </section>

            <div className="lobby-share">
              <div><strong>מזמינים חברים</strong><span>קישור או קוד חדר יובילו למסך האורח, ללא הרשאות מארח.</span></div>
              <div className="room-code-display"><small>קוד החדר</small><code dir="ltr">{joinId.toUpperCase()}</code></div>
              <div className="room-share-buttons"><button type="button" onClick={() => void copyInvitation()}><span aria-hidden="true">↗</span> העתקת קישור</button><button type="button" onClick={() => void copyRoomCode()}>העתקת קוד</button></div>
              {lobby.isHost && account?.profile ? <div className="lobby-friend-invites"><strong>הזמנה דרך האתר</strong>{friends.length ? <div>{friends.map((friend) => <button type="button" key={friend.id} disabled={Boolean(invitingFriendId)} onClick={() => void sendInvite(friend)}><ProfileImage className="social-avatar" dataUrl={friend.avatarDataUrl} fallback="♠" /><span>{friend.displayName ?? friend.username}<small dir="ltr">@{friend.username}</small></span><b>{invitingFriendId === friend.id ? 'שולחים…' : 'הזמנה'}</b></button>)}</div> : <small>הוסיפו חברים דרך הפרופיל בדף הבית כדי להזמין אותם ישירות.</small>}{inviteMessage ? <p role="status">{inviteMessage}</p> : null}</div> : null}
              {copied ? <p role="status" aria-live="polite">{copied}</p> : null}
            </div>

            {lobby.canStart ? (
              <button type="button" className="lobby-start" onClick={() => void handleStart()} disabled={starting}>
                <span aria-hidden="true">♠</span>{starting ? 'מחלקים קלפים…' : 'התחילו את היד'}
              </button>
            ) : null}

            {isHostRoute && lobby.isHost ? (
              <p className="lobby-already-joined" role="status"><span aria-hidden="true">✓</span> אתם כבר יושבים בשולחן כמארחים.</p>
            ) : (
              <p className="lobby-already-joined" role="status"><span aria-hidden="true">✓</span> אתם כבר יושבים בשולחן הזה.</p>
            )}
          </aside>
        </div>
      </section>
      {activity.paused ? <div className="idle-overlay" role="status"><div><strong>החדר מושהה במכשיר הזה</strong><p>עצרנו את הרענון אחרי 10 דקות ללא פעילות. החדר והשחקנים נשמרו.</p><button type="button" onClick={activity.resume}>חזרה לחדר</button></div></div> : null}
    </main>
  );
}
