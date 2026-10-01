'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { DEFAULT_ROOM_SETTINGS, EMPTY_NICKNAME_MESSAGE, submitRoomCreation, type RoomSettings } from './room-creation';
import { parsePositiveInteger } from './numeric-input';
import { AppBrand } from './ui';
import { AvatarPicker } from './avatar-picker';
import { googleLoginPath, loadAccount, profilePath, type AccountState } from './account-api';
import { ProfileImage } from './profile-image';

export default function HomePage() {
  const [nickname, setNickname] = useState('');
  const [avatarDataUrl, setAvatarDataUrl] = useState<string>();
  const [settings, setSettings] = useState({
    initialStack: String(DEFAULT_ROOM_SETTINGS.initialStack),
    smallBlind: String(DEFAULT_ROOM_SETTINGS.smallBlind),
    bigBlind: String(DEFAULT_ROOM_SETTINGS.bigBlind),
  });
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string>();
  const [account, setAccount] = useState<AccountState>();
  useEffect(() => {
    if (new URLSearchParams(globalThis.location.search).has('auth_error')) setStatus('ההתחברות עם Google לא הושלמה. נסו שוב.');
    void loadAccount().then((state) => {
      setAccount(state);
      if (state.profile?.displayName) setNickname(state.profile.displayName);
      if (state.profile?.avatarDataUrl) setAvatarDataUrl(state.profile.avatarDataUrl);
    }).catch(() => setStatus('לא הצלחנו לבדוק את החשבון. נסו לרענן את הדף.'));
  }, []);
  const initialStack = parsePositiveInteger(settings.initialStack);
  const smallBlind = parsePositiveInteger(settings.smallBlind);
  const bigBlind = parsePositiveInteger(settings.bigBlind);
  const validSettings: RoomSettings | undefined = initialStack !== undefined && initialStack >= 100 && initialStack <= 1_000_000
    && smallBlind !== undefined && smallBlind <= 100_000
    && bigBlind !== undefined && bigBlind <= 100_000 && bigBlind > smallBlind && initialStack >= bigBlind
    ? { initialStack, smallBlind, bigBlind, maxPlayers: DEFAULT_ROOM_SETTINGS.maxPlayers }
    : undefined;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setStatus(undefined);
    if (!nickname.trim()) {
      setStatus(EMPTY_NICKNAME_MESSAGE);
      return;
    }
    if (!validSettings) {
      setStatus('בדקו את ערימת הפתיחה ואת גובה הבליינדים.');
      return;
    }

    setPending(true);
    const result = await submitRoomCreation(nickname, {
      // Keep the browser's fetch receiver intact. Passing globalThis.fetch
      // directly lets the boundary invoke it with its own `this` value, which
      // Chromium rejects before any network request is made.
      fetch: (...args) => globalThis.fetch(...args),
      navigate: (destination) => globalThis.location.assign(destination),
    }, validSettings, avatarDataUrl);

    if (!result.ok) setStatus(result.message);
    setPending(false);
  }

  return (
    <main className="entry-shell home-shell">
      <div className="app-aurora" aria-hidden="true" />
      <header className="entry-topbar"><AppBrand compact /><span>יצירת שולחן</span></header>

      <section className="entry-stage">
        <div className="entry-panel home-entry-panel" aria-labelledby="home-title">
          <span className="entry-suit" aria-hidden="true">♠</span>
          <div className="entry-intro">
            <p>שולחן חדש</p>
            <h1 id="home-title">פותחים משחק</h1>
            <span>{account?.enabled ? 'פותחים שולחן עם פרופיל השחקן שלכם. את הקישור לחברים תקבלו מיד.' : 'בחרו שם ותמונה. את הקישור לחברים תקבלו מיד.'}</span>
          </div>

          {account?.enabled && !account.profile ? <a className="entry-primary" href={googleLoginPath('/')}>התחברות עם Google</a> : null}
          {account?.enabled && account.profile && !account.profile.displayName ? <a className="entry-primary" href={profilePath('/')}>השלמת פרופיל השחקן</a> : null}
          {!account && !status ? <p role="status">בודקים את החשבון…</p> : null}
          {account && (!account.enabled || account.profile?.displayName) ? <form className="entry-form host-form" onSubmit={handleSubmit}>
            {account?.enabled && account.profile?.displayName ? <a className="entry-account" href={profilePath('/')}><ProfileImage className="entry-account-avatar" dataUrl={account.profile.avatarDataUrl} fallback="♠" /><span>{account.profile.displayName}</span><small>עריכת פרופיל ⚙</small></a> : <>
              <label htmlFor="nickname">השם שלכם בשולחן</label>
              <input id="nickname" name="nickname" type="text" autoComplete="nickname" maxLength={24} placeholder="למשל: אורי" value={nickname} onChange={(event) => setNickname(event.target.value)} disabled={pending} aria-describedby={status ? 'host-status' : undefined} />
              <AvatarPicker value={avatarDataUrl} onChange={setAvatarDataUrl} disabled={pending} />
            </>}

            <details className="entry-settings">
              <summary><span>הגדרות המשחק</span><small>{settings.initialStack || '—'} צ׳יפים · {settings.smallBlind || '—'}/{settings.bigBlind || '—'}</small></summary>
              <div className="entry-settings-fields">
                <label>צ׳יפים<input inputMode="numeric" type="number" min="100" max="1000000" value={settings.initialStack} onChange={(event) => setSettings((current) => ({ ...current, initialStack: event.target.value }))} disabled={pending} /></label>
                <label>סמול בליינד<input inputMode="numeric" type="number" min="1" max="100000" value={settings.smallBlind} onChange={(event) => setSettings((current) => ({ ...current, smallBlind: event.target.value }))} disabled={pending} /></label>
                <label>ביג בליינד<input inputMode="numeric" type="number" min="2" max="100000" value={settings.bigBlind} onChange={(event) => setSettings((current) => ({ ...current, bigBlind: event.target.value }))} disabled={pending} /></label>
              </div>
            </details>

            <button className="entry-primary" type="submit" disabled={pending || !validSettings}>{pending ? 'פותחים…' : 'פתיחת שולחן'}</button>
            {status ? <p id="host-status" className="entry-status" role="status" aria-live="polite">{status}</p> : null}
          </form> : null}
          <a className="entry-secondary-link" href="/enter-room">יש לכם קוד חדר? היכנסו למשחק</a>
        </div>
      </section>
    </main>
  );
}
