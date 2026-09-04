import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { createOriginPolicy } from './origin-policy.js';
import type { RoomRepository } from './persistence/room-repository.js';

const MAX_REQUEST_BODY_SIZE = '16kb';
const MAX_DISPLAY_NAME_CODE_POINTS = 24;
const MAX_INITIAL_STACK = 1_000_000;

type OriginPolicy = (origin: string | undefined) => boolean;

type CreateAppDependencies = {
  roomRepository: RoomRepository;
  isOriginAllowed?: OriginPolicy;
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

    if (!isOriginAllowed(origin)) {
      response.status(403).json({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
      return;
    }

    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Methods', 'POST');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Vary', 'Origin');

    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }

    next();
  };
}

export function createApp({ roomRepository, isOriginAllowed = createOriginPolicy() }: CreateAppDependencies) {
  const app = express();

  app.use(createHttpCorsMiddleware(isOriginAllowed));

  app.use(express.json({ limit: MAX_REQUEST_BODY_SIZE }));

  app.post('/rooms', async (request, response) => {
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
      response.status(201).json({ roomId: room.joinId, invitePath: `/r/${room.joinId}` });
    } catch {
      console.error('Room creation failed');
      response.status(500).json({ error: { code: 'INTERNAL_ERROR' } });
    }
  });

  app.use(jsonErrorHandler);
  return app;
}
