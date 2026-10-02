'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { SERVER_URL } from './account-api';

type ActiveGame = {
  joinId: string;
  status: 'WAITING' | 'IN_PROGRESS';
  handCount: number;
  isHost: boolean;
};

export function HomeActiveGames({ accountId, networkActive }: { accountId: string; networkActive: boolean }) {
  const [games, setGames] = useState<ActiveGame[]>();
  const [error, setError] = useState(false);
  const [confirmCloseGame, setConfirmCloseGame] = useState<ActiveGame>();
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState('');
  const [finishedJoinId, setFinishedJoinId] = useState('');
  const lastLoadedAt = useRef(0);

  useEffect(() => {
    if (!networkActive) return;
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading || Date.now() - lastLoadedAt.current < 30_000) return;
      loading = true;
      try {
        const response = await globalThis.fetch(`${SERVER_URL}/auth/active-games`, {
          credentials: 'include', cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error('Active games unavailable');
        const result = await response.json() as { games: ActiveGame[] };
        if (!Array.isArray(result.games)) throw new Error('Invalid active games');
        if (!controller.signal.aborted) { setGames(result.games); setError(false); lastLoadedAt.current = Date.now(); }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally { loading = false; }
    };
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') void load(); };
    void load();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => { controller.abort(); document.removeEventListener('visibilitychange', onVisibilityChange); };
  }, [accountId, networkActive]);

  async function finishGame() {
    if (!confirmCloseGame || closing) return;
    setClosing(true);
    setCloseError('');
    try {
      const response = await globalThis.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(confirmCloseGame.joinId)}/game/finish`, {
        method: 'POST', credentials: 'include', cache: 'no-store',
      });
      if (!response.ok) {
        setCloseError(response.status === 409
          ? 'אפשר לסיים את המשחק רק אחרי שהיד הנוכחית הסתיימה. חזרו לשולחן ובדקו את תוצאת היד.'
          : 'לא הצלחנו לסיים את המשחק. ודאו שאתם המארחים ונסו שוב.');
        return;
      }
      setGames((current) => current?.filter((game) => game.joinId !== confirmCloseGame.joinId));
      setFinishedJoinId(confirmCloseGame.joinId);
      setConfirmCloseGame(undefined);
      lastLoadedAt.current = 0;
    } catch { setCloseError('החיבור נכשל. נסו שוב.'); }
    finally { setClosing(false); }
  }

  if (!games?.length && !error && !finishedJoinId) return null;

  return <section className="home-active-games" aria-labelledby="home-active-games-title">
    <div className="home-active-games-heading"><strong id="home-active-games-title">המשחקים הפעילים שלכם</strong><small>{games?.length ?? 0} חדרים</small></div>
    {error ? <p role="status">לא הצלחנו לטעון משחקים פעילים. נסו לרענן את הדף.</p> : null}
    {games?.length ? <div className="home-active-games-list">{games.map((game) => <div className="home-active-game" key={game.joinId}>
      <Link className="home-active-game-link" href={`/r/${encodeURIComponent(game.joinId)}${game.isHost ? '/host' : ''}`}>
        <span><strong>{game.status === 'WAITING' ? 'חדר ממתין' : 'משחק פעיל'}</strong><small>חדר <b dir="ltr">{game.joinId.toUpperCase()}</b> · {game.handCount} ידיים{game.isHost ? ' · מארח' : ''}</small></span>
        <b className="home-active-game-enter">חזרה לשולחן ←</b>
      </Link>
      {game.isHost && game.status === 'IN_PROGRESS' ? <button type="button" className="home-active-game-finish" onClick={() => { setCloseError(''); setConfirmCloseGame(game); }}>סיום משחק</button> : null}
    </div>)}</div> : null}
    {finishedJoinId ? <div className="home-finished-game" role="status"><strong>המשחק הסתיים.</strong><Link href={`/r/${encodeURIComponent(finishedJoinId)}/host`}>לסיכום המשחק</Link><a href={`${SERVER_URL}/rooms/${encodeURIComponent(finishedJoinId)}/final-summary/download`}>הורדת JSON</a></div> : null}
    {confirmCloseGame ? <div className="home-finish-backdrop"><div className="home-finish-dialog" role="alertdialog" aria-modal="true" aria-labelledby="home-finish-title" aria-describedby="home-finish-description">
      <h2 id="home-finish-title">סיום המשחק</h2>
      <p id="home-finish-description">המשחק יסתיים ללא יד נוספת. אפשר לעשות זאת רק אחרי שהיד הנוכחית הוכרעה. כל המשתתפים יוכלו לראות את הסיכום, ורק המארח יוכל להוריד את קובץ ה־JSON.</p>
      {closeError ? <p className="home-finish-error" role="alert">{closeError}</p> : null}
      <div><button type="button" disabled={closing} onClick={() => setConfirmCloseGame(undefined)}>ביטול</button><button type="button" className="home-finish-confirm" disabled={closing} onClick={() => void finishGame()}>{closing ? 'מסיימים…' : 'כן, סיימו את המשחק'}</button></div>
    </div></div> : null}
  </section>;
}
