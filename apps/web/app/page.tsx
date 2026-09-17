'use client';

import { type FormEvent, useState } from 'react';
import { DEFAULT_ROOM_SETTINGS, EMPTY_NICKNAME_MESSAGE, submitRoomCreation, type RoomSettings } from './room-creation';

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
      <div className="ambient ambient-top" aria-hidden="true" />
      <div className="ambient ambient-bottom" aria-hidden="true" />

      <section className="home-card" aria-labelledby="home-title">
        <div className="brand-mark" aria-hidden="true">
          <span className="brand-card brand-card-back">K</span>
          <span className="brand-card brand-card-front">A</span>
        </div>

        <p className="eyebrow">השולחן הפרטי שלכם</p>
        <h1 id="home-title">הולדם חברים</h1>
        <p className="invitation">
          ערב פוקר מתחיל כאן. בוחרים כינוי, פותחים שולחן ומזמינים את החבר׳ה.
        </p>

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
            <legend>הגדרות השולחן</legend>
            <label>צ׳יפים לכל שחקן<input inputMode="numeric" type="number" min="100" max="1000000" value={settings.initialStack} onChange={(event) => setSettings((current) => ({ ...current, initialStack: Number(event.target.value) }))} /></label>
            <div className="game-settings-row">
              <label>סמול בליינד<input inputMode="numeric" type="number" min="1" max="100000" value={settings.smallBlind} onChange={(event) => setSettings((current) => ({ ...current, smallBlind: Number(event.target.value) }))} /></label>
              <label>ביג בליינד<input inputMode="numeric" type="number" min="2" max="100000" value={settings.bigBlind} onChange={(event) => setSettings((current) => ({ ...current, bigBlind: Number(event.target.value) }))} /></label>
            </div>
            <small>כל מי שמצטרף מקבל את אותה ערימת פתיחה. השולחן מוכן לעד תשעה שחקנים.</small>
          </fieldset>
          <button type="submit" disabled={pending}>
            {pending ? 'פותחים חדר…' : 'פתח חדר'}
          </button>
          {status ? (
            <p id="host-status" className="host-status" role="status" aria-live="polite">
              {status}
            </p>
          ) : null}
        </form>

        <p className="share-note">
          <span aria-hidden="true">↗</span>
          המארח יקבל קישור אישי לשיתוף עם כולם
        </p>
      </section>

      <footer>משחק ביתי. אווירה של שולחן אמיתי.</footer>
    </main>
  );
}
