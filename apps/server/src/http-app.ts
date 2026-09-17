import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { PlayerAction } from './game-lifecycle.js';
import { createOriginPolicy, isAllowedRequestOrigin } from './origin-policy.js';
import type { RoomRepository } from './persistence/room-repository.js';
import { parseCookieHeader } from './socket-session.js';

const MAX_REQUEST_BODY_SIZE = '16kb';
const MAX_DISPLAY_NAME_CODE_POINTS = 24;
const MIN_INITIAL_STACK = 100;
const MAX_INITIAL_STACK = 1_000_000;
const MAX_BLIND = 100_000;
const MIN_ROOM_PLAYERS = 2;
const MAX_ROOM_PLAYERS = 9;
const DEFAULT_SMALL_BLIND = 5;
const DEFAULT_BIG_BLIND = 10;
const DEFAULT_MAX_PLAYERS = 9;
const PLAYER_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

type OriginPolicy = (origin: string | undefined) => boolean;

type CreateAppDependencies = {
  roomRepository: RoomRepository;
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
  initialStack?: unknown;
  smallBlind?: unknown;
  bigBlind?: unknown;
  maxPlayers?: unknown;
};

type ValidatedRoomInput = {
  displayName: string;
  initialStack: number;
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
};

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
  const { initialStack, smallBlind = DEFAULT_SMALL_BLIND, bigBlind = DEFAULT_BIG_BLIND, maxPlayers = DEFAULT_MAX_PLAYERS } = body as CreateRoomRequest;
  if (![initialStack, smallBlind, bigBlind, maxPlayers].every(Number.isSafeInteger)) return undefined;
  if (
    (initialStack as number) < MIN_INITIAL_STACK || (initialStack as number) > MAX_INITIAL_STACK
    || (smallBlind as number) < 1 || (smallBlind as number) > MAX_BLIND
    || (bigBlind as number) <= (smallBlind as number) || (bigBlind as number) > MAX_BLIND
    || (initialStack as number) < (bigBlind as number)
    || (maxPlayers as number) < MIN_ROOM_PLAYERS || (maxPlayers as number) > MAX_ROOM_PLAYERS
  ) return undefined;

  return { displayName, initialStack: initialStack as number, smallBlind: smallBlind as number, bigBlind: bigBlind as number, maxPlayers: maxPlayers as number };
}

function validateJoinRoomInput(body: unknown): { displayName: string } | undefined {
  const displayName = validateDisplayName(body);
  return displayName ? { displayName } : undefined;
}

function validatePlayerAction(body: unknown): PlayerAction | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const { type, raiseTo } = body as { type?: unknown; raiseTo?: unknown };
  if (type === 'check' || type === 'call' || type === 'fold' || type === 'all-in') return { type };
  if (type === 'raise' && typeof raiseTo === 'number' && Number.isSafeInteger(raiseTo)) return { type, raiseTo };
  return undefined;
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
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
export function createApp({ roomRepository, isOriginAllowed = createOriginPolicy(), basePath }: CreateAppDependencies) {
  const app = express();
  const routes = express.Router();

  const findAuthenticatedHost = async (joinId: string, cookieHeader: unknown) => {
    const player = await roomRepository.findPlayerByRoomJoinIdAndAccessToken(
      joinId,
      parseCookieHeader(cookieHeader).poker_player_token,
    );
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

  routes.post('/rooms', async (request, response) => {
    const input = validateCreateRoomInput(request.body);
    if (!input) {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
      return;
    }

    try {
      const room = await roomRepository.createRoom({
        status: 'WAITING',
        host: { id: randomUUID(), displayName: input.displayName, initialStack: input.initialStack },
        settings: { initialStack: input.initialStack, smallBlind: input.smallBlind, bigBlind: input.bigBlind, maxPlayers: input.maxPlayers },
      });
      setPlayerSessionCookie(response, room.hostAccessToken);
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
    const input = validateJoinRoomInput(request.body);
    if (!input) {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
      return;
    }

    try {
      // A player session is the device's one seat at this room. Do this on
      // the server as well as hiding the form in the UI: a repeated request
      // must not turn one person into multiple players.
      const existingPlayer = await roomRepository.findPlayerByRoomJoinIdAndAccessToken(
        request.params.joinId,
        parseCookieHeader(request.headers.cookie).poker_player_token,
      );
      if (existingPlayer) {
        response.status(409).json({ error: { code: 'ALREADY_JOINED' } });
        return;
      }
      const result = await roomRepository.joinWaitingRoom(request.params.joinId, {
        id: randomUUID(),
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
      setPlayerSessionCookie(response, result.playerAccessToken);
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
      const player = await roomRepository.findPlayerByRoomJoinIdAndAccessToken(
        request.params.joinId,
        parseCookieHeader(request.headers.cookie).poker_player_token,
      );
      if (!player) {
        response.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        return;
      }
      const view = await roomRepository.recoverLatestPlayerViewForPlayer(player.roomId, player.id);
      if (!view) {
        response.status(409).json({ error: { code: 'GAME_NOT_AVAILABLE' } });
        return;
      }
      response.json(view);
    } catch (error) {
      console.error('Game state lookup failed', error);
      response.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
    }
  });

  routes.post('/rooms/:joinId/game/actions', async (request, response) => {
    const action = validatePlayerAction(request.body);
    if (!action) {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
      return;
    }
    try {
      const player = await roomRepository.findPlayerByRoomJoinIdAndAccessToken(
        request.params.joinId,
        parseCookieHeader(request.headers.cookie).poker_player_token,
      );
      if (!player) {
        response.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        return;
      }
      const result = await roomRepository.persistPlayerActionAtomically({ roomId: player.roomId, playerId: player.id, action });
      response.status(201).json(result.view);
    } catch (error) {
      console.error('Game action failed', error);
      response.status(409).json({ error: { code: 'ACTION_UNAVAILABLE' } });
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
      response.status(201).json({ roomId: request.params.joinId, status: 'IN_PROGRESS' });
    } catch (error) {
      console.error('Next hand failed', error);
      response.status(409).json({ error: { code: 'NEXT_HAND_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/game/runout/next', async (request, response) => {
    try {
      const player = await findAuthenticatedHost(request.params.joinId, request.headers.cookie);
      if (!player) {
        response.status(403).json({ error: { code: 'HOST_FORBIDDEN' } });
        return;
      }
      await roomRepository.advanceAllInRunoutForHostAtomically({ joinId: request.params.joinId, hostPlayerId: player.id });
      response.status(201).json({ roomId: request.params.joinId, status: 'IN_PROGRESS' });
    } catch (error) {
      console.error('All-in board advance failed', error);
      response.status(409).json({ error: { code: 'ALL_IN_RUNOUT_UNAVAILABLE' } });
    }
  });

  routes.post('/rooms/:joinId/game/reveal', async (request, response) => {
    try {
      const player = await roomRepository.findPlayerByRoomJoinIdAndAccessToken(
        request.params.joinId,
        parseCookieHeader(request.headers.cookie).poker_player_token,
      );
      if (!player) {
        response.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        return;
      }
      const result = await roomRepository.revealShowdownHandAtomically({ roomId: player.roomId, playerId: player.id });
      response.status(201).json(result.view);
    } catch (error) {
      console.error('Showdown reveal failed', error);
      response.status(409).json({ error: { code: 'SHOWDOWN_REVEAL_UNAVAILABLE' } });
    }
  });

  routes.get('/rooms/:joinId', async (request, response) => {
    try {
      const room = await roomRepository.findRoomByJoinId(request.params.joinId);
      if (!room || (room.status !== 'WAITING' && room.status !== 'IN_PROGRESS')) {
        response.status(404).json({ error: { code: 'ROOM_NOT_FOUND' } });
        return;
      }
      const host = room.players.find((player) => player.id === room.hostPlayerId);
      if (!host) {
        response.status(404).json({ error: { code: 'ROOM_NOT_FOUND' } });
        return;
      }
      const sessionPlayer = await roomRepository.findPlayerByRoomJoinIdAndAccessToken(
        room.joinId,
        parseCookieHeader(request.headers.cookie).poker_player_token,
      );
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
        host: { displayName: host.displayName },
        players: room.players.map(({ displayName, initialStack, currentStack }) => ({ displayName, initialStack, currentStack })),
      });
    } catch {
      console.error('Room lookup failed');
      response.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
    }
  });

  app.use(jsonErrorHandler);
  return app;
}
