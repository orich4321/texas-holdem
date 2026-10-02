'use client';

import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { DEFAULT_ROOM_SETTINGS, EMPTY_NICKNAME_MESSAGE, submitRoomCreation, type RoomSettings } from './room-creation';
import { parsePositiveInteger } from './numeric-input';
import { AppBrand } from './ui';
import { AvatarPicker } from './avatar-picker';
import { googleLoginPath, loadAccount, profilePath, type AccountState } from './account-api';
import { ProfileImage } from './profile-image';
import { HomeAccountPanel } from './home-account-panel';
import { deleteGamePreset, loadGamePresets, saveGamePreset, type GamePreset } from './game-presets';
import { answerGameInvite, loadInvitations, loadSocial, type SocialOverview } from './social-api';
import { usePageActivity } from './use-page-activity';
import { HomeActiveGames } from './home-active-games';

export default function HomePage() {
  const activity = usePageActivity();
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
  const [accountPanelOpen, setAccountPanelOpen] = useState(false);
  const [presets, setPresets] = useState<GamePreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [presetName, setPresetName] = useState('');
  const [presetBusy, setPresetBusy] = useState(false);
  const [presetStatus, setPresetStatus] = useState('');
  const [social, setSocial] = useState<SocialOverview>();
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteStatus, setInviteStatus] = useState('');
  const [pendingFriendRequests, setPendingFriendRequests] = useState(0);
  useEffect(() => {
    if (new URLSearchParams(globalThis.location.search).has('auth_error')) setStatus('ההתחברות עם Google לא הושלמה. נסו שוב.');
    void loadAccount().then((state) => {
      setAccount(state);
      if (state.profile?.displayName) setNickname(state.profile.displayName);
      if (state.profile?.avatarDataUrl) setAvatarDataUrl(state.profile.avatarDataUrl);
    }).catch(() => setStatus('לא הצלחנו לבדוק את החשבון. נסו לרענן את הדף.'));
  }, []);
  useEffect(() => {
    if (!account?.profile?.id) return;
    let active = true;
    void loadGamePresets().then((saved) => {
      if (active) setPresets(saved);
    }).catch(() => { if (active) setPresetStatus('לא הצלחנו לטעון תבניות שמורות.'); });
    return () => { active = false; };
  }, [account?.profile?.id]);
  const refreshSocial = useCallback(async () => {
    const overview = await loadSocial();
    setSocial(overview);
    setPendingFriendRequests(overview.incoming.length);
  }, []);
  useEffect(() => {
    if (!account?.profile?.id || !activity.networkActive) return;
    let active = true;
    void loadInvitations().then(({ invitations, pendingFriendRequests: count }) => {
      if (active) { setSocial((current) => current ? { ...current, invitations } : { friends: [], incoming: [], outgoing: [], invitations }); setPendingFriendRequests(count); }
    }).catch(() => { if (active) setInviteStatus('לא הצלחנו לטעון הזמנות. נסו לרענן את הדף.'); });
    const timer = globalThis.setInterval(() => {
      if (document.visibilityState === 'visible') void loadInvitations().then(({ invitations, pendingFriendRequests: count }) => {
        setSocial((current) => current ? { ...current, invitations } : current);
        setPendingFriendRequests(count);
      }).catch(() => {});
    }, 20_000);
    return () => { active = false; globalThis.clearInterval(timer); };
  }, [account?.profile?.id, activity.networkActive, refreshSocial]);

  async function respondToInvite(id: string, accept: boolean) {
    if (inviteBusy) return;
    setInviteBusy(true);
    setInviteStatus('');
    try {
      const path = await answerGameInvite(id, accept);
      if (accept && path) { globalThis.location.assign(path); return; }
      await refreshSocial();
    } catch { setInviteStatus('לא הצלחנו לעדכן את ההזמנה. נסו שוב.'); }
    finally { setInviteBusy(false); }
  }
  const initialStack = parsePositiveInteger(settings.initialStack);
  const smallBlind = parsePositiveInteger(settings.smallBlind);
  const bigBlind = parsePositiveInteger(settings.bigBlind);
  const validSettings: RoomSettings | undefined = initialStack !== undefined && initialStack >= 100 && initialStack <= 1_000_000
    && smallBlind !== undefined && smallBlind <= 100_000
    && bigBlind !== undefined && bigBlind <= 100_000 && bigBlind > smallBlind && initialStack >= bigBlind
    ? { initialStack, smallBlind, bigBlind, maxPlayers: DEFAULT_ROOM_SETTINGS.maxPlayers }
    : undefined;

  function selectPreset(id: string) {
    setSelectedPresetId(id);
    const preset = presets.find((candidate) => candidate.id === id);
    if (!preset) return;
    setSettings({ initialStack: String(preset.initialStack), smallBlind: String(preset.smallBlind), bigBlind: String(preset.bigBlind) });
    setPresetName(preset.name);
    setPresetStatus(`נטענה התבנית ״${preset.name}״. אפשר לערוך לפני פתיחת החדר.`);
  }

  async function savePreset() {
    if (!validSettings || !presetName.trim() || presetBusy) return;
    setPresetBusy(true);
    try {
      const saved = await saveGamePreset(presetName.trim(), validSettings.initialStack, validSettings.smallBlind, validSettings.bigBlind);
      setPresets((current) => [saved, ...current.filter((preset) => preset.id !== saved.id)]);
      setSelectedPresetId(saved.id);
      setPresetStatus(`התבנית ״${saved.name}״ נשמרה בחשבון שלכם.`);
    } catch (error) {
      setPresetStatus(error instanceof Error && error.message === 'LIMIT' ? 'אפשר לשמור עד שמונה תבניות. מחקו תבנית כדי לפנות מקום.' : 'לא הצלחנו לשמור את התבנית. נסו שוב.');
    } finally { setPresetBusy(false); }
  }

  async function removePreset() {
    const preset = presets.find((candidate) => candidate.id === selectedPresetId);
    if (!preset || presetBusy || !globalThis.confirm(`למחוק את התבנית ״${preset.name}״?`)) return;
    setPresetBusy(true);
    try {
      await deleteGamePreset(preset.id);
      setPresets((current) => current.filter((candidate) => candidate.id !== preset.id));
      setSelectedPresetId('');
      setPresetName('');
      setPresetStatus('התבנית נמחקה.');
    } catch { setPresetStatus('לא הצלחנו למחוק את התבנית. נסו שוב.'); }
    finally { setPresetBusy(false); }
  }

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
      {social?.invitations.length ? <aside className="home-invites" aria-label="הזמנות למשחק" aria-live="polite">
        {social.invitations.map((invite) => <div className="home-invite-banner" key={invite.id}>
          <ProfileImage className="social-avatar" dataUrl={invite.from.avatarDataUrl} fallback="♠" />
          <span><strong>{invite.from.displayName ?? invite.from.username} מזמין/ה אתכם לשחק</strong><small>חדר {invite.joinId.slice(0, 6).toUpperCase()}</small></span>
          <button type="button" disabled={inviteBusy} onClick={() => void respondToInvite(invite.id, true)}>אישור</button>
          <button type="button" disabled={inviteBusy} onClick={() => void respondToInvite(invite.id, false)}>סירוב</button>
        </div>)}
        {inviteStatus ? <p role="status">{inviteStatus}</p> : null}
      </aside> : null}

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
          {account?.enabled && account.profile?.displayName ? <button type="button" className="entry-account" onClick={() => setAccountPanelOpen(true)} aria-label="פתיחת הפרופיל, החברים והיסטוריית המשחקים"><ProfileImage className="entry-account-avatar" dataUrl={account.profile.avatarDataUrl} fallback="♠" /><span>{account.profile.displayName}</span><small>{pendingFriendRequests ? `${pendingFriendRequests} בקשות חברות · ` : ''}פרופיל וחברים ⚙</small></button> : null}
          {account?.profile?.id ? <HomeActiveGames accountId={account.profile.id} networkActive={activity.networkActive} /> : null}
          {account && (!account.enabled || account.profile?.displayName) ? <form className="entry-form host-form" onSubmit={handleSubmit}>
            {account?.enabled && account.profile?.displayName ? null : <>
              <label htmlFor="nickname">השם שלכם בשולחן</label>
              <input id="nickname" name="nickname" type="text" autoComplete="nickname" maxLength={24} placeholder="למשל: אורי" value={nickname} onChange={(event) => setNickname(event.target.value)} disabled={pending} aria-describedby={status ? 'host-status' : undefined} />
              <AvatarPicker value={avatarDataUrl} onChange={setAvatarDataUrl} disabled={pending} />
            </>}

            <details className="entry-settings">
              <summary><span>הגדרות המשחק</span><small>{settings.initialStack || '—'} צ׳יפים · {settings.smallBlind || '—'}/{settings.bigBlind || '—'}</small></summary>
              {account?.profile?.id ? <div className="entry-presets">
                <label htmlFor="saved-game-preset">תבניות שמורות</label>
                <div className="entry-preset-picker">
                  <select id="saved-game-preset" value={selectedPresetId} onChange={(event) => selectPreset(event.target.value)} disabled={pending || presetBusy}>
                    <option value="">בחירת תבנית</option>
                    {presets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name} · {preset.initialStack} · {preset.smallBlind}/{preset.bigBlind}</option>)}
                  </select>
                  <button type="button" disabled={!selectedPresetId || pending || presetBusy} onClick={() => void removePreset()} aria-label="מחיקת התבנית שנבחרה">מחיקה</button>
                </div>
                <div className="entry-preset-save">
                  <input aria-label="שם התבנית" placeholder="שם התבנית, למשל משחק קצר" maxLength={24} value={presetName} onChange={(event) => setPresetName(event.target.value)} disabled={pending || presetBusy} />
                  <button type="button" disabled={!validSettings || !presetName.trim() || pending || presetBusy} onClick={() => void savePreset()}>{presetBusy ? 'שומרים…' : 'שמירת הגדרות'}</button>
                </div>
                {presetStatus ? <p role="status" aria-live="polite">{presetStatus}</p> : null}
              </div> : null}
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
      {accountPanelOpen && account?.profile ? <HomeAccountPanel account={account} social={social} onSocialChange={refreshSocial} onClose={() => setAccountPanelOpen(false)} onAccountChange={(updated) => { setAccount(updated); setNickname(updated.profile?.displayName ?? ''); setAvatarDataUrl(updated.profile?.avatarDataUrl ?? undefined); }} /> : null}
    </main>
  );
}
