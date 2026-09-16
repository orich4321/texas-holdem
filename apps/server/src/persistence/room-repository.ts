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
import { signPrivateHandSnapshot } from './private-hand-snapshot.js';
import { ServerGameLifecycle, type PlayerAction, type ServerPlayerView } from '../game-lifecycle.js';
import { startServerHand } from '../hand-start.js';

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

export type PersistPlayerActionInput = Readonly<{
  roomId: string;
  /** Derived exclusively from an authenticated server session. */
  playerId: string;
  action: PlayerAction;
}>;

export type StartGameForHostInput = Readonly<{
  joinId: string;
  /** Derived exclusively from the authenticated host session. */
  hostPlayerId: string;
}>;

export type StartNextHandForHostInput = Readonly<{
  joinId: string;
  /** Derived exclusively from the authenticated host session. */
  hostPlayerId: string;
}>;

const DEFAULT_SMALL_BLIND = 5;
const DEFAULT_BIG_BLIND = 10;

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

function validatePersistedPlayerAction(action: unknown): asserts action is PlayerAction {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('Invalid player action');
  const record = action as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (typeof record.type !== 'string' || !['check', 'call', 'fold', 'all-in', 'raise'].includes(record.type)) throw new Error('Invalid player action');
  if (record.type === 'raise') {
    if (keys.length !== 2 || keys[0] !== 'raiseTo' || keys[1] !== 'type' || typeof record.raiseTo !== 'number' || !Number.isSafeInteger(record.raiseTo) || record.raiseTo < 0) throw new Error('Invalid player action');
    return;
  }
  if (keys.length !== 1 || keys[0] !== 'type') throw new Error('Invalid player action');
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

  /**
   * The production game-start path. Seat order, stakes, shuffle, private
   * snapshot, and public metadata are all derived on the server; the browser
   * supplies only its authenticated host identity.
   */
  async startGameForHostAtomically({ joinId, hostPlayerId }: StartGameForHostInput) {
    const activeKey = this.privateSnapshotKeyring.entries().next().value as [string, PrivateSnapshotSigningKey] | undefined;
    if (!activeKey) throw new Error('Room is not startable by this host');
    const [keyId, key] = activeKey;

    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({
        where: { joinId },
        select: {
          id: true,
          hostPlayerId: true,
          status: true,
          players: { orderBy: { createdAt: 'asc' }, select: { id: true, currentStack: true } },
        },
      });
      if (!room || room.hostPlayerId !== hostPlayerId || room.status !== 'WAITING' || room.players.length < 2) {
        throw new Error('Room is not startable by this host');
      }

      // Claim the waiting room before dealing. PostgreSQL serializes matching
      // updates, so a concurrent start cannot produce a second deck or hand.
      const claimed = await tx.room.updateMany({
        where: { id: room.id, hostPlayerId, status: 'WAITING' },
        data: { status: 'IN_PROGRESS' },
      });
      if (claimed.count !== 1) throw new Error('Room is not startable by this host');

      const hand = startServerHand({
        seats: room.players.map((player, index) => ({
          seatNumber: index + 1,
          playerId: player.id,
          stack: player.currentStack,
        })),
        dealerSeat: 1,
        smallBlind: DEFAULT_SMALL_BLIND,
        bigBlind: DEFAULT_BIG_BLIND,
      });
      const sequence = 0;
      const event = Object.freeze({
        dealerSeat: hand.dealerSeat,
        smallBlind: hand.smallBlindAmount,
        bigBlind: hand.bigBlindAmount,
      });
      const snapshot = signPrivateHandSnapshot(hand, { roomId: room.id, sequence, keyId }, key);
      await tx.gameEvent.create({ data: { roomId: room.id, sequence, type: 'GAME_STARTED', payload: event } });
      await tx.gameSnapshot.create({ data: { roomId: room.id, sequence, state: snapshot as unknown as Prisma.InputJsonValue } });
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

  /**
   * Builds the sole player-safe projection used for reconnects. The signed
   * hand remains within the server boundary and is never returned to a socket.
   */
  async recoverLatestPlayerViewForPlayer(roomId: string, playerId: string): Promise<ServerPlayerView | null> {
    const room = await this.db.room.findFirst({
      where: { id: roomId, status: 'IN_PROGRESS', players: { some: { id: playerId } } },
      select: {
        players: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, displayName: true, currentStack: true },
        },
      },
    });
    if (!room) return null;

    const latest = await this.recoverLatestHandForPlayer(roomId, playerId);
    if (!latest) return null;
    const hand = latest.recovery.hand;
    const lifecycle = ServerGameLifecycle.fromVerifiedRecoveredHand({
      seats: room.players.map((player, index) => ({
        seatNumber: index + 1,
        playerId: player.id,
        playerName: player.displayName,
        stack: player.currentStack,
      })),
      dealerSeat: hand.dealerSeat,
      smallBlind: hand.smallBlindAmount,
      bigBlind: hand.bigBlindAmount,
    }, latest.recovery);
    return lifecycle.viewFor(playerId);
  }

  /** Applies an authenticated action to the latest verified state and commits its successor atomically. */
  async persistPlayerActionAtomically({ roomId, playerId, action }: PersistPlayerActionInput) {
    validatePersistedPlayerAction(action);
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({
        where: { id: roomId },
        select: { status: true, players: { orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true, currentStack: true } } },
      });
      if (!room || room.status !== 'IN_PROGRESS' || !room.players.some((player) => player.id === playerId)) throw new Error('Game action is unavailable');

      // PostgreSQL obtains a row lock for this otherwise no-op update. Reading
      // the latest snapshot only after that lock means two accepted actions
      // cannot both calculate the same successor sequence.
      const locked = await tx.room.updateMany({
        where: { id: roomId, status: 'IN_PROGRESS' },
        data: { updatedAt: new Date() },
      });
      if (locked.count !== 1) throw new Error('Game action is unavailable');
      const latest = await tx.gameSnapshot.findFirst({
        where: { roomId }, orderBy: { sequence: 'desc' }, select: { sequence: true, state: true },
      });
      if (!latest) throw new Error('Game action is unavailable');
      const recovery = hydrateSignedPrivateHandSnapshot(latest.state as unknown as SignedPrivateHandSnapshot, { roomId, sequence: latest.sequence }, this.privateSnapshotKeyring);
      const hand = recovery.hand;
      const lifecycle = ServerGameLifecycle.fromVerifiedRecoveredHand({
        seats: room.players.map((player, index) => ({ seatNumber: index + 1, playerId: player.id, playerName: player.displayName, stack: player.currentStack })),
        dealerSeat: hand.dealerSeat, smallBlind: hand.smallBlindAmount, bigBlind: hand.bigBlindAmount,
      }, recovery);
      const view = lifecycle.applyAction(playerId, action);
      const settlement = lifecycle.handForDurableSnapshot().street === 'showdown'
        ? lifecycle.showdownSettlement()
        : undefined;
      if (settlement) {
        await Promise.all(settlement.seats.map((seat) => tx.player.update({
          where: { id: seat.playerId }, data: { currentStack: seat.stack },
        })));
        await tx.settlement.create({
          data: {
            roomId,
            idempotencyKey: `hand-${latest.sequence}`,
            result: {
              pots: settlement.pots.map((pot) => ({ amount: pot.amount, winnerSeatNumbers: [...pot.winnerSeatNumbers] })),
              uncalledReturns: settlement.uncalledReturns.map((returned) => ({ ...returned })),
              stacks: settlement.seats.map((seat) => ({ seatNumber: seat.seatNumber, playerId: seat.playerId, stack: seat.stack })),
            } as Prisma.InputJsonValue,
          },
        });
      }
      const views = Object.freeze(room.players.map((player) => lifecycle.viewFor(player.id)));
      const sequence = latest.sequence + 1;
      const activeKey = this.privateSnapshotKeyring.entries().next().value as [string, PrivateSnapshotSigningKey] | undefined;
      if (!activeKey) throw new Error('Game action is unavailable');
      const [keyId, key] = activeKey;
      const snapshot = signPrivateHandSnapshot(lifecycle.handForDurableSnapshot(), { roomId, sequence, keyId }, key);
      const publicAction = action.type === 'raise' ? { type: 'raise' as const, raiseTo: action.raiseTo } : { type: action.type };
      await tx.gameEvent.create({ data: { roomId, sequence, type: 'PLAYER_ACTION', payload: { actorPlayerId: playerId, action: publicAction } } });
      await tx.gameSnapshot.create({ data: { roomId, sequence, state: snapshot as unknown as Prisma.InputJsonValue } });
      return { sequence, view, views };
    });
  }

  /**
   * Starts the next hand only after the prior showdown has been settled. The
   * same transaction stores the durable chip totals, rotates the dealer, and
   * signs the successor hand before any client can see it.
   */
  async startNextHandForHostAtomically({ joinId, hostPlayerId }: StartNextHandForHostInput) {
    const activeKey = this.privateSnapshotKeyring.entries().next().value as [string, PrivateSnapshotSigningKey] | undefined;
    if (!activeKey) throw new Error('Next hand is unavailable');
    const [keyId, key] = activeKey;

    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({ where: { joinId }, select: { id: true, hostPlayerId: true, status: true } });
      if (!room || room.hostPlayerId !== hostPlayerId || room.status !== 'IN_PROGRESS') throw new Error('Next hand is unavailable');
      const locked = await tx.room.updateMany({ where: { id: room.id, hostPlayerId, status: 'IN_PROGRESS' }, data: { updatedAt: new Date() } });
      if (locked.count !== 1) throw new Error('Next hand is unavailable');
      const lockedRoom = await tx.room.findUnique({
        where: { id: room.id },
        select: { players: { orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true, currentStack: true } } },
      });
      const latest = await tx.gameSnapshot.findFirst({ where: { roomId: room.id }, orderBy: { sequence: 'desc' }, select: { sequence: true, state: true } });
      if (!lockedRoom || !latest) throw new Error('Next hand is unavailable');
      const recovery = hydrateSignedPrivateHandSnapshot(latest.state as unknown as SignedPrivateHandSnapshot, { roomId: room.id, sequence: latest.sequence }, this.privateSnapshotKeyring);
      const lifecycle = ServerGameLifecycle.fromVerifiedRecoveredHand({
        seats: lockedRoom.players.map((player, index) => ({ seatNumber: index + 1, playerId: player.id, playerName: player.displayName, stack: player.currentStack })),
        dealerSeat: recovery.hand.dealerSeat,
        smallBlind: recovery.hand.smallBlindAmount,
        bigBlind: recovery.hand.bigBlindAmount,
      }, recovery);
      const settlement = lifecycle.showdownSettlement();
      const settledStacks = new Map(settlement.seats.map((seat) => [seat.playerId, seat.stack]));
      await Promise.all(settlement.seats.map((seat) => tx.player.update({ where: { id: seat.playerId }, data: { currentStack: seat.stack } })));

      const seatNumbers = recovery.hand.seats.map((seat) => seat.seatNumber);
      const dealerIndex = seatNumbers.indexOf(recovery.hand.dealerSeat);
      const nextDealerSeat = Array.from({ length: seatNumbers.length }, (_, offset) => seatNumbers[(dealerIndex + offset + 1) % seatNumbers.length])
        .find((seatNumber) => (settledStacks.get(recovery.hand.seats.find((seat) => seat.seatNumber === seatNumber)!.playerId) ?? 0) > 0);
      if (!nextDealerSeat) throw new Error('Next hand is unavailable');
      const hand = startServerHand({
        seats: lockedRoom.players.map((player, index) => ({
          seatNumber: index + 1,
          playerId: player.id,
          stack: settledStacks.get(player.id) ?? player.currentStack,
        })),
        dealerSeat: nextDealerSeat,
        smallBlind: recovery.hand.smallBlindAmount,
        bigBlind: recovery.hand.bigBlindAmount,
      });
      const sequence = latest.sequence + 1;
      const snapshot = signPrivateHandSnapshot(hand, { roomId: room.id, sequence, keyId }, key);
      await tx.gameEvent.create({
        data: { roomId: room.id, sequence, type: 'HAND_STARTED', payload: { dealerSeat: hand.dealerSeat, smallBlind: hand.smallBlindAmount, bigBlind: hand.bigBlindAmount } },
      });
      await tx.gameSnapshot.create({ data: { roomId: room.id, sequence, state: snapshot as unknown as Prisma.InputJsonValue } });
      return { roomId: room.id, sequence };
    });
  }
}
