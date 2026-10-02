'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { googleLoginPath, SERVER_URL } from '../account-api';

type Game = { joinId: string; status: string; createdAt: string; handCount: number; yourNet: number };

export function HistoryList({ onSelectGame }: { onSelectGame?: (joinId: string) => void }) {
  const [games, setGames] = useState<Game[]>();
  const [error, setError] = useState<string>();
  const [signInRequired, setSignInRequired] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void globalThis.fetch(`${SERVER_URL}/auth/history`, { credentials: 'include', cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) { setSignInRequired(true); return; }
        if (!response.ok) throw new Error('History unavailable');
        setGames((await response.json() as { games: Game[] }).games);
      }).catch(() => { if (!controller.signal.aborted) setError('לא הצלחנו לטעון את היסטוריית המשחקים.'); });
    return () => controller.abort();
  }, []);

  return <>
    <div className="history-heading"><span>הארכיון שלי</span><h1>היסטוריית המשחקים</h1><p>קלפים שלא נחשפו במשחק נשארים מוסתרים גם כאן.</p></div>
    {error ? <p role="alert">{error}</p> : null}
    {signInRequired ? <a className="entry-primary" href={googleLoginPath('/history')}>התחברות עם Google לצפייה בהיסטוריה</a> : null}
    {!games && !error && !signInRequired ? <p role="status">טוענים משחקים…</p> : null}
    {games?.length === 0 ? <p>עדיין אין משחקים בחשבון הזה.</p> : null}
    <div className="history-list">{games?.map((game) => {
      const label = <><span><b>{new Date(game.createdAt).toLocaleDateString('he-IL')}</b><small>{game.handCount} ידיים · {game.status === 'COMPLETED' ? 'הסתיים' : game.status === 'IN_PROGRESS' ? 'משחק פעיל' : game.status === 'CANCELLED' ? 'בוטל' : 'ממתין'}</small></span><strong className={game.yourNet >= 0 ? 'history-positive' : 'history-negative'} dir="ltr">{game.yourNet >= 0 ? '+' : ''}{game.yourNet.toLocaleString('he-IL')} צ׳יפים</strong><span aria-hidden="true">←</span></>;
      return onSelectGame ? <button type="button" className="history-game" onClick={() => onSelectGame(game.joinId)} key={game.joinId}>{label}</button>
        : <Link className="history-game" href={`/history/${encodeURIComponent(game.joinId)}`} key={game.joinId}>{label}</Link>;
    })}</div>
  </>;
}
