'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AvatarPicker } from './avatar-picker';
import { SERVER_URL, googleLoginPath, type AccountState } from './account-api';
import { HistoryList } from './history/history-list';
import HistoryGame from './history/[joinId]/history-game';
import { ProfileImage } from './profile-image';
import { answerFriendRequest, loadSocialUsers, removeFriend, requestFriend, type SocialAccount, type SocialOverview } from './social-api';

export function HomeAccountPanel({ account, social, onSocialChange, onClose, onAccountChange }: {
  account: AccountState;
  social?: SocialOverview;
  onSocialChange: () => Promise<void>;
  onClose: () => void;
  onAccountChange: (account: AccountState) => void;
}) {
  const [tab, setTab] = useState<'profile' | 'friends' | 'history'>('profile');
  const [selectedGame, setSelectedGame] = useState<string>();
  const [name, setName] = useState(account.profile?.displayName ?? '');
  const [avatar, setAvatar] = useState(account.profile?.avatarDataUrl ?? undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [directoryUsers, setDirectoryUsers] = useState<SocialAccount[]>([]);
  const [nextDirectoryCursor, setNextDirectoryCursor] = useState<string | null>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState(false);
  const [directoryRetry, setDirectoryRetry] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (tab !== 'friends') return;
    let active = true;
    setDirectoryLoading(true);
    setDirectoryError(false);
    void loadSocialUsers().then((page) => {
      if (active) { setDirectoryUsers(page.users); setNextDirectoryCursor(page.nextCursor); }
    }).catch(() => { if (active) setDirectoryError(true); })
      .finally(() => { if (active) setDirectoryLoading(false); });
    return () => { active = false; };
  }, [tab, directoryRetry]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/auth/profile`, {
        method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: name.trim(), avatarDataUrl: avatar ?? null }),
      });
      if (!response.ok) throw new Error('Profile update failed');
      onAccountChange({ ...account, profile: { ...account.profile!, displayName: name.trim(), avatarDataUrl: avatar ?? null } });
      setMessage('הפרופיל נשמר.');
    } catch {
      setMessage('לא הצלחנו לשמור את הפרופיל. נסו שוב.');
    } finally {
      setBusy(false);
    }
  }

  async function sendFriendRequest(username: string) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await requestFriend(username);
      setMessage(result);
      if (result === 'בקשת החברות נשלחה.') await onSocialChange();
    } catch { setMessage('לא הצלחנו לשלוח את הבקשה. נסו שוב.'); }
    finally { setBusy(false); }
  }

  async function loadMoreUsers() {
    if (!nextDirectoryCursor || directoryLoading) return;
    setDirectoryLoading(true);
    setDirectoryError(false);
    try {
      const page = await loadSocialUsers(nextDirectoryCursor);
      setDirectoryUsers((current) => [...current, ...page.users]);
      setNextDirectoryCursor(page.nextCursor);
    } catch { setDirectoryError(true); }
    finally { setDirectoryLoading(false); }
  }

  async function respondToFriend(id: string, accept: boolean) {
    setBusy(true);
    try { await answerFriendRequest(id, accept); await onSocialChange(); setMessage(accept ? 'בקשת החברות אושרה.' : 'בקשת החברות נדחתה.'); }
    catch { setMessage('לא הצלחנו לעדכן את הבקשה.'); }
    finally { setBusy(false); }
  }

  async function unfriend(id: string, name: string) {
    if (!globalThis.confirm(`להסיר את ${name} מרשימת החברים?`)) return;
    setBusy(true);
    try { await removeFriend(id); await onSocialChange(); setMessage('החבר הוסר.'); }
    catch { setMessage('לא הצלחנו להסיר את החבר.'); }
    finally { setBusy(false); }
  }

  return <div className="home-account-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="home-account-panel" role="dialog" aria-modal="true" aria-label="החשבון שלי">
      <header className="home-account-header"><div><ProfileImage className="entry-account-avatar" dataUrl={account.profile?.avatarDataUrl} fallback="♠" /><strong>{account.profile?.displayName ?? 'החשבון שלי'}</strong></div><button type="button" ref={closeRef} className="home-account-close" aria-label="סגירת הפאנל" onClick={onClose}>×</button></header>
      <div className="home-account-tabs" role="tablist" aria-label="פרופיל, חברים והיסטוריה"><button type="button" role="tab" aria-selected={tab === 'profile'} onClick={() => setTab('profile')}>פרופיל</button><button type="button" role="tab" aria-selected={tab === 'friends'} onClick={() => { setTab('friends'); setMessage(undefined); void onSocialChange(); }}>חברים{social?.incoming.length ? ` (${social.incoming.length})` : ''}</button><button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => { setTab('history'); setSelectedGame(undefined); }}>היסטוריית משחקים</button></div>
      {tab === 'profile' ? <div className="home-account-content"><form className="entry-form" onSubmit={(event) => void save(event)}>
        <label htmlFor="home-profile-name">שם השחקן שלכם</label><input id="home-profile-name" value={name} maxLength={24} autoComplete="nickname" onChange={(event) => setName(event.target.value)} disabled={busy} required />
        <AvatarPicker value={avatar} onChange={setAvatar} disabled={busy} />
        <button className="entry-primary" type="submit" disabled={busy || !name.trim()}>{busy ? 'שומרים…' : 'שמירת שינויים'}</button>
        {message ? <p className="entry-status" role="status">{message}</p> : null}
      </form></div> : tab === 'friends' ? <div className="home-account-content social-panel">
        <div className="social-identity"><span>שם המשתמש שלכם</span>{account.profile?.username ? <strong dir="ltr">@{account.profile.username}</strong> : <a href={googleLoginPath('/')}>התחברו שוב עם Google כדי להפעיל שם משתמש</a>}</div>
        <section className="social-directory"><h3>שחקנים באפליקציה</h3>{directoryUsers.map((user) => {
          const incoming = social?.incoming.find((request) => request.from.id === user.id);
          const isFriend = social?.friends.some((friend) => friend.id === user.id);
          const pending = social?.outgoing.some((request) => request.to.id === user.id);
          return <div className="social-person" key={user.id}><ProfileImage className="social-avatar" dataUrl={user.avatarDataUrl} fallback="♠" /><span><strong>{user.displayName ?? user.username}</strong><small dir="ltr">@{user.username}</small></span><button type="button" disabled={busy || Boolean(isFriend || pending)} onClick={() => incoming ? void respondToFriend(incoming.id, true) : user.username ? void sendFriendRequest(user.username) : undefined}>{isFriend ? 'חברים' : pending ? 'ממתינים' : incoming ? 'אישור בקשה' : 'שליחת בקשה'}</button></div>;
        })}{!directoryLoading && !directoryUsers.length && !directoryError ? <p>אין עדיין שחקנים נוספים באפליקציה.</p> : null}{directoryError ? <p role="alert">לא הצלחנו לטעון את רשימת השחקנים.</p> : null}{nextDirectoryCursor ? <button type="button" className="social-load-more" disabled={directoryLoading} onClick={() => void loadMoreUsers()}>{directoryLoading ? 'טוענים…' : 'הצגת שחקנים נוספים'}</button> : directoryError ? <button type="button" className="social-load-more" onClick={() => setDirectoryRetry((count) => count + 1)}>לנסות שוב</button> : directoryLoading ? <p role="status">טוענים שחקנים…</p> : null}</section>
        {social?.incoming.length ? <section><h3>בקשות שקיבלתם</h3>{social.incoming.map((request) => <div className="social-person" key={request.id}><ProfileImage className="social-avatar" dataUrl={request.from.avatarDataUrl} fallback="♠" /><span><strong>{request.from.displayName ?? request.from.username}</strong><small dir="ltr">@{request.from.username}</small></span><button type="button" disabled={busy} onClick={() => void respondToFriend(request.id, true)}>אישור</button><button type="button" disabled={busy} onClick={() => void respondToFriend(request.id, false)}>דחייה</button></div>)}</section> : null}
        <section><h3>החברים שלכם</h3>{social?.friends.length ? social.friends.map((friend) => <div className="social-person" key={friend.id}><ProfileImage className="social-avatar" dataUrl={friend.avatarDataUrl} fallback="♠" /><span><strong>{friend.displayName ?? friend.username}</strong><small dir="ltr">@{friend.username}</small></span><button type="button" className="social-remove-friend" disabled={busy} onClick={() => void unfriend(friend.id, friend.displayName ?? friend.username ?? '')}>הסרה</button></div>) : <p>עדיין אין חברים. בחרו שחקן מהרשימה ושלחו לו בקשה.</p>}</section>
        {social?.outgoing.length ? <section><h3>בקשות ששלחתם</h3>{social.outgoing.map((request) => <p key={request.id}>@{request.to.username} · ממתינים לאישור</p>)}</section> : null}
        {message ? <p className="social-message" role="status">{message}</p> : null}
      </div> : selectedGame ? <HistoryGame joinId={selectedGame} onBack={() => setSelectedGame(undefined)} /> : <section className="history-panel home-history-panel"><HistoryList onSelectGame={setSelectedGame} /></section>}
    </section>
  </div>;
}
