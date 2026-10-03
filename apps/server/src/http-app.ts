import { randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { PlayerAction } from './game-lifecycle.js';
import { createOriginPolicy, isAllowedRequestOrigin } from './origin-policy.js';
import { GoogleOAuth, newCodeVerifier, safeAuthDestination } from './google-oauth.js';
import type { AccountRepository } from './persistence/account-repository.js';
import type { SocialRepository } from './persistence/social-repository.js';
import type { RoomRepository } from './persistence/room-repository.js';
import { parseCookieHeader } from './socket-session.js';

const MAX_REQUEST_BODY_SIZE = '80kb';
const MAX_DISPLAY_NAME_CODE_POINTS = 24;
const MAX_AVATAR_BYTES = 48 * 1024;
const MIN_INITIAL_STACK = 100;
const MAX_INITIAL_STACK = 1_000_000;
const MAX_BLIND = 100_000;
const MIN_ROOM_PLAYERS = 2;
const MAX_ROOM_PLAYERS = 9;
const DEFAULT_INITIAL_STACK = 500;
const DEFAULT_SMALL_BLIND = 1;
const DEFAULT_BIG_BLIND = 2;
const DEFAULT_MAX_PLAYERS = 9;
const PLAYER_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const PLAYER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasMaintenanceToken(value: unknown): boolean {
  const configuredToken = process.env.ONE_TIME_MAINTENANCE_TOKEN;
  if (!configuredToken || typeof value !== 'string') return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(configuredToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

type OriginPolicy = (origin: string | undefined) => boolean;

type CreateAppDependencies = {
  roomRepository: RoomRepository;
  accountRepository?: AccountRepository;
  socialRepository?: SocialRepository;
  googleOAuth?: GoogleOAuth;
  publicAppOrigin?: string;
  isOriginAllowed?: OriginPolicy;
  /**
   * Optional public prefix for a same-origin deployment.  Keeping the router
   * available at both paths lets the existing standalone API deployment remain
   * online while a Vercel Services deployment uses `/server`.
   */
  basePath?: string;
};

type CreateRoomRequest = {
  displayName?: unknown;
  avatarDataUrl?: unknown;
  initialStack?: unknown;
  smallBlind?: unknown;
  bigBlind?: unknown;
  maxPlayers?: unknown;
};

type ValidatedRoomInput = {
  displayName: string;
  avatarDataUrl?: string;
  initialStack: number;
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
};

function validateAvatarDataUrl(value: unknown): string | undefined | false {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return false;
  const match = /^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) return false;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) return false;
  const validMagic = match[1] === 'jpeg'
    ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : match[1] === 'png'
      ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return validMagic ? value : false;
}

function validateDisplayName(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const { displayName } = body as CreateRoomRequest;
  if (typeof displayName !== 'string') return undefined;
  const normalizedDisplayName = displayName.trim();
  return normalizedDisplayName.length > 0 && Array.from(normalizedDisplayName).length <= MAX_DISPLAY_NAME_CODE_POINTS
    ? normalizedDisplayName
    : undefined;
}

function validateCreateRoomInput(body: unknown): ValidatedRoomInput | undefined {
  const displayName = validateDisplayName(body);
  if (!displayName) return undefined;
  const { avatarDataUrl: rawAvatarDataUrl, initialStack = DEFAULT_INITIAL_STACK, smallBlind = DEFAULT_SMALL_BLIND, bigBlind = DEFAULT_BIG_BLIND, maxPlayers = DEFAULT_MAX_PLAYERS } = body as CreateRoomRequest;
  const avatarDataUrl = validateAvatarDataUrl(rawAvatarDataUrl);
  if (avatarDataUrl === false) return undefined;
  if (![initialStack, smallBlind, bigBlind, maxPlayers].every(Number.isSafeInteger)) return undefined;
  if (
    (initialStack as number) < MIN_INITIAL_STACK || (initialStack as number) > MAX_INITIAL_STACK
    || (smallBlind as number) < 1 || (smallBlind as number) > MAX_BLIND
    || (bigBlind as number) <= (smallBlind as number) || (bigBlind as number) > MAX_BLIND
    || (initialStack as number) < (bigBlind as number)
    || (maxPlayers as number) < MIN_ROOM_PLAYERS || (maxPlayers as number) > MAX_ROOM_PLAYERS
  ) return undefined;

  return { displayName, ...(avatarDataUrl ? { avatarDataUrl } : {}), initialStack: initialStack as number, smallBlind: smallBlind as number, bigBlind: bigBlind as number, maxPlayers: maxPlayers as number };
}

function validateGamePreset(body: unknown): { name: string; initialStack: number; smallBlind: number; bigBlind: number } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.name !== 'string') return undefined;
  const name = candidate.name.trim();
  if (!name || Array.from(name).length > 24) return undefined;
  if (![candidate.initialStack, candidate.smallBlind, candidate.bigBlind].every(Number.isSafeInteger)) return undefined;
  const settings = validateCreateRoomInput({
    displayName: 'preset',
    initialStack: candidate.initialStack,
    smallBlind: candidate.smallBlind,
    bigBlind: candidate.bigBlind,
  });
  return settings ? { name, initialStack: settings.initialStack, smallBlind: settings.smallBlind, bigBlind: settings.bigBlind } : undefined;
}

function validateJoinRoomInput(body: unknown): { displayName: string; avatarDataUrl?: string } | undefined {
  const displayName = validateDisplayName(body);
  if (!displayName) return undefined;
  const avatarDataUrl = validateAvatarDataUrl((body as CreateRoomRequest).avatarDataUrl);
  return avatarDataUrl === false ? undefined : { displayName, ...(avatarDataUrl ? { avatarDataUrl } : {}) };
}

function validatePlayerAction(body: unknown): PlayerAction | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const { type, raiseTo } = body as { type?: unknown; raiseTo?: unknown };
  if (type === 'check' || type === 'call' || type === 'fold' || type === 'all-in') return { type };
  if (type === 'raise' && typeof raiseTo === 'number' && Number.isSafeInteger(raiseTo)) return { type, raiseTo };
  return undefined;
}

function validatePlayerActionRequest(body: unknown): { action: PlayerAction; clientActionId?: string } | undefined {
  const direct = validatePlayerAction(body);
  if (direct) return { action: direct };
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const { action, clientActionId } = body as { action?: unknown; clientActionId?: unknown };
  const validated = validatePlayerAction(action);
  if (!validated || typeof clientActionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(clientActionId)) return undefined;
  return { action: validated, clientActionId };
}

function validateBlinds(body: unknown): { smallBlind: number; bigBlind: number } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const { smallBlind, bigBlind } = body as { smallBlind?: unknown; bigBlind?: unknown };
  if (!Number.isSafeInteger(smallBlind) || !Number.isSafeInteger(bigBlind)) return undefined;
  if ((smallBlind as number) < 1 || (smallBlind as number) > MAX_BLIND || (bigBlind as number) <= (smallBlind as number) || (bigBlind as number) > MAX_BLIND) return undefined;
  return { smallBlind: smallBlind as number, bigBlind: bigBlind as number };
}

const jsonErrorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  if (error instanceof SyntaxError || ('status' in error && (error.status === 400 || error.status === 413))) {
    response.status(error.status === 413 ? 413 : 400).json({ error: { code: 'INVALID_REQUEST' } });
    return;
  }

  next(error);
};

function createHttpCorsMiddleware(isOriginAllowed: OriginPolicy): RequestHandler {
  return (request, response, next) => {
    const origin = request.headers.origin;
    if (!origin) {
      next();
      return;
    }

    if (!isAllowedRequestOrigin(origin, request.headers.host, isOriginAllowed)) {
      response.status(403).json({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
      return;
    }

    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-None-Match');
    response.setHeader('Vary', 'Origin');

    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }

    next();
  };
}

function setPlayerSessionCookie(response: express.Response, accessToken: string): void {
  const isProduction = process.env.NODE_ENV === 'production';

  response.cookie('poker_player_token', accessToken, {
    httpOnly: true,
    // The game service is mounted at /server on the same Vercel origin. A
    // durable first-party cookie survives browser restarts without opening a
    // cross-site credential channel.
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: PLAYER_SESSION_MAX_AGE_MS,
  });
}

/** Builds the HTTP API independently from the Socket.IO transport. */
export function createApp({ roomRepository, accountRepository, socialRepository, googleOAuth, publicAppOrigin, isOriginAllowed = createOriginPolicy(), basePath }: CreateAppDependencies) {
  const app = express();
  const routes = express.Router();

  const findAccount = (cookieHeader: unknown) => accountRepository?.findBySession(parseCookieHeader(cookieHeader).poker_account_token) ?? Promise.resolve(null);
  const findAccountIdentity = (cookieHeader: unknown) => {
    const token = parseCookieHeader(cookieHeader).poker_account_token;
    return accountRepository?.findIdentityBySession?.(token) ?? accountRepository?.findBySession(token) ?? Promise.resolve(null);
  };

  const findAuthenticatedPlayer = async (joinId: string, cookieHeader: unknown) => {
    const account = await findAccountIdentity(cookieHeader);
    if (account) {
      const linkedPlayer = await roomRepository.findPlayerByRoomJoinIdAndAccountId(joinId, account.id);
      if (linkedPlayer) return linkedPlayer;
    }
    const legacyPlayer = await roomRepository.findPlayerByRoomJoinIdAndAccessToken(joinId, parseCookieHeader(cookieHeader).poker_player_token);
    if (legacyPlayer && account) {
      try {
        if (!await roomRepository.linkLegacyPlayerToAccount(legacyPlayer.id, account.id)) {
          return roomRepository.findPlayerByRoomJoinIdAndAccountId(joinId, account.id);
        }
      } catch {
        return roomRepository.findPlayerByRoomJoinIdAndAccountId(joinId, account.id);
      }
    }
    return legacyPlayer;
  };

  const findAuthenticatedHost = async (joinId: string, cookieHeader: unknown) => {
    const player = await findAuthenticatedPlayer(joinId, cookieHeader);
    if (!player) return null;
    const room = await roomRepository.findRoomByJoinId(joinId);
    return room?.hostPlayerId === player.id ? player : null;
  };

  app.use(createHttpCorsMiddleware(isOriginAllowed));

  app.use(express.json({ limit: MAX_REQUEST_BODY_SIZE }));

  // Register the unprefixed form first for local and standalone-server use.
  // A Vercel Services deployment preserves the incoming `/server` pathname, so
  // it additionally reaches this same router through the configured prefix.
  app.use(routes);
  if (basePath) app.use(basePath, routes);

  const authReady = Boolean(accountRepository && googleOAuth);
  const appRedirect = (path: string) => publicAppOrigin ? new URL(path, publicAppOrigin).toString() : path;
  const oauthCookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 10 * 60 * 1_000 };

  routes.get('/auth/me', async (request, response) => {
    if (!authReady) {
      response.json({ enabled: false });
      return;
    }
    try {
      const profile = await findAccount(request.headers.cookie);
      response.json({ enabled: true, profile });
    } catch {
      response.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
    }
  });

  routes.get('/auth/game-presets', async (request, response) => {
    try {
      const account = await findAccountIdentity(request.headers.cookie);
      if (!account || !accountRepository) { response.status(401).json({ error: { code: 'AUTH_REQUIRED' } }); return; }
      response.json({ presets: await accountRepository.listGamePresets(account.id) });
    } catch { response.status(500).json({ error: { code: 'INTERNAL_ERROR' } }); }
  });

  routes.put('/auth/game-presets', async (request, response) => {
    const input = validateGamePreset(request.body);
    if (!input) { response.status(400).json({ error: { code: 'INVALID_PRESET' } }); return; }
    try {
      const account = await findAccountIdentity(request.headers.cookie);
      if (!account || !accountRepository) { response.status(401).json({ error: { code: 'AUTH_REQUIRED' } }); return; }
      const preset = await accountRepository.saveGamePreset(account.id, input.name, input.initialStack, input.smallBlind, input.bigBlind);
      if (!preset) { response.status(409).json({ error: { code: 'PRESET_LIMIT_REACHED' } }); return; }
      response.json({ preset });
    } catch { response.status(500).json({ error: { code: 'INTERNAL_ERROR' } }); }
  });

  routes.delete('/auth/game-presets/:presetId', async (request, response) => {
    if (!UUID_PATTERN.test(request.params.presetId)) { response.status(400).json({ error: { code: 'INVALID_PRESET' } }); return; }
    try {
      const account = await findAccountIdentity(request.headers.cookie);
      if (!account || !accountRepository) { response.status(401).json({ error: { code: 'AUTH_REQUIRED' } }); return; }
      if (!await accountRepository.deleteGamePreset(account.id, request.params.presetId)) {
        response.status(404).json({ error: { code: 'PRESET_NOT_FOUND' } }); return;
      }
      response.status(204).end();
    } catch { response.status(500).json({ error: { code: 'INTERNAL_ERROR' } }); }
  });

  routes.get('/social', async (request, response) => {
    try {
      const account = await findAccountIdentity(request.headers.cookie);
      if (!account || !socialRepository) { response.status(401).json({ error: { code: 'AUTH_REQUIRED' } }); return; }
      response.setHeader('Cache-Control', 'private, no-store');
      response.json(await socialRepository.overview(account.id));
    } catch { response.status(500).json({ error: { code: 'INTERNAL_ERROR' } }); }
  });

  routes.get('/social/users', async (request, response) => {
    const cursor = request.query.cursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || !/^[a-z0-9._-]{1,24}$/i.test(cursor))) {
      response.status(400).json({ error: { code: 'INVALID_CURSOR' } }); return;
    }
    const validCursor = typeof cursor === 'string' ? cursor : undefined;
    try {
      const account = await findAccountIdentity(request.headers.cookie);
      if (!account || !socialRepository) { response.status(401).json({ error: { code: 'AUTH_REQUIRED' } }); return; }
      response.setHeader('Cache-Control', 'private, no-store');
      response.json(await socialRepository.listUsers(account.id, validCursor));
    } catch { response.status(500).json({ error: { code: 'INTERNAL_ERROR' } }); }
  });

  routes.get('/social/invitations', async (request, response) => {
    try {
      const account = await findAccountIdentity(request.headers.cookie);
      if (!account || !socialRepository) { response.status(401).json({ error: { code: 'AUTH_REQUIRED' } }); return; }
      response.setHeader('Cache-Control', 'private, no-store');
      response.json(await socialRepository.notificationSnapshot(account.id));
    } catch { response.status(500).json({ error: { code: 'INTERNAL_ERROR' } }); }
  });

  routes.post('/social/friend-requests', async (request, response) => {
    const username = request.body?.username;
    if (typeof username !== 'string' || !/^[a-z0-9._-]{1,24}$/i.test(username)) {
      response.status(400).json({ error: { code: 'INVALID_USERNAME' } }); return;
    }
    try {
      const account = await findAccountIdentity(request.headers.cookie);
      if (!account || !socialRepository) { response.status(401).json({ error: { code: 'AUTH_REQUIRED' } }); return; }
      const result = await socialRepository.requestFriend(account.id, username.toLowerCase());
      if (result !== 'sent') { response.status(result === 'not-found' ? 404 : 409).json({ error: { code: result.toUpperCase().replaceAll('-', '_') } }); return; }
      response.status(201).json({ status: 'PENDING' });
    } catch { response.status(500).json({ error: { code: 'INTERNAL_ERROR' } }); }
  });

  routes.put('/social/friend-requests/:requestId', async (request, response) => {
    if (!UUID_PATTERN.test(request.params.requestId) || typeof request.body?.accept !== 'boolean') {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } }); return;
    }
    try {
      const account = await findAccountIdentity(request.headers.cookie);
      if (!account || !socialRepository) { response.status(401).json({ error: { code: 'AUTH_REQUIRED' } }); return; }
      if (!await socialRepository.answerFriendRequest(account.id, request.params.requestId, request.body.accept)) {
        response.status(404).json({ error: { code: 'REQUEST_NOT_FOUND' } }); return;
      }
      response.status(204).end();
    } catch { response.status(500).json({ error: { code: 'INTERNAL_ERROR' } }); }
  });

  routes.delete('/social/friends/:friendId', async (request, response) => {
    if (!UUID_PATTERN.test(request.params.friendId)) { response.status(400).json({ error: { code: 'INVALID_REQUEST' } }); return; }
    try {
      const account = await findAccountIdentity(request.headers.cookie);
      if (!account || !socialRepository) { response.status(401).json({ error: { code: 'AUTH_REQUIRED' } }); return; }
      if (!await socialRepository.removeFriend(account.id, request.params.friendId)) {
        response.status(404).json({ error: { code: 'FRIEND_NOT_FOUND' } }); return;
      }
      response.status(204).end();
    } catch { response.status(500).json({ error: { code: 'INTERNAL_ERROR' } }); }
  });

  routes.post('/rooms/:joinId/invites', async (request, response) => {
    if (!UUID_PATTERN.test(request.body?.friendId)) { response.status(400).json({ error: { code: 'INVALID_REQUEST' } }); return; }
    try {
      const account = await findAccountIdentity(request.headers.cookie);
      const host = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
      if (!account || !host || !socialRepository) { response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } }); return; }
      const result = await socialRepository.inviteFriend(request.params.joinId, account.id, request.body.friendId);
      if (result !== 'sent') { response.status(409).json({ error: { code: result.toUpperCase().replaceAll('-', '_') } }); return; }
      response.status(201).json({ status: 'PENDING' });
    } catch { response.status(500).json({ error: { code: 'INTERNAL_ERROR' } }); }
  });

  routes.put('/social/invitations/:inviteId', async (request, response) => {
    if (!UUID_PATTERN.test(request.params.inviteId) || typeof request.body?.accept !== 'boolean') {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } }); return;
    }
    try {
      const account = await findAccountIdentity(request.headers.cookie);
      if (!account || !socialRepository) { response.status(401).json({ error: { code: 'AUTH_REQUIRED' } }); return; }
      const joinId = await socialRepository.answerGameInvite(account.id, request.params.inviteId, request.body.accept);
      if (!joinId) { response.status(404).json({ error: { code: 'INVITE_NOT_FOUND' } }); return; }
      response.json({ joinPath: request.body.accept ? `/r/${joinId}` : null });
    } catch { response.status(500).json({ error: { code: 'INTERNAL_ERROR' } }); }
  });

  routes.get('/auth/google/start', (request, response) => {
    if (!googleOAuth || !accountRepository) {
      response.status(503).json({ error: { code: 'AUTH_NOT_CONFIGURED' } });
      return;
    }
    const verifier = newCodeVerifier();
    const next = safeAuthDestination(request.query.next);
    response.cookie('poker_oauth_verifier', verifier, oauthCookieOptions);
    response.cookie('poker_oauth_next', Buffer.from(next).toString('base64url'), oauthCookieOptions);
    response.redirect(302, googleOAuth.authorizationUrl(verifier));
  });

  routes.get('/auth/google/callback', async (request, response) => {
    const cookies = parseCookieHeader(request.headers.cookie);
    response.clearCookie('poker_oauth_verifier', { path: '/' });
    response.clearCookie('poker_oauth_next', { path: '/' });
    if (!googleOAuth || !accountRepository || typeof request.query.code !== 'string') {
      response.redirect(303, appRedirect('/?auth_error=google'));
      return;
    }
    try {
      const identity = await googleOAuth.exchangeCode(request.query.code, cookies.poker_oauth_verifier);
      const { token, profile } = await accountRepository.createSession(identity.id, identity.email);
      response.cookie('poker_account_token', token, {
        httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: PLAYER_SESSION_MAX_AGE_MS,
      });
      const requestedNext = cookies.poker_oauth_next
        ? Buffer.from(cookies.poker_oauth_next, 'base64url').toString('utf8') : '/';
      const next = safeAuthDestination(requestedNext);
      response.redirect(303, appRedirect(profile.displayName ? next : `/profile?next=${encodeURIComponent(next)}`));
    } catch {
      response.redirect(303, appRedirect('/?auth_error=google'));
    }
  });

  routes.put('/auth/profile', async (request, response) => {
    if (!authReady || !accountRepository) {
      response.status(503).json({ error: { code: 'AUTH_NOT_CONFIGURED' } });
      return;
    }
    const displayName = validateDisplayName(request.body);
    const avatarDataUrl = validateAvatarDataUrl(request.body?.avatarDataUrl);
    if (!displayName || avatarDataUrl === false) {
      response.status(400).json({ error: { code: 'INVALID_PROFILE' } });
      return;
    }
    try {
      const account = await findAccount(request.headers.cookie);
      if (!account) {
        response.status(401).json({ error: { code: 'AUTH_REQUIRED' } });
        return;
      }
      const profile = await accountRepository.updateProfile(account.id, displayName, avatarDataUrl ?? null);
      response.json({ profile });
    } catch {
      response.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
    }
  });

  routes.post('/auth/logout', async (request, response) => {
    try {
      await accountRepository?.revokeSession(parseCookieHeader(request.headers.cookie).poker_account_token);
    } finally {
      response.clearCookie('poker_account_token', { path: '/' });
      response.clearCookie('poker_player_token', { path: '/' });
      response.status(204).end();
    }
  });

  routes.get('/auth/active-games', async (request, response) => {
    try {
      const account = await findAccountIdentity(request.headers.cookie);
      if (!account) { response.status(401).json({ error: { code: 'AUTH_REQUIRED' } }); return; }
      response.setHeader('Cache-Control', 'private, no-store');
      response.json({ games: await roomRepository.listActiveGamesForAccount(account.id) });
    } catch { response.status(500).json({ error: { code: 'INTERNAL_ERROR' } }); }
  });

  // This one-time, token-protected route exists solely to resolve a support
  // request where the authenticated host cannot access their device. It is
  // removed immediately after the operation completes.
  routes.get('/maintenance/active-rooms', async (request, response) => {
    if (!hasMaintenanceToken(request.header('x-maintenance-token'))) {
      response.status(404).end();
      return;
    }
    response.json({ rooms: await roomRepository.listActiveRoomsForMaintenance() });
  });

  routes.post('/maintenance/close-ori-shay-game', async (request, response) => {
    if (!hasMaintenanceToken(request.header('x-maintenance-token'))) {
      response.status(404).end();
      return;
    }
    const bodyJoinId = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body.joinId
      : undefined;
    const joinId = typeof bodyJoinId === 'string' ? bodyJoinId : request.query.joinId;
    if (typeof joinId !== 'string' || !/^[a-f0-9]{16}$/i.test(joinId)) {
      response.status(400).json({ error: { code: 'ONE_TIME_INVALID_ROOM' } });
      return;
    }
    try {
      const room = await roomRepository.findActiveRoomForMaintenance(joinId);
      if (!room?.hostPlayerId) {
        response.status(409).json({ error: { code: 'ONE_TIME_ROOM_NOT_FOUND' } });
        return;
      }
      const result = await roomRepository.closeRoomForHost(room.joinId, room.hostPlayerId);
      response.json({ joinId: room.joinId, status: result.status });
    } catch (error) {
      console.error('One-time maintenance room closure failed', error);
      response.status(409).json({ error: { code: 'ONE_TIME_ROOM_CLOSE_FAILED' } });
    }
  });

  routes.get('/auth/history', async (request, response) => {
    try {
      const account = await findAccountIdentity(request.headers.cookie);
      if (!account) { response.status(401).json({ error: { code: 'AUTH_REQUIRED' } }); return; }
      response.setHeader('Cache-Control', 'private, no-store');
      response.json({ games: await roomRepository.listGamesForAccount(account.id) });
    } catch { response.status(500).json({ error: { code: 'INTERNAL_ERROR' } }); }
  });

  routes.get('/auth/history/:joinId', async (request, response) => {
    try {
      const account = await findAccountIdentity(request.headers.cookie);
      if (!account) { response.status(401).json({ error: { code: 'AUTH_REQUIRED' } }); return; }
      response.setHeader('Cache-Control', 'private, no-store');
      const game = await roomRepository.listHandsForAccount(account.id, request.params.joinId);
      if (!game) { response.status(404).json({ error: { code: 'HISTORY_NOT_FOUND' } }); return; }
      response.json(game);
    } catch { response.status(500).json({ error: { code: 'INTERNAL_ERROR' } }); }
  });

  routes.get('/auth/history/:joinId/hands/:handKey', async (request, response) => {
    try {
      const account = await findAccountIdentity(request.headers.cookie);
      if (!account) { response.status(401).json({ error: { code: 'AUTH_REQUIRED' } }); return; }
      response.setHeader('Cache-Control', 'private, no-store');
      const hand = await roomRepository.getHandForAccount(account.id, request.params.joinId, request.params.handKey);
      if (!hand) { response.status(404).json({ error: { code: 'HISTORY_NOT_FOUND' } }); return; }
      response.json(hand);
    } catch { response.status(500).json({ error: { code: 'INTERNAL_ERROR' } }); }
  });

  routes.delete('/auth/history/:joinId', async (request, response) => {
    try {
      const account = await findAccountIdentity(request.headers.cookie);
      if (!account) { response.status(401).json({ error: { code: 'AUTH_REQUIRED' } }); return; }
      if (!await roomRepository.hideGameForAccount(account.id, request.params.joinId)) {
        response.status(404).json({ error: { code: 'HISTORY_NOT_FOUND' } });
        return;
      }
      response.status(204).end();
    } catch { response.status(500).json({ error: { code: 'INTERNAL_ERROR' } }); }
  });

  routes.post('/rooms', async (request, response) => {
    try {
      const account = authReady ? await findAccount(request.headers.cookie) : null;
      if (authReady && !account) {
        response.status(401).json({ error: { code: 'AUTH_REQUIRED' } });
        return;
      }
      if (account && !account.displayName) {
        response.status(409).json({ error: { code: 'PROFILE_REQUIRED' } });
        return;
      }
      const input = validateCreateRoomInput(account
        ? { ...request.body, displayName: account.displayName, avatarDataUrl: account.avatarDataUrl }
        : request.body);
      if (!input) {
        response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
        return;
      }
      const room = await roomRepository.createRoom({
        status: 'WAITING',
        host: { id: randomUUID(), ...(account ? { accountId: account.id } : {}), displayName: input.displayName, avatarDataUrl: input.avatarDataUrl, initialStack: input.initialStack },
        settings: { initialStack: input.initialStack, smallBlind: input.smallBlind, bigBlind: input.bigBlind, maxPlayers: input.maxPlayers },
      });
      if (!account) setPlayerSessionCookie(response, room.hostAccessToken);
      response.status(201).json({
        roomId: room.joinId,
        // This is a distinct host route, not an authorization secret. Host
        // abilities remain bound to the httpOnly player session.
        hostPath: `/r/${room.joinId}/host`,
        invitePath: `/r/${room.joinId}`,
      });
    } catch {
      console.error('Room creation failed');
      response.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
    }
  });

  routes.post('/rooms/:joinId/join', async (request, response) => {
    try {
      const account = authReady ? await findAccount(request.headers.cookie) : null;
      if (authReady && !account) {
        response.status(401).json({ error: { code: 'AUTH_REQUIRED' } });
        return;
      }
      if (account && !account.displayName) {
        response.status(409).json({ error: { code: 'PROFILE_REQUIRED' } });
        return;
      }
      const input = validateJoinRoomInput(account
        ? { displayName: account.displayName, avatarDataUrl: account.avatarDataUrl }
        : request.body);
      if (!input) {
        response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
        return;
      }
      // A player session is the device's one seat at this room. Do this on
      // the server as well as hiding the form in the UI: a repeated request
      // must not turn one person into multiple players.
      const existingPlayer = await findAuthenticatedPlayer(request.params.joinId, request.headers.cookie);
      if (existingPlayer) {
        response.status(account ? 200 : 409).json(account
          ? { roomId: request.params.joinId, invitePath: `/r/${request.params.joinId}` }
          : { error: { code: 'ALREADY_JOINED' } });
        return;
      }
      if (!account && await roomRepository.hasExistingPlayerSessionInRoom(
        request.params.joinId,
        parseCookieHeader(request.headers.cookie).poker_player_token,
      )) {
        response.status(409).json({ error: { code: 'ALREADY_JOINED' } });
        return;
      }
      const result = await roomRepository.joinWaitingRoom(request.params.joinId, {
        id: randomUUID(),
        ...(account ? { accountId: account.id } : {}),
        ...input,
      });
      if (result.kind === 'not-found') {
        response.status(404).json({ error: { code: 'ROOM_NOT_FOUND' } });
        return;
      }
      if (result.kind === 'not-joinable') {
        response.status(409).json({ error: { code: 'ROOM_NOT_JOINABLE' } });
        return;
      }
      if (result.kind === 'full') {
        response.status(409).json({ error: { code: 'ROOM_FULL' } });
        return;
      }
      if (result.kind === 'already-joined') {
        response.status(200).json({ roomId: request.params.joinId, invitePath: `/r/${request.params.joinId}` });
        return;
      }
      if (result.kind === 'removed') {
        response.status(403).json({ error: { code: 'PLAYER_REMOVED' } });
        return;
      }
      if (!account) setPlayerSessionCookie(response, result.playerAccessToken);
      response.status(201).json({ roomId: result.room.joinId, invitePath: `/r/${result.room.joinId}` });
    } catch {
      console.error('Room join failed');
      response.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
    }
  });

  routes.post('/rooms/:joinId/start', async (request, response) => {
    try {
      const player = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
      if (!player) {
        response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
        return;
      }
      await roomRepository.startGameForHostAtomically({ joinId: request.params.joinId, hostPlayerId: player.id });
      response.status(201).json({ roomId: request.params.joinId, status: 'IN_PROGRESS' });
    } catch (error) {
      // Keep the public response intentionally generic, but preserve the
      // underlying failure in server logs so production failures can be
      // diagnosed without exposing database or snapshot details to players.
      console.error('Room start failed', error);
      response.status(409).json({ error: { code: 'ROOM_NOT_STARTABLE' } });
    }
  });

  // The host pathname is a convenience URL only. This endpoint is available
  // to route guards and always derives host authority from the opaque
  // httpOnly player session plus the persisted room owner.
  routes.get('/rooms/:joinId/host-access', async (request, response) => {
    try {
      const player = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
      if (!player) {
        response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
        return;
      }
      response.json({ joinId: request.params.joinId, isHost: true });
    } catch {
      console.error('Host access lookup failed');
      response.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
    }
  });

  // HTTP is the portable realtime transport for the Vercel deployment. The
  // response is always scoped to the authenticated player, so polling never
  // exposes another player's hole cards.
  routes.get('/rooms/:joinId/game', async (request, response) => {
    try {
      const player = await findAuthenticatedPlayer(request.params.joinId, request.headers.cookie);
      if (!player) {
        response.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        return;
      }
      response.setHeader('Cache-Control', 'private, no-store');
      const refreshTag = await roomRepository.findGameRefreshTag?.(player.roomId, player.id);
      if (refreshTag && request.headers['if-none-match'] === refreshTag) {
        response.setHeader('ETag', refreshTag);
        response.status(304).end();
        return;
      }
      await roomRepository.drainPreActionsForRoom(player.roomId);
      const view = await roomRepository.recoverLatestPlayerViewForPlayer(player.roomId, player.id);
      if (!view) {
        response.status(409).json({ error: { code: 'GAME_NOT_AVAILABLE' } });
        return;
      }
      const currentTag = await roomRepository.findGameRefreshTag?.(player.roomId, player.id);
      if (currentTag) response.setHeader('ETag', currentTag);
      response.json(view);
    } catch (error) {
      console.error('Game state lookup failed', error);
      response.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
    }
  });

  routes.put('/rooms/:joinId/game/pre-action', async (request, response) => {
    const type = request.body?.type;
    if (type !== null && type !== 'check-fold' && type !== 'call') {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
      return;
    }
    try {
      const player = await findAuthenticatedPlayer(request.params.joinId, request.headers.cookie);
      if (!player) {
        response.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        return;
      }
      const choice = await roomRepository.setPreActionForPlayer(player.roomId, player.id, type);
      response.json({ preAction: choice });
    } catch (error) {
      console.error('Pre-action selection failed', error);
      response.status(409).json({ error: { code: 'PRE_ACTION_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/game/actions', async (request, response) => {
    const input = validatePlayerActionRequest(request.body);
    if (!input) {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
      return;
    }
    try {
      const player = await findAuthenticatedPlayer(request.params.joinId, request.headers.cookie);
      if (!player) {
        response.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        return;
      }
      const result = await roomRepository.persistPlayerActionAtomically({ roomId: player.roomId, playerId: player.id, ...input });
      try {
        await roomRepository.drainPreActionsForRoom(player.roomId);
      } catch (error) {
        console.error('Queued action processing failed', error);
      }
      response.status(201).json(await roomRepository.recoverLatestPlayerViewForPlayer(player.roomId, player.id) ?? result.view);
    } catch (error) {
      console.error('Game action failed', error);
      response.status(409).json({ error: { code: 'ACTION_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/game/turn/time-card', async (request, response) => {
    try {
      const player = await findAuthenticatedPlayer(request.params.joinId, request.headers.cookie);
      if (!player) {
        response.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        return;
      }
      const view = await roomRepository.useTimeCardAtomically(player.roomId, player.id);
      if (!view) throw new Error('Time card is unavailable');
      response.status(201).json(view);
    } catch (error) {
      console.error('Time card failed', error);
      response.status(409).json({ error: { code: 'TIME_CARD_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/game/turn/expire', async (request, response) => {
    try {
      const player = await findAuthenticatedPlayer(request.params.joinId, request.headers.cookie);
      if (!player) {
        response.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        return;
      }
      const result = await roomRepository.expireTurnForParticipant(player.roomId, player.id);
      response.status(result ? 201 : 200).json(result?.view ?? { expired: false });
    } catch (error) {
      console.error('Turn expiry failed', error);
      response.status(409).json({ error: { code: 'TURN_EXPIRY_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/game/next-hand', async (request, response) => {
    try {
      const player = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
      if (!player) {
        response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
        return;
      }
      await roomRepository.startNextHandForHostAtomically({ joinId: request.params.joinId, hostPlayerId: player.id });
      await roomRepository.drainPreActionsForRoom(player.roomId);
      response.status(201).json({ roomId: request.params.joinId, status: 'IN_PROGRESS' });
    } catch (error) {
      console.error('Next hand failed', error);
      response.status(409).json({ error: { code: 'NEXT_HAND_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/game/continue', async (request, response) => {
    try {
      const host = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
      if (!host) {
        response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
        return;
      }
      if (typeof request.body?.finalHand !== 'boolean') {
        response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
        return;
      }
      const result = await roomRepository.startNextHandForHostAtomically({
        joinId: request.params.joinId, hostPlayerId: host.id, finalHand: request.body.finalHand,
      });
      response.status(201).json({ roomId: request.params.joinId, status: 'IN_PROGRESS', finalHand: result.finalHand });
    } catch (error) {
      console.error('Completed-game continuation failed', error);
      response.status(409).json({ error: { code: 'CONTINUATION_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/game/final-hand', async (request, response) => {
    try {
      const player = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
      if (!player) {
        response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
        return;
      }
      const enabled = request.body?.enabled !== false;
      const result = await roomRepository.scheduleFinalHandForHost(request.params.joinId, player.id, enabled);
      response.status(201).json({ roomId: request.params.joinId, ...result });
    } catch (error) {
      console.error('Final hand failed', error);
      response.status(409).json({ error: { code: 'FINAL_HAND_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/game/final-summary/reveal', async (request, response) => {
    try {
      const host = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
      if (!host) {
        response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
        return;
      }
      const result = await roomRepository.revealFinalSummaryForHost(request.params.joinId, host.id);
      response.status(201).json(result);
    } catch (error) {
      console.error('Final summary reveal failed', error);
      response.status(409).json({ error: { code: 'FINAL_SUMMARY_REVEAL_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/game/finish', async (request, response) => {
    try {
      const host = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
      if (!host) { response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } }); return; }
      const result = await roomRepository.closeRoomForHost(request.params.joinId, host.id);
      response.setHeader('Cache-Control', 'private, no-store');
      response.json(result);
    } catch (error) {
      console.error('Game finish failed', error);
      response.status(409).json({ error: { code: 'GAME_FINISH_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/players/:playerId/remove', async (request, response) => {
    if (!PLAYER_ID_PATTERN.test(request.params.playerId)) {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
      return;
    }
    try {
      const player = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
      if (!player) {
        response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
        return;
      }
      await roomRepository.removePlayerBetweenHandsForHostAtomically({
        joinId: request.params.joinId,
        hostPlayerId: player.id,
        targetPlayerId: request.params.playerId,
      });
      response.status(201).json({ roomId: request.params.joinId, scheduledPlayerId: request.params.playerId });
    } catch (error) {
      console.error('Player removal failed', error);
      response.status(409).json({ error: { code: 'PLAYER_REMOVAL_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/lobby/players/:playerId/remove', async (request, response) => {
    if (!PLAYER_ID_PATTERN.test(request.params.playerId)) {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
      return;
    }
    try {
      const host = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
      if (!host) {
        response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
        return;
      }
      const result = await roomRepository.removeWaitingPlayerForHostAtomically({
        joinId: request.params.joinId,
        hostPlayerId: host.id,
        targetPlayerId: request.params.playerId,
      });
      response.status(200).json(result);
    } catch (error) {
      console.error('Waiting-room player removal failed', error);
      response.status(409).json({ error: { code: 'PLAYER_REMOVAL_UNAVAILABLE' } });
    }
  });

  routes.get('/rooms/:joinId/lobby/removed-players', async (request, response) => {
    const host = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
    if (!host) { response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } }); return; }
    const players = await roomRepository.listRemovedWaitingPlayersForHost(request.params.joinId, host.id);
    if (!players) { response.status(409).json({ error: { code: 'LOBBY_UNAVAILABLE' } }); return; }
    response.json({ players });
  });

  routes.post('/rooms/:joinId/lobby/players/:playerId/restore', async (request, response) => {
    if (!PLAYER_ID_PATTERN.test(request.params.playerId)) {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } }); return;
    }
    try {
      const host = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
      if (!host) { response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } }); return; }
      const result = await roomRepository.restoreWaitingPlayerForHostAtomically({
        joinId: request.params.joinId, hostPlayerId: host.id, targetPlayerId: request.params.playerId,
      });
      response.status(200).json(result);
    } catch (error) {
      console.error('Waiting-room player restoration failed', error);
      response.status(409).json({ error: { code: 'PLAYER_RESTORATION_UNAVAILABLE' } });
    }
  });

  routes.get('/rooms/:joinId/management', async (request, response) => {
    const player = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
    if (!player) {
      response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
      return;
    }
    const management = await roomRepository.getHostManagement(request.params.joinId, player.id);
    if (!management) {
      response.status(409).json({ error: { code: 'MANAGEMENT_UNAVAILABLE' } });
      return;
    }
    response.json(management);
  });

  routes.post('/rooms/:joinId/management/blinds', async (request, response) => {
    const player = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
    if (!player) {
      response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
      return;
    }
    const input = validateBlinds(request.body);
    if (!input) {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
      return;
    }
    try {
      response.status(201).json(await roomRepository.updateBlindsForHost(request.params.joinId, player.id, input.smallBlind, input.bigBlind));
    } catch {
      response.status(409).json({ error: { code: 'BLIND_UPDATE_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/management/players/:playerId/removal', async (request, response) => {
    const player = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
    if (!player) {
      response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
      return;
    }
    if (!PLAYER_ID_PATTERN.test(request.params.playerId) || typeof request.body?.enabled !== 'boolean') {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
      return;
    }
    try {
      const result = request.body.enabled
        ? await roomRepository.removePlayerBetweenHandsForHostAtomically({ joinId: request.params.joinId, hostPlayerId: player.id, targetPlayerId: request.params.playerId })
        : await roomRepository.cancelPlayerRemovalForHost(request.params.joinId, player.id, request.params.playerId);
      response.status(201).json(result);
    } catch {
      response.status(409).json({ error: { code: 'PLAYER_REMOVAL_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/management/players/:playerId/chips', async (request, response) => {
    const player = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
    if (!player) {
      response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
      return;
    }
    if (!PLAYER_ID_PATTERN.test(request.params.playerId) || !Number.isSafeInteger(request.body?.amount)) {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
      return;
    }
    try {
      const result = request.body.amount === 0
        ? await roomRepository.cancelPendingChipsForHost(request.params.joinId, player.id, request.params.playerId)
        : await roomRepository.addChipsForHost(request.params.joinId, player.id, request.params.playerId, request.body.amount);
      response.status(201).json(result ?? { status: 'cancelled' });
    } catch {
      response.status(409).json({ error: { code: 'CHIP_ADJUSTMENT_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/management/players/:playerId/rebuy/decline', async (request, response) => {
    const player = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
    if (!player) {
      response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
      return;
    }
    if (!PLAYER_ID_PATTERN.test(request.params.playerId)) {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
      return;
    }
    try {
      response.status(201).json(await roomRepository.declineRebuyForHost(request.params.joinId, player.id, request.params.playerId));
    } catch {
      response.status(409).json({ error: { code: 'REBUY_DECISION_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/management/transfer-host', async (request, response) => {
    const player = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
    if (!player) {
      response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
      return;
    }
    const targetPlayerId = request.body?.targetPlayerId;
    const leaveAfterHand = request.body?.leaveAfterHand;
    if ((targetPlayerId !== undefined && (typeof targetPlayerId !== 'string' || !PLAYER_ID_PATTERN.test(targetPlayerId))) || typeof leaveAfterHand !== 'boolean') {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
      return;
    }
    try {
      response.status(201).json(await roomRepository.transferHostForHost(request.params.joinId, player.id, targetPlayerId, leaveAfterHand));
    } catch {
      response.status(409).json({ error: { code: 'HOST_TRANSFER_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/game/runout/next', async (request, response) => {
    try {
      const player = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
      if (!player) {
        response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
        return;
      }
      const result = await roomRepository.advanceAllInRunoutForHostAtomically({ joinId: request.params.joinId, hostPlayerId: player.id });
      const view = result.views.find((candidate) => candidate.playerId === player.id);
      if (!view) throw new Error('All-in board is unavailable');
      response.status(201).json(view);
    } catch (error) {
      console.error('All-in board advance failed', error);
      response.status(409).json({ error: { code: 'ALL_IN_RUNOUT_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/game/runout/uncontested', async (request, response) => {
    try {
      const player = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
      if (!player) {
        response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
        return;
      }
      const result = await roomRepository.advanceRabbitRunoutForHostAtomically({ joinId: request.params.joinId, hostPlayerId: player.id });
      const view = result.views.find((candidate) => candidate.playerId === player.id);
      if (!view) throw new Error('Uncontested board is unavailable');
      response.status(201).json(view);
    } catch (error) {
      console.error('Uncontested board advance failed', error);
      response.status(409).json({ error: { code: 'UNCONTESTED_RUNOUT_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/game/reveal', async (request, response) => {
    try {
      const cardIndex = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
        ? (request.body as { cardIndex?: unknown }).cardIndex
        : undefined;
      if (cardIndex !== 0 && cardIndex !== 1) {
        response.status(400).json({ error: { code: 'INVALID_SHOWDOWN_CARD' } });
        return;
      }
      const player = await findAuthenticatedPlayer(request.params.joinId, request.headers.cookie);
      if (!player) {
        response.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        return;
      }
      const result = await roomRepository.revealShowdownCardAtomically({ roomId: player.roomId, playerId: player.id, cardIndex });
      response.status(201).json(result.view);
    } catch (error) {
      console.error('Showdown reveal failed', error);
      response.status(409).json({ error: { code: 'SHOWDOWN_REVEAL_UNAVAILABLE' } });
    }
  });

  routes.get('/rooms/:joinId/final-summary', async (request, response) => {
    try {
      const player = await findAuthenticatedPlayer(request.params.joinId, request.headers.cookie);
      if (!player) {
        response.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        return;
      }
      const summary = await roomRepository.getFinalSummaryForPlayer(player.roomId, player.id);
      if (!summary) {
        response.status(409).json({ error: { code: 'FINAL_SUMMARY_UNAVAILABLE' } });
        return;
      }
      response.json({
        version: summary.version,
        room: summary.room,
        standings: summary.standings,
        handCount: summary.hands.length,
        recap: summary.recap,
      });
    } catch (error) {
      console.error('Final summary lookup failed', error);
      response.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
    }
  });

  routes.get('/rooms/:joinId/final-summary/download', async (request, response) => {
    try {
      const host = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
      if (!host) {
        response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
        return;
      }
      const summary = await roomRepository.getFinalSummaryForPlayer(host.roomId, host.id);
      if (!summary) {
        response.status(409).json({ error: { code: 'FINAL_SUMMARY_UNAVAILABLE' } });
        return;
      }
      response.setHeader('Content-Disposition', `attachment; filename="texas-holdem-${request.params.joinId}-summary.json"`);
      response.json(summary);
    } catch (error) {
      console.error('Final summary download failed', error);
      response.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
    }
  });

  routes.get('/rooms/:joinId', async (request, response) => {
    try {
      const room = await roomRepository.findRoomByJoinId(request.params.joinId);
      if (!room || (room.status !== 'WAITING' && room.status !== 'IN_PROGRESS' && room.status !== 'COMPLETED')) {
        response.status(404).json({ error: { code: 'ROOM_NOT_FOUND' } });
        return;
      }
      const host = room.players.find((player) => player.id === room.hostPlayerId);
      if (!host) {
        response.status(404).json({ error: { code: 'ROOM_NOT_FOUND' } });
        return;
      }
      const sessionPlayer = await findAuthenticatedPlayer(room.joinId, request.headers.cookie);
      const isHost = sessionPlayer?.id === room.hostPlayerId;
      response.json({
        joinId: room.joinId,
        status: room.status,
        isHost,
        isParticipant: Boolean(sessionPlayer),
        canStart: room.status === 'WAITING'
          && room.players.length >= 2
          && isHost,
        settings: {
          initialStack: room.initialStack,
          smallBlind: room.smallBlind,
          bigBlind: room.bigBlind,
          maxPlayers: room.maxPlayers,
        },
        host: { displayName: host.displayName, ...(host.avatarDataUrl ? { avatarDataUrl: host.avatarDataUrl } : {}) },
        players: room.players.filter((player) => !player.isSittingOut).map(({ id, displayName, avatarDataUrl, initialStack, currentStack }) => ({ ...(isHost && room.status === 'WAITING' ? { id } : {}), displayName, ...(avatarDataUrl ? { avatarDataUrl } : {}), initialStack, currentStack })),
      });
    } catch {
      console.error('Room lookup failed');
      response.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
    }
  });

  app.use(jsonErrorHandler);
  return app;
}
