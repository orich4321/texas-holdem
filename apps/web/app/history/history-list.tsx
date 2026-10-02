'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { googleLoginPath, SERVER_URL } from '../account-api';

type Game = { joinId: string; status: string; createdAt: string; handCount: number; yourNet: number };

export function HistoryList({ onSelectGame }: { onSelectGame?: (joinId: string) => void }) {
  const [games, setGames] = useState<Game[]>();
  const [error, setError] = useState<string>();
  const [signInRequired, setSignInRequired] = useState(false);
  const [confirmGame, setConfirmGame] = useState<Game>();
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
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

  async function hideGame() {
    if (!confirmGame || deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/auth/history/${encodeURIComponent(confirmGame.joinId)}`, {
        method: 'DELETE', credentials: 'include', cache: 'no-store',
      });
      if (!response.ok) { setDeleteError('לא הצלחנו למחוק את המשחק מהארכיון. נסו שוב.'); return; }
      setGames((current) => current?.filter((game) => game.joinId !== confirmGame.joinId));
      setConfirmGame(undefined);
    } catch { setDeleteError('החיבור נכשל. נסו שוב.'); }
    finally { setDeleting(false); }
  }

  return <>
    <div className="history-heading"><span>הארכיון שלי</span><h1>היסטוריית המשחקים</h1><p>קלפים שלא נחשפו במשחק נשארים מוסתרים גם כאן.</p></div>
    {error ? <p role="alert">{error}</p> : null}
    {signInRequired ? <a className="entry-primary" href={googleLoginPath('/history')}>התחברות עם Google לצפייה בהיסטוריה</a> : null}
    {!games && !error && !signInRequired ? <p role="status">טוענים משחקים…</p> : null}
    {games?.length === 0 ? <p>עדיין אין משחקים בחשבון הזה.</p> : null}
    <div className="history-list">{games?.map((game) => {
      const label = <><span><b>{new Date(game.createdAt).toLocaleDateString('he-IL')}</b><small>{game.handCount} ידיים · {game.status === 'COMPLETED' ? 'הסתיים' : game.status === 'IN_PROGRESS' ? 'משחק פעיל' : game.status === 'CANCELLED' ? 'בוטל' : 'ממתין'}</small></span><strong className={game.yourNet >= 0 ? 'history-positive' : 'history-negative'} dir="ltr">{game.yourNet >= 0 ? '+' : ''}{game.yourNet.toLocaleString('he-IL')} צ׳יפים</strong><span aria-hidden="true">←</span></>;
      const gameLink = onSelectGame ? <button type="button" className="history-game" onClick={() => onSelectGame(game.joinId)}>{label}</button>
        : <Link className="history-game" href={`/history/${encodeURIComponent(game.joinId)}`}>{label}</Link>;
      return <div className="history-game-row" key={game.joinId}>{gameLink}<button type="button" className="history-delete" aria-label={`מחיקת המשחק מ${game.createdAt}`} onClick={() => { setDeleteError(''); setConfirmGame(game); }}>מחיקה</button></div>;
    })}</div>
    {confirmGame ? <div className="modal-backdrop" role="presentation"><section className="history-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="history-delete-title">
      <h2 id="history-delete-title">למחוק מההיסטוריה?</h2><p>המשחק יוסתר רק מהארכיון שלך. הוא לא יימחק לשאר המשתתפים ולא ישנה שום תוצאה.</p>
      {deleteError ? <p role="alert">{deleteError}</p> : null}
      <div><button type="button" disabled={deleting} onClick={() => setConfirmGame(undefined)}>ביטול</button><button type="button" className="history-delete-confirm" disabled={deleting} onClick={() => void hideGame()}>{deleting ? 'מוחקים…' : 'כן, למחוק מהארכיון'}</button></div>
    </section></div> : null}
  </>;
}
