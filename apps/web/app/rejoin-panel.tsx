'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { googleLoginPath, SERVER_URL } from './account-api';
import { StateScreen } from './ui';

type RejoinState = { status: 'removed' | 'joined' | 'closed'; pending: boolean };

export function RejoinPanel({ joinId, networkActive }: { joinId: string; networkActive: boolean }) {
  const [state, setState] = useState<RejoinState>();
  const [busy, setBusy] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!networkActive) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/rejoin`, { credentials: 'include', cache: 'no-store', signal: controller.signal });
        if (response.status === 401) { setNeedsLogin(true); return; }
        if (!response.ok) throw new Error();
        const next = await response.json() as RejoinState;
        if (controller.signal.aborted) return;
        setState(next);
        setError('');
        if (next.status === 'joined') { globalThis.location.reload(); return; }
        if (next.status === 'closed') return;
      } catch { if (!controller.signal.aborted) setError('לא הצלחנו לבדוק את אישור המארח. ננסה שוב.'); }
      // Only a tiny membership record is read; never a snapshot or avatar.
      if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 10_000);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [joinId, networkActive]);

  async function requestReturn() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/rejoin`, { method: 'POST', credentials: 'include' });
      if (!response.ok) throw new Error();
      setState({ status: 'removed', pending: true });
    } catch { setError('לא הצלחנו לשלוח את הבקשה. נסו שוב.'); }
    finally { setBusy(false); }
  }

  return <StateScreen icon="♠" title={state?.status === 'closed' ? 'המשחק הסתיים' : 'חוזרים לשולחן'}>
    {needsLogin ? <><p>התחברו עם אותו חשבון שבו שיחקתם כדי לבקש לחזור.</p><a className="entry-primary" href={googleLoginPath(`/r/${joinId}`)}>התחברות עם Google</a></>
      : state?.status === 'closed' ? <p>אפשר לצפות במשחק בהיסטוריית המשחקים שלכם.</p>
        : <><p>{state?.pending ? 'הבקשה נשלחה למארח. לאחר האישור תחזרו אוטומטית עם אותו שחקן ואותה יתרת צ׳יפים, ותשתתפו מהיד הבאה.' : 'יצאתם מהשולחן. אפשר לבקש מהמארח לחזור עם אותו שחקן והיסטוריית המשחק שלכם.'}</p>
          <button type="button" className="entry-primary" disabled={!state || busy || state.pending} onClick={() => void requestReturn()}>{busy ? 'שולחים…' : state?.pending ? 'ממתינים לאישור המארח' : 'בקשת חזרה למשחק'}</button></>}
    {error ? <p role="alert">{error}</p> : null}
    <p><Link href="/">חזרה למסך הבית</Link></p>
  </StateScreen>;
}
