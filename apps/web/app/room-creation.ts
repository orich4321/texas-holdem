declare const process: { env: { NEXT_PUBLIC_GAME_URL?: string; NEXT_PUBLIC_SERVER_URL?: string } };

const INITIAL_STACK = 1000;
// NEXT_PUBLIC_SERVER_URL is set to `/server` for the unified Vercel
// deployment. Prefer it over Vercel's generated service URL, whose public
// route need not match this application's rewrite prefix.
const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? process.env.NEXT_PUBLIC_GAME_URL ?? 'http://localhost:3001';

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

function hasMatchingInvite(payload: unknown): payload is { roomId: string; invitePath: string } {
  if (payload === null || typeof payload !== 'object') return false;

  const { roomId, invitePath } = payload as Record<string, unknown>;
  return typeof roomId === 'string'
    && typeof invitePath === 'string'
    && invitePath === `/r/${roomId}`;
}

export async function submitRoomCreation(
  nickname: string,
  boundaries: RoomCreationBoundaries,
): Promise<RoomCreationResult> {
  const displayName = nickname.trim();
  if (!displayName) return { ok: false, message: EMPTY_NICKNAME_MESSAGE };

  try {
    const response = await boundaries.fetch(`${SERVER_URL}/rooms`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName, initialStack: INITIAL_STACK }),
    });
    if (response.status !== 201) return { ok: false, message: CREATION_ERROR_MESSAGE };

    const payload = await response.json();
    if (!hasMatchingInvite(payload)) return { ok: false, message: CREATION_ERROR_MESSAGE };

    boundaries.navigate(payload.invitePath);
    return { ok: true };
  } catch {
    return { ok: false, message: CREATION_ERROR_MESSAGE };
  }
}
