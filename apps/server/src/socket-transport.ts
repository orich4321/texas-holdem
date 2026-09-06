import { authenticateSocketSession, type SocketSessionIdentity, type SocketSessionRepository } from './socket-session.js';

export interface SessionSocket {
  handshake: { auth?: unknown; headers?: { cookie?: unknown } };
  data: { session?: SocketSessionIdentity };
  join(room: string): unknown;
  emit(event: string, payload: unknown): unknown;
}

export interface SessionIo {
  use(middleware: (socket: SessionSocket, next: (error?: Error) => void) => void): unknown;
  on(event: 'connection', listener: (socket: SessionSocket) => void): unknown;
}

/**
 * Adds the authenticated Socket.IO boundary. Identity comes only from the
 * httpOnly cookie and requested room join ID; any client-supplied player ID is
 * ignored. This is deliberately transport-only: starting/recovering hands
 * stays disabled until durable snapshot/event persistence is connected.
 */
export function attachSocketSessionTransport(io: SessionIo, repository: SocketSessionRepository): void {
  io.use((socket, next) => {
    void authenticateSocketSession(repository, socket)
      .then((identity) => {
        socket.data.session = identity;
        next();
      })
      .catch(() => next(new Error('Unauthorized socket session')));
  });

  io.on('connection', (socket) => {
    const session = socket.data.session;
    if (!session) return;
    socket.join(session.roomJoinId);
    socket.emit('session:ready', Object.freeze({
      roomJoinId: session.roomJoinId,
      playerId: session.playerId,
      displayName: session.displayName,
    }));
  });
}
