import { loadLobby } from '../lobby-api';

export const ROOM_CODE_ERROR = 'הקוד צריך להכיל 16 אותיות וספרות. בדקו אותו ונסו שוב.';
export const ROOM_LOOKUP_ERROR = 'לא מצאנו חדר פעיל עם הקוד הזה. בדקו את הקוד ונסו שוב.';

export function normalizeRoomCode(value: string): string | undefined {
  const code = value.trim().replace(/[\s-]/g, '').toLowerCase();
  return /^[0-9a-f]{16}$/.test(code) ? code : undefined;
}

export async function enterRoomWithCode(
  input: string,
  boundaries: {
    fetch: (input: string, init: RequestInit) => Promise<{ status: number; json: () => Promise<unknown> }>;
    navigate: (path: string) => void;
  },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const code = normalizeRoomCode(input);
  if (!code) return { ok: false, message: ROOM_CODE_ERROR };

  const result = await loadLobby(code, { fetch: boundaries.fetch });
  if (!result.ok || result.lobby.status === 'COMPLETED') {
    return { ok: false, message: ROOM_LOOKUP_ERROR };
  }

  boundaries.navigate(`/r/${code}`);
  return { ok: true };
}
