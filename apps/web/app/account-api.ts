declare const process: { env: { NODE_ENV?: string; NEXT_PUBLIC_GAME_URL?: string; NEXT_PUBLIC_SERVER_URL?: string } };

export const SERVER_URL = process.env.NODE_ENV === 'production'
  ? '/server'
  : process.env.NEXT_PUBLIC_SERVER_URL ?? process.env.NEXT_PUBLIC_GAME_URL ?? 'http://localhost:3001';

export type AccountProfile = { id: string; displayName: string | null; avatarDataUrl: string | null; username: string | null };
export type AccountState = { enabled: boolean; profile: AccountProfile | null };

export async function loadAccount(): Promise<AccountState> {
  const response = await globalThis.fetch(`${SERVER_URL}/auth/me`, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error('Account unavailable');
  const body = await response.json() as { enabled?: unknown; profile?: unknown };
  if (body.enabled === false) return { enabled: false, profile: null };
  if (body.enabled !== true) throw new Error('Invalid account response');
  const profile = body.profile;
  if (profile === null) return { enabled: true, profile: null };
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Invalid account profile');
  const value = profile as Record<string, unknown>;
  if (typeof value.id !== 'string' || (value.username !== null && typeof value.username !== 'string')
    || (value.displayName !== null && typeof value.displayName !== 'string')
    || (value.avatarDataUrl !== null && typeof value.avatarDataUrl !== 'string')) throw new Error('Invalid account profile');
  return { enabled: true, profile: value as AccountProfile };
}

export function googleLoginPath(next: string): string {
  return `${SERVER_URL}/auth/google/start?next=${encodeURIComponent(next)}`;
}

export function profilePath(next: string): string {
  return `/profile?next=${encodeURIComponent(next)}`;
}
