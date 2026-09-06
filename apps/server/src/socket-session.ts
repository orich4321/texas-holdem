import { isValidPlayerAccessToken } from './persistence/player-access-token.js';

const ROOM_JOIN_ID_PATTERN = /^[a-f0-9]{16}$/;

export interface SocketSessionRepository {
  findPlayerByRoomJoinIdAndAccessToken(joinId: string, accessToken: unknown): Promise<{
    id: string;
    roomId: string;
    displayName: string;
  } | null>;
}

export interface SocketHandshakeSource {
  handshake?: {
    auth?: unknown;
    headers?: { cookie?: unknown };
  };
}

export interface SocketSessionIdentity {
  roomJoinId: string;
  roomId: string;
  playerId: string;
  displayName: string;
}

/** Parses plain cookie pairs without decoding; duplicate names are deliberately rejected. */
export function parseCookieHeader(header: unknown): Readonly<Record<string, string>> {
  if (typeof header !== 'string' || header.length === 0 || header.length > 8_192) return Object.freeze({});
  const parsed: Record<string, string> = {};
  const duplicates = new Set<string>();
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || value.length === 0) continue;
    if (Object.hasOwn(parsed, name)) {
      delete parsed[name];
      duplicates.add(name);
    } else if (!duplicates.has(name)) {
      parsed[name] = value;
    }
  }
  return Object.freeze(parsed);
}

function unauthorized(): never {
  throw new Error('Unauthorized socket session');
}

/**
 * Resolves socket identity only from the invite join ID and the httpOnly player
 * cookie. Client-provided player IDs, tokens, cards, seeds, and RNG are ignored.
 */
export async function authenticateSocketSession(repository: SocketSessionRepository, socket: SocketHandshakeSource): Promise<SocketSessionIdentity> {
  const auth = socket?.handshake?.auth;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) unauthorized();
  const roomJoinId = (auth as { roomJoinId?: unknown }).roomJoinId;
  if (typeof roomJoinId !== 'string' || !ROOM_JOIN_ID_PATTERN.test(roomJoinId)) unauthorized();

  const cookies = parseCookieHeader(socket?.handshake?.headers?.cookie);
  const accessToken = cookies.poker_player_token;
  if (!isValidPlayerAccessToken(accessToken)) unauthorized();

  const player = await repository.findPlayerByRoomJoinIdAndAccessToken(roomJoinId, accessToken);
  if (!player) unauthorized();
  return Object.freeze({ roomJoinId, roomId: player.roomId, playerId: player.id, displayName: player.displayName });
}
