declare const process: { env: { NODE_ENV?: string; NEXT_PUBLIC_GAME_URL?: string; NEXT_PUBLIC_SERVER_URL?: string } };

export type RoomSettings = Readonly<{ initialStack: number; smallBlind: number; bigBlind: number; maxPlayers: number }>;
export const DEFAULT_ROOM_SETTINGS: RoomSettings = Object.freeze({ initialStack: 500, smallBlind: 1, bigBlind: 2, maxPlayers: 9 });
// The public Vercel app routes the game service through `/server`. Keeping
// production requests same-origin is essential on iPhone/Safari: cross-site
// cookies can be blocked, making a newly created host look like a guest.
const SERVER_URL = process.env.NODE_ENV === 'production'
  ? '/server'
  : process.env.NEXT_PUBLIC_SERVER_URL ?? process.env.NEXT_PUBLIC_GAME_URL ?? 'http://localhost:3001';

export const EMPTY_NICKNAME_MESSAGE = 'צריך להזין כינוי כדי לפתוח חדר.';
export const CREATION_ERROR_MESSAGE = 'לא הצלחנו לפתוח את החדר. נסו שוב.';

type RoomCreationResponse = {
  status: number;
  json: () => Promise<unknown>;
};

type RoomCreationBoundaries = {
  fetch: (input: string, init: RequestInit) => Promise<RoomCreationResponse>;
  navigate: (destination: string) => void;
};

type RoomCreationResult =
  | { ok: true }
  | { ok: false; message: string };

function hasMatchingHostRoom(payload: unknown): payload is { roomId: string; hostPath: string; invitePath: string } {
  if (payload === null || typeof payload !== 'object') return false;

  const { roomId, hostPath, invitePath } = payload as Record<string, unknown>;
  return typeof roomId === 'string'
    && typeof hostPath === 'string'
    && typeof invitePath === 'string'
    && hostPath === `/r/${roomId}/host`
    && invitePath === `/r/${roomId}`;
}

export async function submitRoomCreation(
  nickname: string,
  boundaries: RoomCreationBoundaries,
  settings: RoomSettings = DEFAULT_ROOM_SETTINGS,
  avatarDataUrl?: string,
): Promise<RoomCreationResult> {
  const displayName = nickname.trim();
  if (!displayName) return { ok: false, message: EMPTY_NICKNAME_MESSAGE };

  try {
    const response = await boundaries.fetch(`${SERVER_URL}/rooms`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName, ...settings, ...(avatarDataUrl ? { avatarDataUrl } : {}) }),
    });
    if (response.status !== 201) return { ok: false, message: CREATION_ERROR_MESSAGE };

    const payload = await response.json();
    if (!hasMatchingHostRoom(payload)) return { ok: false, message: CREATION_ERROR_MESSAGE };

    boundaries.navigate(payload.hostPath);
    return { ok: true };
  } catch {
    return { ok: false, message: CREATION_ERROR_MESSAGE };
  }
}
