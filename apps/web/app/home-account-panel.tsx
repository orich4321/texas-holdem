'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AvatarPicker } from './avatar-picker';
import { SERVER_URL, type AccountState } from './account-api';
import { HistoryList } from './history/history-list';
import HistoryGame from './history/[joinId]/history-game';
import { ProfileImage } from './profile-image';

export function HomeAccountPanel({ account, onClose, onAccountChange }: {
  account: AccountState;
  onClose: () => void;
  onAccountChange: (account: AccountState) => void;
}) {
  const [tab, setTab] = useState<'profile' | 'history'>('profile');
  const [selectedGame, setSelectedGame] = useState<string>();
  const [name, setName] = useState(account.profile?.displayName ?? '');
  const [avatar, setAvatar] = useState(account.profile?.avatarDataUrl ?? undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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

  return <div className="home-account-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="home-account-panel" role="dialog" aria-modal="true" aria-label="החשבון שלי">
      <header className="home-account-header"><div><ProfileImage className="entry-account-avatar" dataUrl={account.profile?.avatarDataUrl} fallback="♠" /><strong>{account.profile?.displayName ?? 'החשבון שלי'}</strong></div><button type="button" ref={closeRef} className="home-account-close" aria-label="סגירת הפאנל" onClick={onClose}>×</button></header>
      <div className="home-account-tabs" role="tablist" aria-label="פרופיל והיסטוריה"><button type="button" role="tab" aria-selected={tab === 'profile'} onClick={() => setTab('profile')}>עריכת פרופיל</button><button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => { setTab('history'); setSelectedGame(undefined); }}>היסטוריית משחקים</button></div>
      {tab === 'profile' ? <div className="home-account-content"><form className="entry-form" onSubmit={(event) => void save(event)}>
        <label htmlFor="home-profile-name">שם השחקן שלכם</label><input id="home-profile-name" value={name} maxLength={24} autoComplete="nickname" onChange={(event) => setName(event.target.value)} disabled={busy} required />
        <AvatarPicker value={avatar} onChange={setAvatar} disabled={busy} />
        <button className="entry-primary" type="submit" disabled={busy || !name.trim()}>{busy ? 'שומרים…' : 'שמירת שינויים'}</button>
        {message ? <p className="entry-status" role="status">{message}</p> : null}
      </form></div> : selectedGame ? <HistoryGame joinId={selectedGame} onBack={() => setSelectedGame(undefined)} /> : <section className="history-panel home-history-panel"><HistoryList onSelectGame={setSelectedGame} /></section>}
    </section>
  </div>;
}
