declare const process: { env: { NODE_ENV?: string; NEXT_PUBLIC_GAME_URL?: string; NEXT_PUBLIC_SERVER_URL?: string } };

const SERVER_URL = process.env.NODE_ENV === 'production'
  ? '/server'
  : process.env.NEXT_PUBLIC_SERVER_URL ?? process.env.NEXT_PUBLIC_GAME_URL ?? 'http://localhost:3001';

export const EMPTY_NICKNAME_MESSAGE = 'צריך להזין כינוי כדי להצטרף.';
export const LOBBY_LOAD_ERROR_MESSAGE = 'לא הצלחנו לטעון את החדר. נסו שוב.';
export const LOBBY_JOIN_ERROR_MESSAGE = 'לא הצלחנו להצטרף לחדר. נסו שוב.';
export const ROOM_FULL_MESSAGE = 'השולחן כבר מלא. נסו חדר אחר.';
export const ROOM_NOT_JOINABLE_MESSAGE = 'המשחק בחדר הזה כבר הסתיים.';

export type Lobby = {
  joinId: string;
  status: 'WAITING' | 'IN_PROGRESS' | 'COMPLETED';
  isHost: boolean;
  isParticipant: boolean;
  canStart: boolean;
  settings: { initialStack: number; smallBlind: number; bigBlind: number; maxPlayers: number };
  host: { displayName: string; avatarDataUrl?: string | null };
  players: Array<{ displayName: string; avatarDataUrl?: string | null; initialStack: number; currentStack: number }>;
};

type ResponseBoundary = { status: number; json: () => Promise<unknown> };
type FetchBoundary = (input: string, init: RequestInit) => Promise<ResponseBoundary>;
type Boundaries = { fetch: FetchBoundary };
type Result<T> = { ok: true; lobby: T } | { ok: false; message: string };

function isPlayer(value: unknown): value is Lobby['players'][number] {
  if (value === null || typeof value !== 'object') return false;
  const player = value as Record<string, unknown>;
  return typeof player.displayName === 'string'
    && (player.avatarDataUrl === undefined || player.avatarDataUrl === null || typeof player.avatarDataUrl === 'string')
    && typeof player.initialStack === 'number' && isFinite(player.initialStack)
    && typeof player.currentStack === 'number' && isFinite(player.currentStack);
}

function isLobby(value: unknown, expectedJoinId: string): value is Lobby {
  if (value === null || typeof value !== 'object') return false;
  const lobby = value as Record<string, unknown>;
  return lobby.joinId === expectedJoinId
    && (lobby.status === 'WAITING' || lobby.status === 'IN_PROGRESS' || lobby.status === 'COMPLETED')
    && typeof lobby.isHost === 'boolean'
    && typeof lobby.isParticipant === 'boolean'
    && typeof lobby.canStart === 'boolean'
    && lobby.settings !== null && typeof lobby.settings === 'object'
    && ['initialStack', 'smallBlind', 'bigBlind', 'maxPlayers'].every((key) => typeof (lobby.settings as Record<string, unknown>)[key] === 'number')
    && lobby.host !== null
    && typeof lobby.host === 'object'
    && typeof (lobby.host as Record<string, unknown>).displayName === 'string'
    && ((lobby.host as Record<string, unknown>).avatarDataUrl === undefined || (lobby.host as Record<string, unknown>).avatarDataUrl === null || typeof (lobby.host as Record<string, unknown>).avatarDataUrl === 'string')
    && Array.isArray(lobby.players)
    && lobby.players.length <= 9
    && lobby.players.every(isPlayer);
}

export async function startLobbyGame(
  joinId: string,
  boundaries: Boundaries,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await boundaries.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/start`, {
      method: 'POST',
      credentials: 'include',
    });
    return response.status === 201
      ? { ok: true }
      : { ok: false, message: 'לא הצלחנו להתחיל את המשחק. נסו שוב.' };
  } catch {
    return { ok: false, message: 'לא הצלחנו להתחיל את המשחק. נסו שוב.' };
  }
}

export async function loadLobby(
  joinId: string,
  boundaries: Boundaries,
  signal?: AbortSignal,
): Promise<Result<Lobby>> {
  try {
    const response = await boundaries.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}`, {
      credentials: 'include',
      // The lobby is shared, mutable state. A cached room projection can hide
      // the second player from the host and therefore suppress the start
      // button after they join.
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 200) return { ok: false, message: LOBBY_LOAD_ERROR_MESSAGE };
    const lobby = await response.json();
    return isLobby(lobby, joinId)
      ? { ok: true, lobby }
      : { ok: false, message: LOBBY_LOAD_ERROR_MESSAGE };
  } catch {
    return { ok: false, message: LOBBY_LOAD_ERROR_MESSAGE };
  }
}

export async function joinLobby(
  joinId: string,
  nickname: string,
  boundaries: Boundaries,
  avatarDataUrl?: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const displayName = nickname.trim();
  if (!displayName) return { ok: false, message: EMPTY_NICKNAME_MESSAGE };

  try {
    const response = await boundaries.fetch(`${SERVER_URL}/rooms/${encodeURIComponent(joinId)}/join`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName, ...(avatarDataUrl ? { avatarDataUrl } : {}) }),
    });
    if (response.status === 201) return { ok: true };
    if (response.status === 409) {
      const body = await response.json().catch(() => undefined) as { error?: { code?: string } } | undefined;
      return { ok: false, message: body?.error?.code === 'ROOM_NOT_JOINABLE' ? ROOM_NOT_JOINABLE_MESSAGE : ROOM_FULL_MESSAGE };
    }
    return { ok: false, message: LOBBY_JOIN_ERROR_MESSAGE };
  } catch {
    return { ok: false, message: LOBBY_JOIN_ERROR_MESSAGE };
  }
}
