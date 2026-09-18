import { authenticateSocketSession, type SocketSessionIdentity, type SocketSessionRepository } from './socket-session.js';
import type { PlayerAction, ServerPlayerView } from './game-lifecycle.js';

export interface SessionSocket {
  handshake: { auth?: unknown; headers?: { cookie?: unknown } };
  data: { session?: SocketSessionIdentity };
  join(room: string): unknown;
  emit(event: string, payload: unknown): unknown;
  on(event: string, listener: (payload?: unknown, acknowledge?: (payload: unknown) => void) => void): unknown;
}

export interface SessionIo {
  use(middleware: (socket: SessionSocket, next: (error?: Error) => void) => void): unknown;
  on(event: 'connection', listener: (socket: SessionSocket) => void): unknown;
}

interface GameSocketRepository extends SocketSessionRepository {
  recoverLatestPlayerViewForPlayer(roomId: string, playerId: string): Promise<ServerPlayerView | null>;
  persistPlayerActionAtomically(input: { roomId: string; playerId: string; action: PlayerAction }): Promise<{
    sequence: number;
    views: readonly ServerPlayerView[];
  }>;
}

function emitGameError(socket: SessionSocket): void {
  socket.emit('game:error', Object.freeze({ code: 'ACTION_UNAVAILABLE' }));
}

/**
 * Adds the authenticated Socket.IO boundary. Identity comes only from the
 * httpOnly cookie and requested room join ID; any client-supplied player ID is
 * ignored. Player-safe game projections are emitted only to matching
 * authenticated sockets; room broadcasts never carry a player's hole cards.
 */
export function attachSocketSessionTransport(io: SessionIo, repository: GameSocketRepository): void {
  const socketsByRoom = new Map<string, Set<SessionSocket>>();

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
    const roomSockets = socketsByRoom.get(session.roomId) ?? new Set<SessionSocket>();
    roomSockets.add(socket);
    socketsByRoom.set(session.roomId, roomSockets);
    socket.emit('session:ready', Object.freeze({
      roomJoinId: session.roomJoinId,
      playerId: session.playerId,
      displayName: session.displayName,
    }));

    void repository.recoverLatestPlayerViewForPlayer(session.roomId, session.playerId)
      .then((view) => { if (view) socket.emit('game:state', view); })
      .catch(() => emitGameError(socket));

    socket.on('game:action', (payload, acknowledge) => {
      const envelope = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as { action?: unknown; clientActionId?: unknown }
        : {};
      const action = envelope.action ?? payload;
      void repository.persistPlayerActionAtomically({
        roomId: session.roomId,
        playerId: session.playerId,
        action: action as PlayerAction,
        ...(typeof envelope.clientActionId === 'string' ? { clientActionId: envelope.clientActionId } : {}),
      })
        .then(({ views }) => {
          for (const view of views) {
            for (const recipient of socketsByRoom.get(session.roomId) ?? []) {
              if (recipient.data.session?.playerId === view.playerId) recipient.emit('game:state', view);
            }
          }
          acknowledge?.(Object.freeze({ ok: true, view: views.find((view) => view.playerId === session.playerId) }));
        })
        .catch(() => {
          emitGameError(socket);
          acknowledge?.(Object.freeze({ ok: false }));
        });
    });
    socket.on('disconnect', () => {
      const connected = socketsByRoom.get(session.roomId);
      if (!connected) return;
      connected.delete(socket);
      if (connected.size === 0) socketsByRoom.delete(session.roomId);
    });
  });
}
