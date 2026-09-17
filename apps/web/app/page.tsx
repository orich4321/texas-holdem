'use client';

import { type FormEvent, useState } from 'react';
import { DEFAULT_ROOM_SETTINGS, EMPTY_NICKNAME_MESSAGE, submitRoomCreation, type RoomSettings } from './room-creation';
import { AppBrand, IconBadge } from './ui';

export default function HomePage() {
  const [nickname, setNickname] = useState('');
  const [settings, setSettings] = useState<RoomSettings>(DEFAULT_ROOM_SETTINGS);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string>();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setStatus(undefined);
    if (!nickname.trim()) {
      setStatus(EMPTY_NICKNAME_MESSAGE);
      return;
    }
    if (!Number.isSafeInteger(settings.initialStack) || settings.initialStack < 100 || !Number.isSafeInteger(settings.smallBlind) || !Number.isSafeInteger(settings.bigBlind) || settings.smallBlind < 1 || settings.bigBlind <= settings.smallBlind || settings.initialStack < settings.bigBlind) {
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
    }, settings);

    if (!result.ok) setStatus(result.message);
    setPending(false);
  }

  return (
    <main className="home-shell">
      <div className="app-aurora" aria-hidden="true" />
      <header className="home-topbar"><AppBrand compact /><span>שולחן פרטי · הזמנה בלבד</span></header>

      <section className="home-layout" aria-labelledby="home-title">
        <div className="home-hero">
          <div className="hero-cards" aria-hidden="true"><span>A<small>♠</small></span><span>K<small>♥</small></span></div>
          <p className="eyebrow">הערב שלכם. השולחן שלכם.</p>
          <h1 id="home-title">פוקר עם חברים,<br /><em>כמו שצריך.</em></h1>
          <p className="invitation">פותחים שולחן פרטי, שולחים קישור ומתחילים לשחק — בלי הורדות ובלי הרשמה.</p>
          <div className="home-benefits" aria-label="יתרונות השולחן">
            <span><IconBadge>♟</IconBadge> עד 9 שחקנים</span>
            <span><IconBadge>⚡</IconBadge> משחק בזמן אמת</span>
            <span><IconBadge>⌁</IconBadge> חוזרים בדיוק לאותה יד</span>
          </div>
        </div>

        <div className="home-card">
          <div className="home-card-heading"><span>01</span><div><p>פתיחת שולחן</p><small>הגדירו את המשחק והזמינו חברים</small></div></div>

        <form className="host-form" onSubmit={handleSubmit}>
          <label htmlFor="nickname">כינוי בשולחן</label>
          <input
            id="nickname"
            name="nickname"
            type="text"
            autoComplete="nickname"
            maxLength={24}
            placeholder="איך לקרוא לך?"
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            disabled={pending}
            aria-describedby={status ? 'host-status' : undefined}
          />
          <fieldset className="game-settings" disabled={pending}>
            <legend>מבנה המשחק</legend>
            <label>צ׳יפים לכל שחקן<input inputMode="numeric" type="number" min="100" max="1000000" value={settings.initialStack} onChange={(event) => setSettings((current) => ({ ...current, initialStack: Number(event.target.value) }))} /></label>
            <div className="game-settings-row">
              <label>סמול בליינד<input inputMode="numeric" type="number" min="1" max="100000" value={settings.smallBlind} onChange={(event) => setSettings((current) => ({ ...current, smallBlind: Number(event.target.value) }))} /></label>
              <label>ביג בליינד<input inputMode="numeric" type="number" min="2" max="100000" value={settings.bigBlind} onChange={(event) => setSettings((current) => ({ ...current, bigBlind: Number(event.target.value) }))} /></label>
            </div>
            <small>כל מי שמצטרף מקבל את אותה ערימת פתיחה.</small>
          </fieldset>
          <button type="submit" disabled={pending}>
            <span aria-hidden="true">♠</span>{pending ? 'פותחים שולחן…' : 'פתחו שולחן פרטי'}
          </button>
          {status ? (
            <p id="host-status" className="host-status" role="status" aria-live="polite">
              {status}
            </p>
          ) : null}
        </form>

          <p className="share-note"><span aria-hidden="true">◆</span> המארח יקבל קישור אישי לשיתוף עם כולם</p>
        </div>
      </section>

      <footer><span>© HOLD&apos;EM PRIVATE TABLE</span><span>משחק ביתי. אווירה של שולחן אמיתי.</span></footer>
    </main>
  );
}
