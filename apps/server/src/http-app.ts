import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { createOriginPolicy, isAllowedRequestOrigin } from './origin-policy.js';
import type { RoomRepository } from './persistence/room-repository.js';
import { parseCookieHeader } from './socket-session.js';

const MAX_REQUEST_BODY_SIZE = '16kb';
const MAX_DISPLAY_NAME_CODE_POINTS = 24;
const MAX_INITIAL_STACK = 1_000_000;

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
};

type ValidatedRoomInput = {
  displayName: string;
  initialStack: number;
};

function validateCreateRoomInput(body: unknown): ValidatedRoomInput | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;

  const { displayName, initialStack } = body as CreateRoomRequest;
  if (typeof displayName !== 'string' || typeof initialStack !== 'number' || !Number.isSafeInteger(initialStack)) return undefined;

  const normalizedDisplayName = displayName.trim();
  if (
    normalizedDisplayName.length === 0
    || Array.from(normalizedDisplayName).length > MAX_DISPLAY_NAME_CODE_POINTS
    || initialStack <= 0
    || initialStack > MAX_INITIAL_STACK
  ) {
    return undefined;
  }

  return { displayName: normalizedDisplayName, initialStack };
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
    // The deployed web and game-server projects have different Vercel origins.
    // Cross-origin fetches and Socket.IO handshakes therefore need a secure,
    // cross-site cookie in production.
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction,
    path: '/',
  });
}

/** Builds the HTTP API independently from the Socket.IO transport. */
export function createApp({ roomRepository, isOriginAllowed = createOriginPolicy(), basePath }: CreateAppDependencies) {
  const app = express();
  const routes = express.Router();

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
        host: { id: randomUUID(), ...input },
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
    const input = validateCreateRoomInput(request.body);
    if (!input) {
      response.status(400).json({ error: { code: 'INVALID_REQUEST' } });
      return;
    }

    try {
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
      const accessToken = parseCookieHeader(request.headers.cookie).poker_player_token;
      const player = await roomRepository.findPlayerByRoomJoinIdAndAccessToken(request.params.joinId, accessToken);
      if (!player) {
        response.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        return;
      }
      await roomRepository.startGameForHostAtomically({ joinId: request.params.joinId, hostPlayerId: player.id });
      response.status(201).json({ roomId: request.params.joinId, status: 'IN_PROGRESS' });
    } catch {
      response.status(409).json({ error: { code: 'ROOM_NOT_STARTABLE' } });
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
      response.json({
        joinId: room.joinId,
        status: room.status,
        canStart: room.status === 'WAITING'
          && room.players.length >= 2
          && (await roomRepository.findPlayerByRoomJoinIdAndAccessToken(
            room.joinId,
            parseCookieHeader(request.headers.cookie).poker_player_token,
          ))?.id === room.hostPlayerId,
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
