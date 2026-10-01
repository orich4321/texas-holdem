'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AvatarPicker } from '../avatar-picker';
import { loadAccount, googleLoginPath, SERVER_URL, type AccountState } from '../account-api';
import { AppBrand } from '../ui';

function destination(): string {
  if (typeof window === 'undefined') return '/';
  const next = new URLSearchParams(window.location.search).get('next');
  return next && (/^\/$/.test(next) || /^\/enter-room$/.test(next) || /^\/r\/[a-f0-9]{16}(?:\/host)?$/i.test(next)) ? next : '/';
}

export default function ProfilePage() {
  const [account, setAccount] = useState<AccountState>();
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [next, setNext] = useState('/');

  useEffect(() => {
    setNext(destination());
    void loadAccount().then((state) => {
      setAccount(state);
      setName(state.profile?.displayName ?? '');
      setAvatar(state.profile?.avatarDataUrl ?? undefined);
    }).catch(() => setMessage('לא הצלחנו לטעון את הפרופיל. נסו לרענן את הדף.'));
  }, []);

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
      globalThis.location.assign(next);
    } catch {
      setMessage('לא הצלחנו לשמור את הפרופיל. נסו שוב.');
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await globalThis.fetch(`${SERVER_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
      globalThis.location.assign('/');
    } catch {
      setMessage('לא הצלחנו להתנתק. נסו שוב.');
      setBusy(false);
    }
  }

  return <main className="entry-shell profile-shell">
    <div className="app-aurora" aria-hidden="true" />
    <header className="entry-topbar"><Link href="/"><AppBrand compact /></Link><span>הפרופיל שלי</span></header>
    <section className="entry-stage"><div className="entry-panel profile-panel">
      <div className="entry-intro"><p>החשבון שלכם</p><h1>פרופיל שחקן</h1><span>השם והתמונה האלה ילוו אתכם בכל שולחן חדש.</span></div>
      {!account && !message ? <p role="status">טוענים פרופיל…</p> : null}
      {account?.enabled && !account.profile ? <a className="entry-primary" href={googleLoginPath(next)}>התחברות עם Google</a> : null}
      {account?.enabled && account.profile ? <form className="entry-form" onSubmit={save}>
        <label htmlFor="profile-name">שם השחקן שלכם</label>
        <input id="profile-name" value={name} maxLength={24} autoComplete="nickname" onChange={(event) => setName(event.target.value)} disabled={busy} required />
        <AvatarPicker value={avatar} onChange={setAvatar} disabled={busy} />
        <button className="entry-primary" type="submit" disabled={busy || !name.trim()}>{busy ? 'שומרים…' : account.profile.displayName ? 'שמירת שינויים' : 'שמירה והמשך'}</button>
        <button className="profile-sign-out" type="button" onClick={() => void signOut()} disabled={busy}>התנתקות מהחשבון</button>
      </form> : null}
      {account && !account.enabled ? <p>התחברות Google עדיין אינה מוגדרת באתר.</p> : null}
      {message ? <p className="entry-status" role="alert">{message}</p> : null}
    </div></section>
  </main>;
}
