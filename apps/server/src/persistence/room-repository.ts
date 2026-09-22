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
import { ServerGameLifecycle, type PlayerAction, type PlayerActionNotification, type ServerPlayerView } from '../game-lifecycle.js';
import { startServerHand } from '../hand-start.js';

type PlayerInput = {
  id: string;
  displayName: string;
  avatarDataUrl?: string;
  initialStack: number;
};

export type RoomGameSettings = Readonly<{
  initialStack: number;
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
}>;

type CreateRoomInput = {
  status: RoomStatus;
  host: PlayerInput;
  players?: PlayerInput[];
  settings?: RoomGameSettings;
};

type PlayerWriter = Pick<PrismaClient, 'player'>;

const MAX_ACCESS_TOKEN_ATTEMPTS = 5;
const MAX_CHIP_ADJUSTMENT = 1_000_000;
const DEFAULT_ROOM_SETTINGS: RoomGameSettings = Object.freeze({ initialStack: 500, smallBlind: 1, bigBlind: 2, maxPlayers: 9 });

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
  avatarDataUrl: true,
  initialStack: true,
  currentStack: true,
  leftAt: true,
  leaveAfterHand: true,
  isSittingOut: true,
  rebuyDecisionPending: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PlayerSelect;

const roomWithPlayers = {
  players: { where: { leftAt: null }, orderBy: { createdAt: 'asc' }, select: publicPlayerSelect },
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
  clientActionId?: string;
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
  /** Required only when reopening a completed final hand. */
  finalHand?: boolean;
}>;

export type AdvanceAllInRunoutForHostInput = Readonly<{
  joinId: string;
  hostPlayerId: string;
}>;

export type RemovePlayerForHostInput = Readonly<{
  joinId: string;
  hostPlayerId: string;
  targetPlayerId: string;
}>;

export type HostManagementView = Readonly<{
  smallBlind: number;
  bigBlind: number;
  nextHandIsFinal: boolean;
  players: readonly Readonly<{
    id: string;
    displayName: string;
    currentStack: number;
    isHost: boolean;
    leaveAfterHand: boolean;
    pendingChips: number;
    isSittingOut: boolean;
    rebuyDecisionPending: boolean;
  }>[];
}>;

export type RevealShowdownHandInput = Readonly<{
  roomId: string;
  playerId: string;
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

function actionNotificationFromEvent(
  event: { sequence: number; payload: unknown } | undefined,
  players: readonly { id: string; displayName: string; avatarDataUrl: string | null }[],
): PlayerActionNotification | undefined {
  if (!event || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return undefined;
  const payload = event.payload as Record<string, unknown>;
  const actor = typeof payload.actorPlayerId === 'string' ? players.find((player) => player.id === payload.actorPlayerId) : undefined;
  if (!actor) return undefined;
  try {
    validatePersistedPlayerAction(payload.action);
  } catch {
    return undefined;
  }
  const amount = Number.isSafeInteger(payload.amount) && (payload.amount as number) >= 0 ? payload.amount as number : undefined;
  return Object.freeze({
    sequence: event.sequence,
    actorPlayerId: actor.id,
    actorPlayerName: actor.displayName,
    ...(actor.avatarDataUrl ? { avatarDataUrl: actor.avatarDataUrl } : {}),
    action: Object.freeze({ ...payload.action }),
    ...(amount !== undefined ? { amount } : {}),
  });
}

export class RoomRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly createJoinId: RoomJoinIdFactory = createRoomJoinId,
    private readonly createAccessToken: PlayerAccessTokenFactory = createPlayerAccessToken,
    private readonly hashAccessToken: PlayerAccessTokenHasher = hashPlayerAccessToken,
    private readonly privateSnapshotKeyring: ReadonlyMap<string, PrivateSnapshotSigningKey> = new Map(),
  ) {}

  private decorateView(view: ServerPlayerView, sequence: number, hostPlayerId: string, gameCompleted = false, finalSummaryVisible = false, lastAction?: PlayerActionNotification): ServerPlayerView {
    return Object.freeze({ ...view, sequence, hostPlayerId, gameCompleted, finalSummaryVisible, ...(lastAction ? { lastAction } : {}) });
  }

  private async createPlayerWithUniqueAccessToken(db: PlayerWriter, player: PlayerInput, roomId: string) {
    for (let attempt = 0; attempt < MAX_ACCESS_TOKEN_ATTEMPTS; attempt += 1) {
      const accessToken = this.createAccessToken();
      try {
        const persistedPlayer = await db.player.create({
          data: {
            id: player.id,
            displayName: player.displayName,
            avatarDataUrl: player.avatarDataUrl,
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

  async createRoom({ status, host, players = [], settings = DEFAULT_ROOM_SETTINGS }: CreateRoomInput) {
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.create({
        data: { id: randomUUID(), joinId: this.createJoinId(), status, ...settings },
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

  async joinWaitingRoom(joinId: string, player: Omit<PlayerInput, 'initialStack'>) {
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({ where: { joinId } });
      if (!room) return { kind: 'not-found' as const };
      const lockedRoom = await tx.room.updateMany({
        where: { id: room.id, status: { in: ['WAITING', 'IN_PROGRESS'] } },
        data: { updatedAt: new Date() },
      });
      if (lockedRoom.count !== 1) return { kind: 'not-joinable' as const };

      // Joining never mutates the signed roster of the hand in progress. A
      // late player receives a durable seat now, waits on GAME_NOT_AVAILABLE,
      // and is included only when the host deals the next hand.

      const playerCount = await tx.player.count({ where: { roomId: room.id, leftAt: null, isSittingOut: false } });
      if (playerCount >= room.maxPlayers) return { kind: 'full' as const };

      const createdPlayer = await this.createPlayerWithUniqueAccessToken(tx, { ...player, initialStack: room.initialStack }, room.id);
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
        hostPlayerId: true,
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
    if (!player || player.leftAt) return null;

    return {
      id: player.id,
      roomId: player.roomId,
      displayName: player.displayName,
      avatarDataUrl: player.avatarDataUrl,
      initialStack: player.initialStack,
      currentStack: player.currentStack,
      createdAt: player.createdAt,
      updatedAt: player.updatedAt,
    };
  }

  /** A removed device cannot silently create a second seat by reusing its old cookie. */
  async hasExistingPlayerSessionInRoom(joinId: string, accessToken: unknown): Promise<boolean> {
    if (!isValidPlayerAccessToken(accessToken)) return false;
    const accessTokenHash = this.hashAccessToken(accessToken);
    const room = await this.db.room.findUnique({
      where: { joinId },
      select: { players: { select: { accessTokenHash: true } } },
    });
    return Boolean(room?.players.some((candidate) => {
      const candidateHash = Buffer.from(candidate.accessTokenHash, 'hex');
      return candidateHash.length === accessTokenHash.length && timingSafeEqual(candidateHash, accessTokenHash);
    }));
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
          smallBlind: true,
          bigBlind: true,
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
        smallBlind: room.smallBlind,
        bigBlind: room.bigBlind,
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
    // The room projection and signed snapshot are independent reads. Running
    // them together removes a full database round trip from every live-state
    // refresh while each query still scopes itself to the participant.
    const [room, latest] = await Promise.all([
      this.db.room.findFirst({
        where: { id: roomId, status: { in: ['IN_PROGRESS', 'COMPLETED'] }, players: { some: { id: playerId, leftAt: null } } },
        select: {
          status: true,
          hostPlayerId: true,
          finalSummaryVisible: true,
          players: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, displayName: true, avatarDataUrl: true, currentStack: true, isSittingOut: true },
          },
          events: {
            where: { type: 'PLAYER_ACTION' },
            orderBy: { sequence: 'desc' },
            take: 1,
            select: { sequence: true, payload: true },
          },
        },
      }),
      this.recoverLatestHandForPlayer(roomId, playerId),
    ]);
    if (!room || !latest) return null;
    const hand = latest.recovery.hand;
    // A participant who joined during an active hand waits for the next hand;
    // their session is valid, but no private cards exist in the current hand.
    const seatedInHand = hand.seats.some((seat) => seat.playerId === playerId);
    const member = room.players.find((player) => player.id === playerId);
    if (!seatedInHand && member?.currentStack !== 0 && !member?.isSittingOut) return null;
    const playersById = new Map(room.players.map((player) => [player.id, player]));
    const lifecycle = ServerGameLifecycle.fromVerifiedRecoveredHand({
      seats: hand.seats.map((seat) => {
        const player = playersById.get(seat.playerId);
        if (!player) throw new Error('Game state is unavailable');
        return {
          seatNumber: seat.seatNumber,
          playerId: player.id,
          playerName: player.displayName,
          avatarDataUrl: player.avatarDataUrl ?? undefined,
          stack: player.currentStack,
        };
      }),
      dealerSeat: hand.dealerSeat,
      smallBlind: hand.smallBlindAmount,
      bigBlind: hand.bigBlindAmount,
    }, latest.recovery);
    if (!room.hostPlayerId) return null;
    const baseView = lifecycle.viewFor(seatedInHand ? playerId : hand.seats[0].playerId);
    const safeView = seatedInHand
      ? { ...baseView, isSittingOut: member?.isSittingOut ?? false }
      : { ...baseView, playerId, holeCards: [] as const, toCall: 0, raise: undefined, isSittingOut: true };
    const latestAction = room.events[0]?.sequence === latest.sequence
      ? actionNotificationFromEvent(room.events[0], room.players)
      : undefined;
    return this.decorateView(safeView, latest.sequence, room.hostPlayerId, room.status === 'COMPLETED', room.status === 'COMPLETED' && room.finalSummaryVisible, latestAction);
  }

  /** Applies an authenticated action to the latest verified state and commits its successor atomically. */
  async persistPlayerActionAtomically({ roomId, playerId, action, clientActionId }: PersistPlayerActionInput) {
    validatePersistedPlayerAction(action);
    if (clientActionId !== undefined && !/^[0-9a-f-]{36}$/i.test(clientActionId)) throw new Error('Invalid action identifier');
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({
        where: { id: roomId },
        select: { status: true, hostPlayerId: true, players: { orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true, avatarDataUrl: true, currentStack: true } } },
      });
      if (!room || !room.hostPlayerId || room.status !== 'IN_PROGRESS' || !room.players.some((player) => player.id === playerId)) throw new Error('Game action is unavailable');

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
      const playersById = new Map(room.players.map((player) => [player.id, player]));
      const lifecycle = ServerGameLifecycle.fromVerifiedRecoveredHand({
        seats: hand.seats.map((seat) => {
          const player = playersById.get(seat.playerId);
          if (!player) throw new Error('Game action is unavailable');
          return { seatNumber: seat.seatNumber, playerId: player.id, playerName: player.displayName, avatarDataUrl: player.avatarDataUrl ?? undefined, stack: player.currentStack };
        }),
        dealerSeat: hand.dealerSeat, smallBlind: hand.smallBlindAmount, bigBlind: hand.bigBlindAmount,
      }, recovery);
      if (clientActionId) {
        const duplicate = await tx.gameEvent.findFirst({
          where: { roomId, clientActionId, type: 'PLAYER_ACTION' },
          select: { sequence: true, payload: true },
        });
        if (duplicate) {
          const lastAction = duplicate.sequence === latest.sequence ? actionNotificationFromEvent(duplicate, room.players) : undefined;
          const views = Object.freeze(hand.seats.map((seat) => this.decorateView(lifecycle.viewFor(seat.playerId), latest.sequence, room.hostPlayerId!, false, false, lastAction)));
          return { sequence: latest.sequence, view: views.find((candidate) => candidate.playerId === playerId)!, views };
        }
      }
      const beforeAction = lifecycle.viewFor(playerId);
      const actorSeat = beforeAction.seats.find((seat) => seat.playerId === playerId);
      if (!actorSeat) throw new Error('Game action is unavailable');
      const actionAmount = action.type === 'call'
        ? Math.min(beforeAction.toCall, actorSeat.stack)
        : action.type === 'raise'
          ? action.raiseTo
          : action.type === 'all-in'
            ? actorSeat.currentBet + actorSeat.stack
            : undefined;
      const view = lifecycle.applyAction(playerId, action);
      let gameCompleted = false;
      const settledHand = lifecycle.handForDurableSnapshot();
      const settlement = settledHand.street === 'showdown'
        ? lifecycle.showdownSettlement()
        : undefined;
      if (settlement) {
        await Promise.all(settlement.seats.map((seat) => tx.player.update({
          where: { id: seat.playerId }, data: { currentStack: seat.stack, isSittingOut: seat.stack === 0, rebuyDecisionPending: seat.stack === 0 },
        })));
        await tx.settlement.create({
          data: {
            roomId,
            idempotencyKey: `hand-${latest.sequence}`,
            result: {
              pots: settlement.pots.map((pot) => ({ amount: pot.amount, winnerSeatNumbers: [...pot.winnerSeatNumbers] })),
              uncalledReturns: settlement.uncalledReturns.map((returned) => ({ ...returned })),
              winners: view.showdown?.winners.map((winner) => ({
                seatNumber: winner.seatNumber,
                playerId: winner.playerId,
                playerName: winner.playerName,
                chipsWon: winner.chipsWon,
              })) ?? [],
              board: settledHand.communityCards.map((card) => ({ ...card })),
              players: settledHand.seats.flatMap((seat) => seat.holeCards ? [{
                seatNumber: seat.seatNumber,
                playerId: seat.playerId,
                playerName: room.players.find((player) => player.id === seat.playerId)?.displayName ?? seat.playerId,
                folded: seat.isFolded,
                holeCards: seat.holeCards.map((card) => ({ ...card })),
              }] : []),
              stacks: settlement.seats.map((seat) => ({ seatNumber: seat.seatNumber, playerId: seat.playerId, stack: seat.stack })),
            } as Prisma.InputJsonValue,
          },
        });
        const handStart = await tx.gameEvent.findFirst({
          where: { roomId, type: { in: ['GAME_STARTED', 'HAND_STARTED', 'FINAL_HAND_STARTED'] }, sequence: { lte: latest.sequence } },
          orderBy: { sequence: 'desc' }, select: { type: true },
        });
        if (handStart?.type === 'FINAL_HAND_STARTED') {
          await tx.room.updateMany({ where: { id: roomId, status: 'IN_PROGRESS' }, data: { status: 'COMPLETED', finalSummaryVisible: false } });
          gameCompleted = true;
        }
      }
      const sequence = latest.sequence + 1;
      const publicAction = action.type === 'raise' ? { type: 'raise' as const, raiseTo: action.raiseTo } : { type: action.type };
      const publicActionPayload = { actorPlayerId: playerId, action: publicAction, ...(actionAmount !== undefined ? { amount: actionAmount } : {}) };
      const lastAction = actionNotificationFromEvent({ sequence, payload: publicActionPayload }, room.players);
      if (!lastAction) throw new Error('Game action is unavailable');
      const views = Object.freeze(settledHand.seats.map((seat) => this.decorateView(lifecycle.viewFor(seat.playerId), sequence, room.hostPlayerId!, gameCompleted, false, lastAction)));
      const activeKey = this.privateSnapshotKeyring.entries().next().value as [string, PrivateSnapshotSigningKey] | undefined;
      if (!activeKey) throw new Error('Game action is unavailable');
      const [keyId, key] = activeKey;
      const snapshot = signPrivateHandSnapshot(lifecycle.handForDurableSnapshot(), { roomId, sequence, keyId }, key);
      await tx.gameEvent.create({ data: { roomId, sequence, type: 'PLAYER_ACTION', payload: publicActionPayload, ...(clientActionId ? { clientActionId } : {}) } });
      await tx.gameSnapshot.create({ data: { roomId, sequence, state: snapshot as unknown as Prisma.InputJsonValue } });
      return { sequence, view: this.decorateView(view, sequence, room.hostPlayerId, gameCompleted, false, lastAction), views };
    });
  }

  /** Advances a fully all-in hand by one public board street under the host lock. */
  async advanceAllInRunoutForHostAtomically({ joinId, hostPlayerId }: AdvanceAllInRunoutForHostInput) {
    const activeKey = this.privateSnapshotKeyring.entries().next().value as [string, PrivateSnapshotSigningKey] | undefined;
    if (!activeKey) throw new Error('All-in board is unavailable');
    const [keyId, key] = activeKey;
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({
        where: { joinId },
        select: { id: true, hostPlayerId: true, status: true, players: { orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true, avatarDataUrl: true, currentStack: true } } },
      });
      if (!room || room.hostPlayerId !== hostPlayerId || room.status !== 'IN_PROGRESS') throw new Error('All-in board is unavailable');
      const locked = await tx.room.updateMany({ where: { id: room.id, hostPlayerId, status: 'IN_PROGRESS' }, data: { updatedAt: new Date() } });
      if (locked.count !== 1) throw new Error('All-in board is unavailable');
      const latest = await tx.gameSnapshot.findFirst({ where: { roomId: room.id }, orderBy: { sequence: 'desc' }, select: { sequence: true, state: true } });
      if (!latest) throw new Error('All-in board is unavailable');
      const recovery = hydrateSignedPrivateHandSnapshot(latest.state as unknown as SignedPrivateHandSnapshot, { roomId: room.id, sequence: latest.sequence }, this.privateSnapshotKeyring);
      const playersById = new Map(room.players.map((player) => [player.id, player]));
      const lifecycle = ServerGameLifecycle.fromVerifiedRecoveredHand({
        seats: recovery.hand.seats.map((seat) => {
          const player = playersById.get(seat.playerId);
          if (!player) throw new Error('All-in board is unavailable');
          return { seatNumber: seat.seatNumber, playerId: player.id, playerName: player.displayName, avatarDataUrl: player.avatarDataUrl ?? undefined, stack: player.currentStack };
        }),
        dealerSeat: recovery.hand.dealerSeat, smallBlind: recovery.hand.smallBlindAmount, bigBlind: recovery.hand.bigBlindAmount,
      }, recovery);
      lifecycle.advanceAllInRunout();
      const hand = lifecycle.handForDurableSnapshot();
      const settlement = hand.street === 'showdown' ? lifecycle.showdownSettlement() : undefined;
      let gameCompleted = false;
      if (settlement) {
        const showdown = lifecycle.viewFor(hand.seats[0].playerId).showdown;
        await Promise.all(settlement.seats.map((seat) => tx.player.update({ where: { id: seat.playerId }, data: { currentStack: seat.stack, isSittingOut: seat.stack === 0, rebuyDecisionPending: seat.stack === 0 } })));
        await tx.settlement.create({
          data: {
            roomId: room.id,
            idempotencyKey: `hand-${latest.sequence}`,
            result: {
              pots: settlement.pots.map((pot) => ({ amount: pot.amount, winnerSeatNumbers: [...pot.winnerSeatNumbers] })),
              uncalledReturns: settlement.uncalledReturns.map((returned) => ({ ...returned })),
              winners: showdown?.winners.map((winner) => ({
                seatNumber: winner.seatNumber,
                playerId: winner.playerId,
                playerName: winner.playerName,
                chipsWon: winner.chipsWon,
              })) ?? [],
              board: hand.communityCards.map((card) => ({ ...card })),
              players: hand.seats.flatMap((seat) => seat.holeCards ? [{
                seatNumber: seat.seatNumber,
                playerId: seat.playerId,
                playerName: room.players.find((player) => player.id === seat.playerId)?.displayName ?? seat.playerId,
                folded: seat.isFolded,
                holeCards: seat.holeCards.map((card) => ({ ...card })),
              }] : []),
              stacks: settlement.seats.map((seat) => ({ seatNumber: seat.seatNumber, playerId: seat.playerId, stack: seat.stack })),
            } as Prisma.InputJsonValue,
          },
        });
        const handStart = await tx.gameEvent.findFirst({
          where: { roomId: room.id, type: { in: ['GAME_STARTED', 'HAND_STARTED', 'FINAL_HAND_STARTED'] }, sequence: { lte: latest.sequence } },
          orderBy: { sequence: 'desc' }, select: { type: true },
        });
        if (handStart?.type === 'FINAL_HAND_STARTED') {
          await tx.room.updateMany({ where: { id: room.id, status: 'IN_PROGRESS' }, data: { status: 'COMPLETED', finalSummaryVisible: false } });
          gameCompleted = true;
        }
      }
      const sequence = latest.sequence + 1;
      const snapshot = signPrivateHandSnapshot(hand, { roomId: room.id, sequence, keyId }, key);
      await tx.gameEvent.create({ data: { roomId: room.id, sequence, type: 'ALL_IN_RUNOUT_ADVANCED', payload: { street: hand.street } } });
      await tx.gameSnapshot.create({ data: { roomId: room.id, sequence, state: snapshot as unknown as Prisma.InputJsonValue } });
      return { sequence, views: Object.freeze(hand.seats.map((seat) => this.decorateView(lifecycle.viewFor(seat.playerId), sequence, room.hostPlayerId!, gameCompleted))) };
    });
  }

  /** Persists a player's voluntary showdown reveal without trusting client cards. */
  async revealShowdownHandAtomically({ roomId, playerId }: RevealShowdownHandInput) {
    const activeKey = this.privateSnapshotKeyring.entries().next().value as [string, PrivateSnapshotSigningKey] | undefined;
    if (!activeKey) throw new Error('Showdown reveal is unavailable');
    const [keyId, key] = activeKey;
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({
        where: { id: roomId },
        select: { status: true, hostPlayerId: true, finalSummaryVisible: true, players: { orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true, avatarDataUrl: true, currentStack: true } } },
      });
      if (!room || !room.hostPlayerId || (room.status !== 'IN_PROGRESS' && (room.status !== 'COMPLETED' || room.finalSummaryVisible)) || !room.players.some((player) => player.id === playerId)) throw new Error('Showdown reveal is unavailable');
      const locked = await tx.room.updateMany({ where: { id: roomId, status: room.status }, data: { updatedAt: new Date() } });
      if (locked.count !== 1) throw new Error('Showdown reveal is unavailable');
      const latest = await tx.gameSnapshot.findFirst({ where: { roomId }, orderBy: { sequence: 'desc' }, select: { sequence: true, state: true } });
      if (!latest) throw new Error('Showdown reveal is unavailable');
      const recovery = hydrateSignedPrivateHandSnapshot(latest.state as unknown as SignedPrivateHandSnapshot, { roomId, sequence: latest.sequence }, this.privateSnapshotKeyring);
      const playersById = new Map(room.players.map((player) => [player.id, player]));
      const lifecycle = ServerGameLifecycle.fromVerifiedRecoveredHand({
        seats: recovery.hand.seats.map((seat) => {
          const player = playersById.get(seat.playerId);
          if (!player) throw new Error('Showdown reveal is unavailable');
          return { seatNumber: seat.seatNumber, playerId: player.id, playerName: player.displayName, avatarDataUrl: player.avatarDataUrl ?? undefined, stack: player.currentStack };
        }),
        dealerSeat: recovery.hand.dealerSeat, smallBlind: recovery.hand.smallBlindAmount, bigBlind: recovery.hand.bigBlindAmount,
      }, recovery);
      const view = lifecycle.revealShowdownHand(playerId);
      const sequence = latest.sequence + 1;
      const snapshot = signPrivateHandSnapshot(lifecycle.handForDurableSnapshot(), { roomId, sequence, keyId }, key);
      await tx.gameEvent.create({ data: { roomId, sequence, type: 'SHOWDOWN_HAND_REVEALED', payload: { playerId } } });
      await tx.gameSnapshot.create({ data: { roomId, sequence, state: snapshot as unknown as Prisma.InputJsonValue } });
      return {
        sequence,
        view: this.decorateView(view, sequence, room.hostPlayerId, room.status === 'COMPLETED', room.finalSummaryVisible),
        views: Object.freeze(recovery.hand.seats.map((seat) => this.decorateView(lifecycle.viewFor(seat.playerId), sequence, room.hostPlayerId!, room.status === 'COMPLETED', room.finalSummaryVisible))),
      };
    });
  }

  /** Releases the completed game's summary only when its authenticated host asks. */
  async revealFinalSummaryForHost(joinId: string, hostPlayerId: string) {
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findFirst({ where: { joinId, hostPlayerId, status: 'COMPLETED', finalSummaryVisible: false }, select: { id: true } });
      if (!room) throw new Error('Final summary release is unavailable');
      const updated = await tx.room.updateMany({
        where: { id: room.id, hostPlayerId, status: 'COMPLETED', finalSummaryVisible: false },
        data: { finalSummaryVisible: true },
      });
      if (updated.count !== 1) throw new Error('Final summary release is unavailable');
      await tx.chipAdjustment.updateMany({ where: { roomId: room.id, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await tx.player.updateMany({ where: { roomId: room.id, currentStack: 0, leftAt: null }, data: { isSittingOut: true, rebuyDecisionPending: false } });
      return { finalSummaryVisible: true };
    });
  }

  /**
   * Starts the next hand only after the prior showdown has been settled. The
   * same transaction stores the durable chip totals, rotates the dealer, and
   * signs the successor hand before any client can see it.
   */
  async startNextHandForHostAtomically({ joinId, hostPlayerId, finalHand }: StartNextHandForHostInput) {
    const activeKey = this.privateSnapshotKeyring.entries().next().value as [string, PrivateSnapshotSigningKey] | undefined;
    if (!activeKey) throw new Error('Next hand is unavailable');
    const [keyId, key] = activeKey;

    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({ where: { joinId }, select: { id: true, hostPlayerId: true, status: true, finalSummaryVisible: true } });
      const continuingCompleted = room?.status === 'COMPLETED' && room.finalSummaryVisible === false && typeof finalHand === 'boolean';
      if (!room || room.hostPlayerId !== hostPlayerId || !(continuingCompleted || (room.status === 'IN_PROGRESS' && finalHand === undefined))) throw new Error('Next hand is unavailable');
      const locked = await tx.room.updateMany({
        where: { id: room.id, hostPlayerId, status: room.status, ...(continuingCompleted ? { finalSummaryVisible: false } : {}) },
        data: { updatedAt: new Date() },
      });
      if (locked.count !== 1) throw new Error('Next hand is unavailable');
      const lockedRoom = await tx.room.findUnique({
        where: { id: room.id },
        select: {
          smallBlind: true,
          bigBlind: true,
          nextHandIsFinal: true,
          players: { where: { leftAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true, currentStack: true, leaveAfterHand: true, isSittingOut: true, rebuyDecisionPending: true } },
          chipAdjustments: { where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } },
        },
      });
      const latest = await tx.gameSnapshot.findFirst({ where: { roomId: room.id }, orderBy: { sequence: 'desc' }, select: { sequence: true, state: true } });
      if (!lockedRoom || !latest) throw new Error('Next hand is unavailable');
      const nextHandIsFinal = continuingCompleted ? finalHand! : lockedRoom.nextHandIsFinal;
      const recovery = hydrateSignedPrivateHandSnapshot(latest.state as unknown as SignedPrivateHandSnapshot, { roomId: room.id, sequence: latest.sequence }, this.privateSnapshotKeyring);
      if (recovery.hand.street !== 'showdown') throw new Error('Next hand is unavailable');

      // A showdown is settled in the transaction that reached it, so these
      // are already authoritative chip totals.  Keeping that completed hand
      // intact lets the host safely remove a seat before this fresh deal.
      const leavingPlayerIds = new Set(lockedRoom.players.filter((player) => player.leaveAfterHand).map((player) => player.id));
      if (lockedRoom.players.some((player) => player.rebuyDecisionPending && !player.leaveAfterHand)) throw new Error('A rebuy decision is required');
      const activePlayers = lockedRoom.players.filter((player) => !leavingPlayerIds.has(player.id) && !player.isSittingOut);
      if (activePlayers.length < 2) throw new Error('Next hand is unavailable');
      const stacks = new Map(activePlayers.map((player) => [player.id, player.currentStack]));
      const appliedAt = new Date();
      for (const adjustment of lockedRoom.chipAdjustments) {
        if (leavingPlayerIds.has(adjustment.playerId)) {
          await tx.chipAdjustment.update({ where: { id: adjustment.id }, data: { status: 'CANCELLED', cancelledAt: appliedAt } });
          continue;
        }
        const before = stacks.get(adjustment.playerId);
        if (before === undefined || !Number.isSafeInteger(before + adjustment.amount)) throw new Error('Next hand is unavailable');
        const after = before + adjustment.amount;
        stacks.set(adjustment.playerId, after);
        await tx.player.update({ where: { id: adjustment.playerId }, data: { currentStack: after } });
        await tx.chipAdjustment.update({ where: { id: adjustment.id }, data: { status: 'APPLIED', stackBefore: before, stackAfter: after, appliedAt } });
      }
      if (leavingPlayerIds.size > 0) {
        await tx.player.updateMany({ where: { id: { in: [...leavingPlayerIds] } }, data: { leftAt: appliedAt, leaveAfterHand: false } });
      }

      const seatNumbers = recovery.hand.seats.map((seat) => seat.seatNumber);
      const dealerIndex = seatNumbers.indexOf(recovery.hand.dealerSeat);
      if (activePlayers.some((player) => (stacks.get(player.id) ?? 0) < 1)) throw new Error('Next hand is unavailable');
      const nextDealerPlayerId = Array.from({ length: seatNumbers.length }, (_, offset) => seatNumbers[(dealerIndex + offset + 1) % seatNumbers.length])
        .map((seatNumber) => recovery.hand.seats.find((seat) => seat.seatNumber === seatNumber)!.playerId)
        .find((playerId) => activePlayers.some((player) => player.id === playerId) && (stacks.get(playerId) ?? 0) > 0)
        ?? activePlayers.find((player) => (stacks.get(player.id) ?? 0) > 0)?.id;
      const nextDealerSeat = activePlayers.findIndex((player) => player.id === nextDealerPlayerId) + 1;
      if (!nextDealerPlayerId || nextDealerSeat < 1) throw new Error('Next hand is unavailable');
      const hand = startServerHand({
        seats: activePlayers.map((player, index) => ({
          seatNumber: index + 1,
          playerId: player.id,
          stack: stacks.get(player.id) ?? player.currentStack,
        })),
        dealerSeat: nextDealerSeat,
        smallBlind: lockedRoom.smallBlind,
        bigBlind: lockedRoom.bigBlind,
      });
      const sequence = latest.sequence + 1;
      const snapshot = signPrivateHandSnapshot(hand, { roomId: room.id, sequence, keyId }, key);
      await tx.gameEvent.create({
        data: {
          roomId: room.id,
          sequence,
          type: nextHandIsFinal ? 'FINAL_HAND_STARTED' : 'HAND_STARTED',
          payload: { dealerSeat: hand.dealerSeat, smallBlind: hand.smallBlindAmount, bigBlind: hand.bigBlindAmount },
        },
      });
      await tx.gameSnapshot.create({ data: { roomId: room.id, sequence, state: snapshot as unknown as Prisma.InputJsonValue } });
      if (continuingCompleted) {
        await tx.room.update({ where: { id: room.id }, data: { status: 'IN_PROGRESS', finalSummaryVisible: false, nextHandIsFinal: false } });
      } else if (lockedRoom.nextHandIsFinal) {
        await tx.room.update({ where: { id: room.id }, data: { nextHandIsFinal: false } });
      }
      return { roomId: room.id, sequence, finalHand: nextHandIsFinal };
    });
  }

  async getHostManagement(joinId: string, hostPlayerId: string): Promise<HostManagementView | null> {
    const room = await this.db.room.findFirst({
      where: { joinId, hostPlayerId, OR: [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', finalSummaryVisible: false }] },
      select: {
        smallBlind: true,
        bigBlind: true,
        nextHandIsFinal: true,
        hostPlayerId: true,
        players: { where: { leftAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true, currentStack: true, leaveAfterHand: true, isSittingOut: true, rebuyDecisionPending: true } },
        chipAdjustments: { where: { status: 'PENDING' }, select: { playerId: true, amount: true } },
      },
    });
    if (!room) return null;
    const pendingByPlayer = new Map<string, number>();
    for (const adjustment of room.chipAdjustments) pendingByPlayer.set(adjustment.playerId, (pendingByPlayer.get(adjustment.playerId) ?? 0) + adjustment.amount);
    return Object.freeze({
      smallBlind: room.smallBlind,
      bigBlind: room.bigBlind,
      nextHandIsFinal: room.nextHandIsFinal,
      players: Object.freeze(room.players.map((player) => Object.freeze({
        id: player.id,
        displayName: player.displayName,
        currentStack: player.currentStack,
        isHost: player.id === room.hostPlayerId,
        leaveAfterHand: player.leaveAfterHand,
        pendingChips: pendingByPlayer.get(player.id) ?? 0,
        isSittingOut: player.isSittingOut,
        rebuyDecisionPending: player.rebuyDecisionPending,
      }))),
    });
  }

  async updateBlindsForHost(joinId: string, hostPlayerId: string, smallBlind: number, bigBlind: number) {
    const updated = await this.db.room.updateMany({ where: { joinId, hostPlayerId, status: 'IN_PROGRESS' }, data: { smallBlind, bigBlind } });
    if (updated.count !== 1) throw new Error('Blind update is unavailable');
    return { smallBlind, bigBlind };
  }

  async scheduleFinalHandForHost(joinId: string, hostPlayerId: string, enabled: boolean) {
    const updated = await this.db.room.updateMany({ where: { joinId, hostPlayerId, status: 'IN_PROGRESS' }, data: { nextHandIsFinal: enabled } });
    if (updated.count !== 1) throw new Error('Final-hand scheduling is unavailable');
    return { nextHandIsFinal: enabled };
  }

  /** Schedules a non-host seat to leave immediately before the next deal. */
  async removePlayerBetweenHandsForHostAtomically({ joinId, hostPlayerId, targetPlayerId }: RemovePlayerForHostInput) {
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({
        where: { joinId },
        select: { id: true, hostPlayerId: true, status: true, players: { where: { leftAt: null }, select: { id: true, leaveAfterHand: true, isSittingOut: true } } },
      });
      if (!room || room.hostPlayerId !== hostPlayerId || room.status !== 'IN_PROGRESS' || targetPlayerId === hostPlayerId) {
        throw new Error('Player removal is unavailable');
      }
      if (!room.players.some((player) => player.id === targetPlayerId) || room.players.filter((player) => !player.isSittingOut && !player.leaveAfterHand && player.id !== targetPlayerId).length < 2) {
        throw new Error('Player removal is unavailable');
      }
      const locked = await tx.room.updateMany({ where: { id: room.id, hostPlayerId, status: 'IN_PROGRESS' }, data: { updatedAt: new Date() } });
      if (locked.count !== 1) throw new Error('Player removal is unavailable');
      await tx.player.update({ where: { id: targetPlayerId }, data: { leaveAfterHand: true } });
      await tx.chipAdjustment.updateMany({ where: { roomId: room.id, playerId: targetPlayerId, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      return { roomId: room.id, scheduledPlayerId: targetPlayerId };
    });
  }

  async cancelPlayerRemovalForHost(joinId: string, hostPlayerId: string, targetPlayerId: string) {
    const room = await this.db.room.findFirst({ where: { joinId, hostPlayerId, status: 'IN_PROGRESS' }, select: { id: true } });
    if (!room) throw new Error('Player removal is unavailable');
    const updated = await this.db.player.updateMany({ where: { id: targetPlayerId, roomId: room.id, leftAt: null }, data: { leaveAfterHand: false } });
    if (updated.count !== 1) throw new Error('Player removal is unavailable');
    return { scheduledPlayerId: null };
  }

  async addChipsForHost(joinId: string, hostPlayerId: string, targetPlayerId: string, amount: number) {
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_CHIP_ADJUSTMENT) throw new Error('Chip adjustment is unavailable');
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findFirst({
        where: { joinId, hostPlayerId, OR: [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', finalSummaryVisible: false }] },
        select: { id: true, status: true, maxPlayers: true, players: { where: { leftAt: null }, select: { id: true, leaveAfterHand: true, isSittingOut: true } } },
      });
      const target = room?.players.find((player) => player.id === targetPlayerId);
      if (!room || !target || target.leaveAfterHand) throw new Error('Chip adjustment is unavailable');
      const locked = await tx.room.updateMany({ where: { id: room.id, hostPlayerId, status: room.status }, data: { updatedAt: new Date() } });
      if (locked.count !== 1) throw new Error('Chip adjustment is unavailable');
      if (target.isSittingOut && room.players.filter((player) => !player.isSittingOut && !player.leaveAfterHand).length >= room.maxPlayers) throw new Error('Table is full');
      if (target.isSittingOut) await tx.player.update({ where: { id: targetPlayerId }, data: { isSittingOut: false, rebuyDecisionPending: false } });
      return tx.chipAdjustment.create({ data: { roomId: room.id, playerId: targetPlayerId, authorizedByPlayerId: hostPlayerId, amount } });
    });
  }

  async cancelPendingChipsForHost(joinId: string, hostPlayerId: string, targetPlayerId: string) {
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findFirst({ where: { joinId, hostPlayerId, OR: [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', finalSummaryVisible: false }] }, select: { id: true, status: true } });
      if (!room) throw new Error('Chip adjustment is unavailable');
      const locked = await tx.room.updateMany({ where: { id: room.id, hostPlayerId, status: room.status }, data: { updatedAt: new Date() } });
      if (locked.count !== 1) throw new Error('Chip adjustment is unavailable');
      await tx.chipAdjustment.updateMany({ where: { roomId: room.id, playerId: targetPlayerId, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      await tx.player.updateMany({ where: { id: targetPlayerId, roomId: room.id, currentStack: 0, leftAt: null }, data: { isSittingOut: true, rebuyDecisionPending: false } });
    });
  }

  async declineRebuyForHost(joinId: string, hostPlayerId: string, targetPlayerId: string) {
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findFirst({ where: { joinId, hostPlayerId, OR: [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', finalSummaryVisible: false }] }, select: { id: true, status: true } });
      if (!room) throw new Error('Rebuy decision is unavailable');
      const locked = await tx.room.updateMany({ where: { id: room.id, hostPlayerId, status: room.status }, data: { updatedAt: new Date() } });
      if (locked.count !== 1) throw new Error('Rebuy decision is unavailable');
      const updated = await tx.player.updateMany({ where: { id: targetPlayerId, roomId: room.id, currentStack: 0, leftAt: null, isSittingOut: true, rebuyDecisionPending: true }, data: { rebuyDecisionPending: false } });
      if (updated.count !== 1) throw new Error('Rebuy decision is unavailable');
      return { isSittingOut: true };
    });
  }

  async transferHostForHost(joinId: string, hostPlayerId: string, targetPlayerId: string | undefined, leaveAfterHand: boolean) {
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({
        where: { joinId },
        select: { id: true, hostPlayerId: true, status: true, players: { where: { leftAt: null }, orderBy: [{ currentStack: 'desc' }, { createdAt: 'asc' }], select: { id: true, currentStack: true, leaveAfterHand: true, isSittingOut: true } } },
      });
      if (!room || room.hostPlayerId !== hostPlayerId || room.status !== 'IN_PROGRESS') throw new Error('Host transfer is unavailable');
      const oldHost = room.players.find((player) => player.id === hostPlayerId);
      const target = targetPlayerId
        ? room.players.find((player) => player.id === targetPlayerId)
        : oldHost?.currentStack === 0 ? room.players.find((player) => player.id !== hostPlayerId && !player.isSittingOut && !player.leaveAfterHand) : undefined;
      if (!oldHost || !target || target.id === hostPlayerId || target.isSittingOut || target.leaveAfterHand) throw new Error('Host transfer is unavailable');
      if (leaveAfterHand && room.players.filter((player) => player.id !== hostPlayerId && !player.isSittingOut && !player.leaveAfterHand).length < 2) throw new Error('Host transfer is unavailable');
      await tx.room.update({ where: { id: room.id }, data: { hostPlayerId: target.id } });
      if (leaveAfterHand) {
        await tx.player.update({ where: { id: hostPlayerId }, data: { leaveAfterHand: true } });
        await tx.chipAdjustment.updateMany({ where: { roomId: room.id, playerId: hostPlayerId, status: 'PENDING' }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      }
      return { hostPlayerId: target.id, previousHostLeaves: leaveAfterHand };
    });
  }

  /** Returns only the public audit trail and final stacks to a room participant. */
  async getFinalSummaryForPlayer(roomId: string, playerId: string) {
    const room = await this.db.room.findFirst({
      where: { id: roomId, status: 'COMPLETED', finalSummaryVisible: true, players: { some: { id: playerId } } },
      select: {
        joinId: true, initialStack: true, smallBlind: true, bigBlind: true,
        players: { orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true, initialStack: true, currentStack: true, leftAt: true } },
        chipAdjustments: { where: { status: 'APPLIED' }, orderBy: { createdAt: 'asc' }, select: { playerId: true, authorizedByPlayerId: true, amount: true, stackBefore: true, stackAfter: true, createdAt: true, appliedAt: true } },
        events: { orderBy: { sequence: 'asc' }, select: { sequence: true, type: true, payload: true, createdAt: true } },
        settlements: { orderBy: { createdAt: 'asc' }, select: { idempotencyKey: true, result: true, createdAt: true } },
      },
    });
    if (!room) return null;
    return Object.freeze({
      version: 3,
      room: Object.freeze({ joinId: room.joinId, initialStack: room.initialStack, smallBlind: room.smallBlind, bigBlind: room.bigBlind }),
      standings: Object.freeze(room.players.map((player) => {
        const addedChips = room.chipAdjustments.filter((adjustment) => adjustment.playerId === player.id).reduce((total, adjustment) => total + adjustment.amount, 0);
        const totalBuyIn = player.initialStack + addedChips;
        return Object.freeze({
          displayName: player.displayName,
          initialStack: player.initialStack,
          addedChips,
          totalBuyIn,
          finalStack: player.currentStack,
          net: player.currentStack - totalBuyIn,
          leftAt: player.leftAt?.toISOString() ?? null,
        });
      })),
      chipAdjustments: Object.freeze(room.chipAdjustments.map((adjustment) => Object.freeze({
        playerId: adjustment.playerId,
        authorizedByPlayerId: adjustment.authorizedByPlayerId,
        amount: adjustment.amount,
        stackBefore: adjustment.stackBefore,
        stackAfter: adjustment.stackAfter,
        requestedAt: adjustment.createdAt.toISOString(),
        appliedAt: adjustment.appliedAt?.toISOString() ?? null,
      }))),
      hands: Object.freeze(room.settlements.map((settlement) => Object.freeze({
        hand: settlement.idempotencyKey,
        settledAt: settlement.createdAt.toISOString(),
        result: settlement.result,
      }))),
      events: Object.freeze(room.events.map((event) => Object.freeze({
        sequence: event.sequence,
        type: event.type,
        occurredAt: event.createdAt.toISOString(),
        payload: event.payload,
      }))),
    });
  }
}
