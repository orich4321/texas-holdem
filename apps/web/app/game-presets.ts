import { SERVER_URL } from './account-api';

export type GamePreset = { id: string; name: string; initialStack: number; smallBlind: number; bigBlind: number };

function isGamePreset(value: unknown): value is GamePreset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const preset = value as Record<string, unknown>;
  return typeof preset.id === 'string' && typeof preset.name === 'string'
    && ['initialStack', 'smallBlind', 'bigBlind'].every((key) => Number.isSafeInteger(preset[key]));
}

export async function loadGamePresets(): Promise<GamePreset[]> {
  const response = await globalThis.fetch(`${SERVER_URL}/auth/game-presets`, { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error('Cannot load game presets');
  const payload = await response.json() as { presets?: unknown };
  if (!Array.isArray(payload.presets) || !payload.presets.every(isGamePreset)) throw new Error('Invalid game presets');
  return payload.presets;
}

export async function saveGamePreset(name: string, initialStack: number, smallBlind: number, bigBlind: number): Promise<GamePreset> {
  const response = await globalThis.fetch(`${SERVER_URL}/auth/game-presets`, {
    method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, initialStack, smallBlind, bigBlind }),
  });
  if (!response.ok) throw new Error(response.status === 409 ? 'LIMIT' : 'Cannot save game preset');
  const payload = await response.json() as { preset?: unknown };
  if (!isGamePreset(payload.preset)) throw new Error('Invalid game preset');
  return payload.preset;
}

export async function deleteGamePreset(id: string): Promise<void> {
  const response = await globalThis.fetch(`${SERVER_URL}/auth/game-presets/${encodeURIComponent(id)}`, {
    method: 'DELETE', credentials: 'include',
  });
  if (!response.ok) throw new Error('Cannot delete game preset');
}
