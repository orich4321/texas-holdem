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

  if (!games?.length && !error) return null;

  return <section className="home-active-games" aria-labelledby="home-active-games-title">
    <div className="home-active-games-heading"><strong id="home-active-games-title">המשחקים הפעילים שלכם</strong><small>{games?.length ?? 0} חדרים</small></div>
    {error ? <p role="status">לא הצלחנו לטעון משחקים פעילים. נסו לרענן את הדף.</p> : null}
    {games?.length ? <div className="home-active-games-list">{games.map((game) => <Link
      className="home-active-game"
      href={`/r/${encodeURIComponent(game.joinId)}${game.isHost ? '/host' : ''}`}
      key={game.joinId}
    >
      <span><strong>{game.status === 'WAITING' ? 'חדר ממתין' : 'משחק פעיל'}</strong><small>חדר <b dir="ltr">{game.joinId.toUpperCase()}</b> · {game.handCount} ידיים{game.isHost ? ' · מארח' : ''}</small></span>
      <b className="home-active-game-enter">חזרה לשולחן ←</b>
    </Link>)}</div> : null}
  </section>;
}
