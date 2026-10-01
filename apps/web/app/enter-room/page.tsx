'use client';

import { type FormEvent, useState } from 'react';
import Link from 'next/link';
import { AppBrand } from '../ui';
import { enterRoomWithCode } from './enter-room';

export default function EnterRoomPage() {
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string>();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setStatus(undefined);
    setPending(true);
    const result = await enterRoomWithCode(code, {
      fetch: (...args) => globalThis.fetch(...args),
      navigate: (destination) => globalThis.location.assign(destination),
    });
    if (!result.ok) setStatus(result.message);
    setPending(false);
  }

  return (
    <main className="entry-shell enter-room-shell">
      <div className="app-aurora" aria-hidden="true" />
      <header className="entry-topbar"><Link href="/" aria-label="חזרה לדף הראשי"><AppBrand compact /></Link><span>כניסה עם קוד</span></header>
      <section className="entry-stage">
        <div className="entry-panel enter-room-panel" aria-labelledby="enter-room-title">
          <span className="entry-suit" aria-hidden="true">♠</span>
          <div className="entry-intro">
            <p>הוזמנתם לשולחן?</p>
            <h1 id="enter-room-title">כניסה לחדר</h1>
            <span>בקשו מהמארח את קוד החדר. עם חשבון שחקן פעיל תצטרפו אוטומטית.</span>
          </div>
          <form className="entry-form enter-room-form" onSubmit={handleSubmit}>
            <label htmlFor="room-code">קוד החדר</label>
            <input id="room-code" name="room-code" type="text" inputMode="text" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={23} placeholder="לדוגמה: A1B2C3D4E5F60708" value={code} onChange={(event) => setCode(event.target.value)} disabled={pending} aria-describedby={status ? 'enter-room-status' : 'room-code-help'} dir="ltr" />
            <small id="room-code-help">16 תווים · אפשר להזין גם אותיות גדולות</small>
            <button className="entry-primary" type="submit" disabled={pending}>{pending ? 'מחפשים חדר…' : 'המשך לחדר'}</button>
            {status ? <p id="enter-room-status" className="entry-status" role="status" aria-live="polite">{status}</p> : null}
          </form>
          <Link className="entry-secondary-link" href="/">רוצים לפתוח שולחן משלכם?</Link>
        </div>
      </section>
    </main>
  );
}
