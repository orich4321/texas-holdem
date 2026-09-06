import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient, RoomStatus } from '@prisma/client';
import {
  createPlayerAccessToken,
  hashPlayerAccessToken,
  isValidPlayerAccessToken,
  type PlayerAccessTokenFactory,
  type PlayerAccessTokenHasher,
} from './player-access-token.js';
import { createRoomJoinId } from './room-join-id.js';
import {
  hydrateSignedPrivateHandSnapshot,
  type PrivateSnapshotSigningKey,
  type SignedPrivateHandSnapshot,
} from './private-hand-snapshot.js';
import type { VerifiedPrivateHandRecovery } from './private-hand-snapshot.js';

type PlayerInput = {
  id: string;
  displayName: string;
  initialStack: number;
};

type CreateRoomInput = {
  status: RoomStatus;
  host: PlayerInput;
  players?: PlayerInput[];
};

type PlayerWriter = Pick<PrismaClient, 'player'>;

const MAX_ACCESS_TOKEN_ATTEMPTS = 5;
const MAX_ROOM_PLAYERS = 9;

function isAccessTokenHashCollision(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'P2002') return false;
  const target = 'meta' in error && error.meta !== null && typeof error.meta === 'object' && 'target' in error.meta
    ? error.meta.target
    : undefined;
  return Array.isArray(target)
    ? target.includes('accessTokenHash')
    : typeof target === 'string' && target.includes('accessTokenHash');
}

const publicPlayerSelect = {
  id: true,
  roomId: true,
  displayName: true,
  initialStack: true,
  currentStack: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PlayerSelect;

const roomWithPlayers = {
  players: { orderBy: { createdAt: 'asc' }, select: publicPlayerSelect },
} satisfies Prisma.RoomInclude;

export type RoomJoinIdFactory = () => string;

export type GameStartEvent = Readonly<{
  dealerSeat: number;
  smallBlind: number;
  bigBlind: number;
}>;

export type StartGameAtomicallyInput = Readonly<{
  joinId: string;
  hostPlayerId: string;
  /** Authenticated server-only recovery state. Never send this through a socket. */
  snapshot: SignedPrivateHandSnapshot;
  /** Deliberately small public audit metadata; cards and deck state do not belong here. */
  event: unknown;
}>;

function isBoundInitialPrivateSnapshot(snapshot: SignedPrivateHandSnapshot, roomId: string): boolean {
  return snapshot.version === 1
    && snapshot.roomId === roomId
    && snapshot.sequence === 0
    && typeof snapshot.keyId === 'string'
    && typeof snapshot.signature === 'string'
    && /^[a-f0-9]{64}$/i.test(snapshot.signature);
}

function publicGameStartEvent(event: unknown): GameStartEvent {
  if (!event || typeof event !== 'object') throw new Error('Invalid game-start event');
  const { dealerSeat, smallBlind, bigBlind } = event as Record<string, unknown>;
  if (![dealerSeat, smallBlind, bigBlind].every((value) => Number.isSafeInteger(value) && (value as number) > 0)) {
    throw new Error('Invalid game-start event');
  }
  return { dealerSeat: dealerSeat as number, smallBlind: smallBlind as number, bigBlind: bigBlind as number };
}

export class RoomRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly createJoinId: RoomJoinIdFactory = createRoomJoinId,
    private readonly createAccessToken: PlayerAccessTokenFactory = createPlayerAccessToken,
    private readonly hashAccessToken: PlayerAccessTokenHasher = hashPlayerAccessToken,
    private readonly privateSnapshotKeyring: ReadonlyMap<string, PrivateSnapshotSigningKey> = new Map(),
  ) {}

  private async createPlayerWithUniqueAccessToken(db: PlayerWriter, player: PlayerInput, roomId: string) {
    for (let attempt = 0; attempt < MAX_ACCESS_TOKEN_ATTEMPTS; attempt += 1) {
      const accessToken = this.createAccessToken();
      try {
        const persistedPlayer = await db.player.create({
          data: {
            id: player.id,
            displayName: player.displayName,
            initialStack: player.initialStack,
            currentStack: player.initialStack,
            accessTokenHash: this.hashAccessToken(accessToken).toString('hex'),
            roomId,
          },
        });
        return { player: persistedPlayer, accessToken };
      } catch (error) {
        if (!isAccessTokenHashCollision(error) || attempt === MAX_ACCESS_TOKEN_ATTEMPTS - 1) throw error;
      }
    }
    throw new Error('Unable to create player access token');
  }

  async createRoom({ status, host, players = [] }: CreateRoomInput) {
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.create({
        data: { id: randomUUID(), joinId: this.createJoinId(), status },
      });
      const persistedHost = await this.createPlayerWithUniqueAccessToken(tx, host, room.id);
      await Promise.all(players.map((player) => this.createPlayerWithUniqueAccessToken(tx, player, room.id)));
      const persistedRoom = await tx.room.update({
        where: { id: room.id },
        data: { hostPlayerId: host.id },
        include: roomWithPlayers,
      });
      return { ...persistedRoom, hostAccessToken: persistedHost.accessToken };
    });
  }

  async joinWaitingRoom(joinId: string, player: PlayerInput) {
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({ where: { joinId } });
      if (!room) return { kind: 'not-found' as const };
      const lockedRoom = await tx.room.updateMany({
        where: { id: room.id, status: 'WAITING' },
        data: { updatedAt: new Date() },
      });
      if (lockedRoom.count !== 1) return { kind: 'not-joinable' as const };

      const playerCount = await tx.player.count({ where: { roomId: room.id } });
      if (playerCount >= MAX_ROOM_PLAYERS) return { kind: 'full' as const };

      const createdPlayer = await this.createPlayerWithUniqueAccessToken(tx, player, room.id);
      const persistedRoom = await tx.room.findUniqueOrThrow({
        where: { id: room.id },
        include: roomWithPlayers,
      });
      return { kind: 'joined' as const, room: persistedRoom, playerAccessToken: createdPlayer.accessToken };
    });
  }

  async findRoomByJoinId(joinId: string) {
    return this.db.room.findUnique({
      where: { joinId },
      include: roomWithPlayers,
    });
  }

  async findPlayerByRoomJoinIdAndAccessToken(joinId: string, accessToken: unknown) {
    if (!isValidPlayerAccessToken(accessToken)) return null;

    const accessTokenHash = this.hashAccessToken(accessToken);
    const room = await this.db.room.findUnique({
      where: { joinId },
      select: {
        players: {
          select: { ...publicPlayerSelect, accessTokenHash: true },
        },
      },
    });
    if (!room) return null;

    const player = room.players.find((candidate) => {
      const candidateHash = Buffer.from(candidate.accessTokenHash, 'hex');
      return candidateHash.length === accessTokenHash.length && timingSafeEqual(candidateHash, accessTokenHash);
    });
    if (!player) return null;

    return {
      id: player.id,
      roomId: player.roomId,
      displayName: player.displayName,
      initialStack: player.initialStack,
      currentStack: player.currentStack,
      createdAt: player.createdAt,
      updatedAt: player.updatedAt,
    };
  }

  /**
   * Makes room state durable before a hand can be exposed to a transport.
   * The guarded status update is the concurrency gate: only the persisted host
   * can turn one WAITING room into IN_PROGRESS, and event/snapshot writes share
   * that transaction so a failed write rolls the status change back.
   */
  async startGameAtomically({ joinId, hostPlayerId, snapshot, event }: StartGameAtomicallyInput) {
    const publicEvent = publicGameStartEvent(event);
    return this.db.$transaction(async (tx) => {
      // Authenticate private state before the status claim; a forged envelope
      // must never mutate a room, even inside a transaction that later rolls back.
      const room = await tx.room.findUnique({
        where: { joinId },
        select: { id: true },
      });
      if (!room) throw new Error('Room is not startable by this host');
      const sequence = 0;
      if (!isBoundInitialPrivateSnapshot(snapshot, room.id)) throw new Error('Invalid game-start private snapshot');
      const recovery = hydrateSignedPrivateHandSnapshot(snapshot, { roomId: room.id, sequence }, this.privateSnapshotKeyring);
      const hand = recovery.hand;
      if (
        publicEvent.dealerSeat !== hand.dealerSeat
        || publicEvent.smallBlind !== hand.smallBlindAmount
        || publicEvent.bigBlind !== hand.bigBlindAmount
      ) {
        throw new Error('Game-start event does not match the authenticated private hand');
      }

      const claimed = await tx.room.updateMany({
        where: { joinId, hostPlayerId, status: 'WAITING' },
        data: { status: 'IN_PROGRESS' },
      });
      if (claimed.count !== 1) throw new Error('Room is not startable by this host');
      await tx.gameEvent.create({
        data: { roomId: room.id, sequence, type: 'GAME_STARTED', payload: publicEvent },
      });
      await tx.gameSnapshot.create({
        data: { roomId: room.id, sequence, state: snapshot as unknown as Prisma.InputJsonValue },
      });
      return { roomId: room.id, sequence };
    });
  }

  /** Server-only restart path, scoped to a participant proven by session auth. */
  async findLatestGameSnapshotForPlayer(roomId: string, playerId: string) {
    const snapshot = await this.db.gameSnapshot.findFirst({
      where: { roomId, room: { players: { some: { id: playerId } } } },
      orderBy: { sequence: 'desc' },
      select: { sequence: true, state: true },
    });
    return snapshot ? { sequence: snapshot.sequence, state: snapshot.state as unknown as SignedPrivateHandSnapshot } : null;
  }

  /**
   * Server-only restart boundary. A participant-scoped row is not authoritative
   * until its HMAC and its persisted room/sequence context both verify.
   */
  async recoverLatestHandForPlayer(roomId: string, playerId: string): Promise<{ sequence: number; recovery: VerifiedPrivateHandRecovery } | null> {
    const snapshot = await this.findLatestGameSnapshotForPlayer(roomId, playerId);
    if (!snapshot) return null;
    return {
      sequence: snapshot.sequence,
      recovery: hydrateSignedPrivateHandSnapshot(snapshot.state, { roomId, sequence: snapshot.sequence }, this.privateSnapshotKeyring),
    };
  }
}
