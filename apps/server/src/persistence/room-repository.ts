import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { projectHandHistory } from './hand-history.js';
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
  accountId?: string;
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

type RoomViewPlayer = Readonly<{
  id: string;
  displayName: string;
  avatarDataUrl: string | null;
  currentStack: number;
  isSittingOut: boolean;
  rebuyDecisionPending: boolean;
  timeCardsRemaining?: number;
  preAction?: { type: string; street: string; quotedToCall: number | null } | null;
}>;

const MAX_ACCESS_TOKEN_ATTEMPTS = 5;
const MAX_CHIP_ADJUSTMENT = 1_000_000;
const TURN_DURATION_MS = 60_000;
const HAND_START_TYPES = ['GAME_STARTED', 'HAND_STARTED', 'FINAL_HAND_STARTED'];
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
  timeCardsRemaining: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PlayerSelect;

const identityPlayerSelect = { id: true, roomId: true, displayName: true } satisfies Prisma.PlayerSelect;

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
  /** Server-only guard used by automatic turn expiry. */
  expectedSequence?: number;
  /** Server-only ID of an authenticated queued choice being consumed. */
  preActionId?: string;
}>;

export type PreActionChoice = 'check-fold' | 'call';

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

export type AdvanceRabbitRunoutForHostInput = Readonly<{
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

export type RevealShowdownCardInput = Readonly<{
  roomId: string;
  playerId: string;
  cardIndex: 0 | 1;
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
  const raiseKind = payload.raiseKind === 'bet' || payload.raiseKind === 'raise' ? payload.raiseKind : undefined;
  return Object.freeze({
    sequence: event.sequence,
    actorPlayerId: actor.id,
    actorPlayerName: actor.displayName,
    ...(actor.avatarDataUrl ? { avatarDataUrl: actor.avatarDataUrl } : {}),
    action: Object.freeze({ ...payload.action }),
    ...(raiseKind ? { raiseKind } : {}),
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

  /** Stores one authenticated choice for the current hand and betting street. */
  async setPreActionForPlayer(roomId: string, playerId: string, type: PreActionChoice | null) {
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findFirst({ where: { id: roomId, status: 'IN_PROGRESS', players: { some: { id: playerId, leftAt: null } } }, select: { id: true } });
      if (!room) throw new Error('Pre-action is unavailable');
      const locked = await tx.room.updateMany({ where: { id: roomId, status: 'IN_PROGRESS' }, data: { updatedAt: new Date() } });
      if (locked.count !== 1) throw new Error('Pre-action is unavailable');
      if (type === null) {
        await tx.preAction.deleteMany({ where: { roomId, playerId } });
        return null;
      }
      if (type !== 'check-fold' && type !== 'call') throw new Error('Invalid pre-action');
      const latest = await tx.gameSnapshot.findFirst({ where: { roomId }, orderBy: { sequence: 'desc' }, select: { sequence: true, state: true } });
      if (!latest) throw new Error('Pre-action is unavailable');
      const hand = hydrateSignedPrivateHandSnapshot(latest.state as unknown as SignedPrivateHandSnapshot, { roomId, sequence: latest.sequence }, this.privateSnapshotKeyring).hand;
      const seat = hand.seats.find((candidate) => candidate.playerId === playerId);
      if (hand.street === 'showdown' || hand.currentActorSeat === seat?.seatNumber || !seat?.holeCards || seat.isFolded || seat.stack === 0 || hand.pendingActorSeats.length === 0) throw new Error('Pre-action is unavailable');
      const toCall = Math.max(0, hand.currentBet - seat.currentBet);
      if (type === 'call' && toCall === 0) throw new Error('Nothing to call');
      const handStart = await tx.gameEvent.findFirst({ where: { roomId, sequence: { lte: latest.sequence }, type: { in: HAND_START_TYPES } }, orderBy: { sequence: 'desc' }, select: { sequence: true } });
      if (!handStart) throw new Error('Pre-action is unavailable');
      await tx.preAction.upsert({
        where: { roomId_playerId: { roomId, playerId } },
        create: { roomId, playerId, handStartSequence: handStart.sequence, street: hand.street, type, expectedCurrentBet: type === 'call' ? hand.currentBet : null, quotedToCall: type === 'call' ? Math.min(toCall, seat.stack) : null },
        update: { handStartSequence: handStart.sequence, street: hand.street, type, expectedCurrentBet: type === 'call' ? hand.currentBet : null, quotedToCall: type === 'call' ? Math.min(toCall, seat.stack) : null },
      });
      return { type, ...(type === 'call' ? { quotedToCall: Math.min(toCall, seat.stack) } : {}) };
    });
  }

  /** Rechecks each queued choice under the same action lock and legal rules. */
  async drainPreActionsForRoom(roomId: string): Promise<void> {
    for (let step = 0; step < 9; step += 1) {
      const hasChoice = await this.db.preAction.findFirst({ where: { roomId }, select: { id: true } });
      if (!hasChoice) return;
      const latest = await this.db.gameSnapshot.findFirst({ where: { roomId }, orderBy: { sequence: 'desc' }, select: { sequence: true, state: true } });
      if (!latest) return;
      const hand = hydrateSignedPrivateHandSnapshot(latest.state as unknown as SignedPrivateHandSnapshot, { roomId, sequence: latest.sequence }, this.privateSnapshotKeyring).hand;
      const actor = hand.seats.find((seat) => seat.seatNumber === hand.currentActorSeat);
      if (!actor || hand.street === 'showdown') return;
      const choice = await this.db.preAction.findUnique({ where: { roomId_playerId: { roomId, playerId: actor.playerId } } });
      if (!choice) return;
      const handStart = await this.db.gameEvent.findFirst({ where: { roomId, sequence: { lte: latest.sequence }, type: { in: HAND_START_TYPES } }, orderBy: { sequence: 'desc' }, select: { sequence: true } });
      const valid = hand.street === choice.street && handStart?.sequence === choice.handStartSequence
        && !actor.isFolded && actor.stack > 0 && (choice.type === 'check-fold' || (choice.type === 'call' && hand.currentBet === choice.expectedCurrentBet && hand.currentBet > actor.currentBet));
      if (!valid) {
        await this.db.preAction.deleteMany({ where: { id: choice.id } });
        continue;
      }
      const action: PlayerAction = choice.type === 'check-fold'
        ? { type: hand.currentBet === actor.currentBet ? 'check' : 'fold' }
        : { type: 'call' };
      try {
        await this.persistPlayerActionAtomically({ roomId, playerId: actor.playerId, action, expectedSequence: latest.sequence, preActionId: choice.id });
      } catch {
        // A concurrent manual action or raise wins the lock; the stale choice
        // cannot be retried at a new price or on a new street.
        await this.db.preAction.deleteMany({ where: { id: choice.id } });
      }
    }
  }

  private decorateView(view: ServerPlayerView, sequence: number, hostPlayerId: string, gameCompleted = false, finalSummaryVisible = false, lastAction?: PlayerActionNotification, roomPlayers?: readonly RoomViewPlayer[], gameStartedAt?: string, turnDeadlineAt?: Date | null, recentActions?: readonly PlayerActionNotification[]): ServerPlayerView {
    const activeSeats = new Map(view.seats.map((seat) => [seat.playerId, seat]));
    const seats = roomPlayers
      ? roomPlayers.map((player, index) => {
        const activeSeat = activeSeats.get(player.id);
        return Object.freeze(activeSeat
          ? { ...activeSeat, isSittingOut: player.isSittingOut && !player.rebuyDecisionPending }
          : {
            seatNumber: -(index + 1),
            playerId: player.id,
            playerName: player.displayName,
            ...(player.avatarDataUrl ? { avatarDataUrl: player.avatarDataUrl } : {}),
            stack: player.currentStack,
            currentBet: 0,
            isFolded: false,
            isSittingOut: true,
          });
      })
      : view.seats;
    const viewer = roomPlayers?.find((player) => player.id === view.playerId);
    const choice = viewer?.preAction?.street === view.street ? viewer.preAction : undefined;
    const preAction: ServerPlayerView['preAction'] = choice?.type === 'call'
      ? { type: 'call', ...(choice.quotedToCall !== null ? { quotedToCall: choice.quotedToCall } : {}) }
      : choice?.type === 'check-fold' ? { type: 'check-fold' } : undefined;
    return Object.freeze({
      ...view,
      seats: Object.freeze(seats),
      sequence,
      hostPlayerId,
      gameCompleted,
      finalSummaryVisible,
      ...(lastAction ? { lastAction } : {}),
      ...(recentActions ? { recentActions } : lastAction ? { recentActions: [lastAction] } : {}),
      ...(preAction ? { preAction } : {}),
      ...(gameStartedAt ? { gameStartedAt } : {}),
      ...(turnDeadlineAt ? { turnDeadlineAt: turnDeadlineAt.toISOString() } : {}),
      ...(viewer?.timeCardsRemaining !== undefined ? { timeCardsRemaining: viewer.timeCardsRemaining } : {}),
    });
  }

  private async createPlayerWithUniqueAccessToken(db: PlayerWriter, player: PlayerInput, roomId: string) {
    for (let attempt = 0; attempt < MAX_ACCESS_TOKEN_ATTEMPTS; attempt += 1) {
      const accessToken = this.createAccessToken();
      try {
        const persistedPlayer = await db.player.create({
          data: {
            id: player.id,
            accountId: player.accountId,
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

      const previousSeat = player.accountId
        ? await tx.player.findFirst({ where: { roomId: room.id, accountId: player.accountId }, select: { leftAt: true } })
        : null;
      if (previousSeat?.leftAt) return { kind: 'removed' as const };
      if (previousSeat) return { kind: 'already-joined' as const };

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

  /** An authenticated account always resumes its existing player, regardless of another room's cookie. */
  async findPlayerByRoomJoinIdAndAccountId(joinId: string, accountId: string) {
    return this.db.player.findFirst({
      where: { accountId, leftAt: null, room: { joinId } },
      select: identityPlayerSelect,
    });
  }

  /** Opt-in migration of an already authenticated legacy seat to its Google account. */
  async linkLegacyPlayerToAccount(playerId: string, accountId: string): Promise<boolean> {
    const result = await this.db.player.updateMany({
      where: { id: playerId, accountId: null, leftAt: null },
      data: { accountId },
    });
    return result.count === 1;
  }

  async findPlayerByRoomJoinIdAndAccessToken(joinId: string, accessToken: unknown) {
    if (!isValidPlayerAccessToken(accessToken)) return null;
    // The token hash is unique. Resolve exactly one seat without reading every
    // other player's profile image on each table refresh.
    return this.db.player.findFirst({
      where: { accessTokenHash: this.hashAccessToken(accessToken).toString('hex'), leftAt: null, accountId: null, room: { joinId } },
      select: identityPlayerSelect,
    });
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
        data: { status: 'IN_PROGRESS', turnDeadlineAt: new Date(Date.now() + TURN_DURATION_MS) },
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
        data: { status: 'IN_PROGRESS', turnDeadlineAt: new Date(Date.now() + TURN_DURATION_MS) },
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

  /** Small change marker for frequent conditional reads; no snapshot or images leave PostgreSQL. */
  async findGameRefreshTag(roomId: string, playerId: string): Promise<string | null> {
    const room = await this.db.room.findFirst({
      where: { id: roomId, status: { in: ['IN_PROGRESS', 'COMPLETED'] }, players: { some: { id: playerId, leftAt: null } } },
      select: {
        status: true,
        updatedAt: true,
        players: { select: { id: true, updatedAt: true }, orderBy: { id: 'asc' } },
        snapshots: { select: { sequence: true }, orderBy: { sequence: 'desc' }, take: 1 },
      },
    });
    if (!room?.snapshots[0]) return null;
    const revision = JSON.stringify([
      playerId, room.status, room.updatedAt.getTime(), room.snapshots[0].sequence,
      room.players.map((player) => [player.id, player.updatedAt.getTime()]),
    ]);
    return `"poker-${createHash('sha256').update(revision).digest('base64url').slice(0, 22)}"`;
  }

  /**
   * Builds the sole player-safe projection used for reconnects. The signed
   * hand remains within the server boundary and is never returned to a socket.
   */
  async recoverLatestPlayerViewForPlayer(roomId: string, playerId: string): Promise<ServerPlayerView | null> {
    // The room projection and signed snapshot are independent reads. Running
    // them together removes a full database round trip from every live-state
    // refresh while each query still scopes itself to the participant.
    const [room, latest, gameStarted] = await Promise.all([
      this.db.room.findFirst({
        where: { id: roomId, status: { in: ['IN_PROGRESS', 'COMPLETED'] }, players: { some: { id: playerId, leftAt: null } } },
        select: {
          status: true,
          hostPlayerId: true,
          finalSummaryVisible: true,
          turnDeadlineAt: true,
          players: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, displayName: true, avatarDataUrl: true, currentStack: true, isSittingOut: true, rebuyDecisionPending: true, timeCardsRemaining: true, preAction: { select: { type: true, street: true, quotedToCall: true } } },
          },
          events: {
            where: { type: 'PLAYER_ACTION' },
            orderBy: { sequence: 'desc' },
            take: 12,
            select: { sequence: true, payload: true },
          },
        },
      }),
      this.recoverLatestHandForPlayer(roomId, playerId),
      this.db.gameEvent.findFirst({
        where: { roomId, type: 'GAME_STARTED' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
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
      ? { ...baseView, isSittingOut: (member?.isSittingOut ?? false) && !(member?.rebuyDecisionPending ?? false) }
      : { ...baseView, playerId, holeCards: [] as const, toCall: 0, raise: undefined, isSittingOut: true };
    const latestAction = room.events[0]?.sequence === latest.sequence
      ? actionNotificationFromEvent(room.events[0], room.players)
      : undefined;
    const recentActions = room.events.filter((event) => event.sequence <= latest.sequence)
      .map((event) => actionNotificationFromEvent(event, room.players))
      .filter((event): event is PlayerActionNotification => Boolean(event))
      .reverse();
    return this.decorateView(safeView, latest.sequence, room.hostPlayerId, room.status === 'COMPLETED', room.status === 'COMPLETED' && room.finalSummaryVisible, latestAction, room.players, gameStarted?.createdAt.toISOString(), room.turnDeadlineAt, recentActions);
  }

  /** Applies an authenticated action to the latest verified state and commits its successor atomically. */
  async persistPlayerActionAtomically({ roomId, playerId, action, clientActionId, expectedSequence, preActionId }: PersistPlayerActionInput) {
    validatePersistedPlayerAction(action);
    if (clientActionId !== undefined && !/^[0-9a-f-]{36}$/i.test(clientActionId)) throw new Error('Invalid action identifier');
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({
        where: { id: roomId },
        select: { status: true, hostPlayerId: true, turnDeadlineAt: true, players: { where: { leftAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true, avatarDataUrl: true, currentStack: true, isSittingOut: true, rebuyDecisionPending: true, timeCardsRemaining: true } } },
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
      if (expectedSequence !== undefined && latest.sequence !== expectedSequence) throw new Error('Game action is unavailable');
      if (expectedSequence === undefined && room.turnDeadlineAt && room.turnDeadlineAt.getTime() <= Date.now()) throw new Error('Turn has expired');
      if (preActionId && room.turnDeadlineAt && room.turnDeadlineAt.getTime() <= Date.now()) throw new Error('Turn has expired');
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
          const views = Object.freeze(hand.seats.map((seat) => this.decorateView(lifecycle.viewFor(seat.playerId), latest.sequence, room.hostPlayerId!, false, false, lastAction, room.players, undefined, room.turnDeadlineAt)));
          return { sequence: latest.sequence, view: views.find((candidate) => candidate.playerId === playerId)!, views };
        }
      }
      const beforeAction = lifecycle.viewFor(playerId);
      const actorSeat = beforeAction.seats.find((seat) => seat.playerId === playerId);
      if (!actorSeat) throw new Error('Game action is unavailable');
      if (preActionId) {
        const queued = await tx.preAction.findUnique({ where: { roomId_playerId: { roomId, playerId } } });
        if (!queued || queued.id !== preActionId || queued.street !== hand.street || hand.currentActorSeat !== actorSeat.seatNumber
          || (queued.type === 'call' && (queued.expectedCurrentBet !== hand.currentBet || beforeAction.toCall <= 0))
          || (queued.type === 'check-fold' && action.type !== (beforeAction.toCall === 0 ? 'check' : 'fold'))
          || (queued.type === 'call' && action.type !== 'call')) throw new Error('Queued action is unavailable');
      }
      // A raise to the actor's complete stack is semantically an all-in even
      // when an older client submitted it through the generic raise control.
      const effectiveAction: PlayerAction = action.type === 'raise' && action.raiseTo === actorSeat.currentBet + actorSeat.stack
        ? { type: 'all-in' }
        : action;
      const isAllInCall = effectiveAction.type === 'call' && actorSeat.stack > 0 && beforeAction.toCall >= actorSeat.stack;
      const actionAmount = isAllInCall
        ? actorSeat.currentBet + actorSeat.stack
        : effectiveAction.type === 'call'
        ? Math.min(beforeAction.toCall, actorSeat.stack)
        : effectiveAction.type === 'raise'
          ? effectiveAction.raiseTo
          : effectiveAction.type === 'all-in'
            ? actorSeat.currentBet + actorSeat.stack
            : undefined;
      const raiseKind = effectiveAction.type === 'raise'
        ? Math.max(...beforeAction.seats.map((seat) => seat.currentBet)) === 0 ? 'bet' as const : 'raise' as const
        : undefined;
      const view = lifecycle.applyAction(playerId, effectiveAction);
      await tx.preAction.deleteMany({ where: { roomId, OR: [
        { playerId },
        { street: { not: lifecycle.handForDurableSnapshot().street } },
        { type: 'call', expectedCurrentBet: { not: lifecycle.handForDurableSnapshot().currentBet } },
      ] } });
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
              pots: view.showdown?.pots.map((pot) => ({ amount: pot.amount, eligibleSeatNumbers: [...pot.eligibleSeatNumbers], winnerSeatNumbers: [...pot.winnerSeatNumbers], payouts: pot.payouts.map((payout) => ({ ...payout })) })) ?? [],
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
      const turnDeadlineAt = view.street === 'showdown' || view.allInRunout
        ? null
        : new Date(Date.now() + TURN_DURATION_MS);
      const publicAction = isAllInCall
        ? { type: 'all-in' as const }
        : effectiveAction.type === 'raise'
          ? { type: 'raise' as const, raiseTo: effectiveAction.raiseTo }
          : { type: effectiveAction.type };
      const publicActionPayload = { actorPlayerId: playerId, action: publicAction, ...(raiseKind ? { raiseKind } : {}), ...(actionAmount !== undefined ? { amount: actionAmount } : {}) };
      const lastAction = actionNotificationFromEvent({ sequence, payload: publicActionPayload }, room.players);
      if (!lastAction) throw new Error('Game action is unavailable');
      const activeKey = this.privateSnapshotKeyring.entries().next().value as [string, PrivateSnapshotSigningKey] | undefined;
      if (!activeKey) throw new Error('Game action is unavailable');
      const [keyId, key] = activeKey;
      const snapshot = signPrivateHandSnapshot(lifecycle.handForDurableSnapshot(), { roomId, sequence, keyId }, key);
      await tx.gameEvent.create({ data: { roomId, sequence, type: 'PLAYER_ACTION', payload: publicActionPayload, ...(clientActionId ? { clientActionId } : {}) } });
      await tx.gameSnapshot.create({ data: { roomId, sequence, state: snapshot as unknown as Prisma.InputJsonValue } });
      await tx.room.update({ where: { id: roomId }, data: { turnDeadlineAt } });
      const timedViews = Object.freeze(settledHand.seats.map((seat) => this.decorateView(lifecycle.viewFor(seat.playerId), sequence, room.hostPlayerId!, gameCompleted, false, lastAction, room.players, undefined, turnDeadlineAt)));
      return { sequence, view: timedViews.find((candidate) => candidate.playerId === playerId)!, views: timedViews };
    });
  }

  /** Extends only the authenticated current actor's live deadline. */
  async useTimeCardAtomically(roomId: string, playerId: string) {
    await this.db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({
        where: { id: roomId },
        select: { status: true, turnDeadlineAt: true, players: { where: { id: playerId, leftAt: null }, select: { id: true, timeCardsRemaining: true } } },
      });
      if (!room || room.status !== 'IN_PROGRESS' || !room.turnDeadlineAt || room.turnDeadlineAt.getTime() < Date.now() || (room.players[0]?.timeCardsRemaining ?? 0) < 1) throw new Error('Time card is unavailable');
      const locked = await tx.room.updateMany({
        where: { id: roomId, status: 'IN_PROGRESS', turnDeadlineAt: room.turnDeadlineAt },
        data: { updatedAt: new Date() },
      });
      if (locked.count !== 1) throw new Error('Time card is unavailable');
      const latest = await tx.gameSnapshot.findFirst({ where: { roomId }, orderBy: { sequence: 'desc' }, select: { sequence: true, state: true } });
      if (!latest) throw new Error('Time card is unavailable');
      const recovery = hydrateSignedPrivateHandSnapshot(latest.state as unknown as SignedPrivateHandSnapshot, { roomId, sequence: latest.sequence }, this.privateSnapshotKeyring);
      const actor = recovery.hand.seats.find((seat) => seat.seatNumber === recovery.hand.currentActorSeat);
      if (!actor || actor.playerId !== playerId || recovery.hand.street === 'showdown') throw new Error('Time card is unavailable');
      const claimed = await tx.player.updateMany({ where: { id: playerId, roomId, timeCardsRemaining: { gt: 0 } }, data: { timeCardsRemaining: { decrement: 1 } } });
      if (claimed.count !== 1) throw new Error('Time card is unavailable');
      await tx.room.update({ where: { id: roomId }, data: { turnDeadlineAt: new Date(room.turnDeadlineAt.getTime() + TURN_DURATION_MS) } });
    });
    return this.recoverLatestPlayerViewForPlayer(roomId, playerId);
  }

  /** Any authenticated participant may wake this server-side expiry check. */
  async expireTurnForParticipant(roomId: string, requestingPlayerId: string) {
    const room = await this.db.room.findFirst({
      where: { id: roomId, status: 'IN_PROGRESS', players: { some: { id: requestingPlayerId, leftAt: null } } },
      select: { turnDeadlineAt: true },
    });
    if (!room?.turnDeadlineAt || room.turnDeadlineAt.getTime() > Date.now()) return null;
    const latest = await this.recoverLatestHandForPlayer(roomId, requestingPlayerId);
    if (!latest || latest.recovery.hand.street === 'showdown') return null;
    const actorSeat = latest.recovery.hand.seats.find((seat) => seat.seatNumber === latest.recovery.hand.currentActorSeat);
    if (!actorSeat) return null;
    const actorView = await this.recoverLatestPlayerViewForPlayer(roomId, actorSeat.playerId);
    if (!actorView || actorView.sequence !== latest.sequence) return null;
    return this.persistPlayerActionAtomically({
      roomId,
      playerId: actorSeat.playerId,
      action: actorView.toCall === 0 ? { type: 'check' } : { type: 'fold' },
      expectedSequence: latest.sequence,
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
        select: { id: true, hostPlayerId: true, status: true, players: { where: { leftAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true, avatarDataUrl: true, currentStack: true, isSittingOut: true, rebuyDecisionPending: true } } },
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
              pots: showdown?.pots.map((pot) => ({ amount: pot.amount, eligibleSeatNumbers: [...pot.eligibleSeatNumbers], winnerSeatNumbers: [...pot.winnerSeatNumbers], payouts: pot.payouts.map((payout) => ({ ...payout })) })) ?? [],
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
      return { sequence, views: Object.freeze(hand.seats.map((seat) => this.decorateView(lifecycle.viewFor(seat.playerId), sequence, room.hostPlayerId!, gameCompleted, false, undefined, room.players))) };
    });
  }

  /** Reveals one hypothetical board street after a hand won by folds. */
  async advanceRabbitRunoutForHostAtomically({ joinId, hostPlayerId }: AdvanceRabbitRunoutForHostInput) {
    const activeKey = this.privateSnapshotKeyring.entries().next().value as [string, PrivateSnapshotSigningKey] | undefined;
    if (!activeKey) throw new Error('Uncontested board is unavailable');
    const [keyId, key] = activeKey;
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({
        where: { joinId },
        select: { id: true, hostPlayerId: true, status: true, finalSummaryVisible: true, players: { where: { leftAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true, avatarDataUrl: true, currentStack: true, isSittingOut: true, rebuyDecisionPending: true } } },
      });
      if (!room || room.hostPlayerId !== hostPlayerId || (room.status !== 'IN_PROGRESS' && (room.status !== 'COMPLETED' || room.finalSummaryVisible))) {
        throw new Error('Uncontested board is unavailable');
      }
      const locked = await tx.room.updateMany({
        where: { id: room.id, hostPlayerId, status: room.status, ...(room.status === 'COMPLETED' ? { finalSummaryVisible: false } : {}) },
        data: { updatedAt: new Date() },
      });
      if (locked.count !== 1) throw new Error('Uncontested board is unavailable');
      const latest = await tx.gameSnapshot.findFirst({ where: { roomId: room.id }, orderBy: { sequence: 'desc' }, select: { sequence: true, state: true } });
      if (!latest) throw new Error('Uncontested board is unavailable');
      const recovery = hydrateSignedPrivateHandSnapshot(latest.state as unknown as SignedPrivateHandSnapshot, { roomId: room.id, sequence: latest.sequence }, this.privateSnapshotKeyring);
      const playersById = new Map(room.players.map((player) => [player.id, player]));
      const lifecycle = ServerGameLifecycle.fromVerifiedRecoveredHand({
        seats: recovery.hand.seats.map((seat) => {
          const player = playersById.get(seat.playerId);
          if (!player) throw new Error('Uncontested board is unavailable');
          return { seatNumber: seat.seatNumber, playerId: player.id, playerName: player.displayName, avatarDataUrl: player.avatarDataUrl ?? undefined, stack: player.currentStack };
        }),
        dealerSeat: recovery.hand.dealerSeat, smallBlind: recovery.hand.smallBlindAmount, bigBlind: recovery.hand.bigBlindAmount,
      }, recovery);
      lifecycle.advanceRabbitRunout();
      const hand = lifecycle.handForDurableSnapshot();
      const sequence = latest.sequence + 1;
      const snapshot = signPrivateHandSnapshot(hand, { roomId: room.id, sequence, keyId }, key);
      await tx.gameEvent.create({ data: { roomId: room.id, sequence, type: 'UNCONTESTED_RUNOUT_ADVANCED', payload: { communityCardCount: hand.communityCards.length } } });
      await tx.gameSnapshot.create({ data: { roomId: room.id, sequence, state: snapshot as unknown as Prisma.InputJsonValue } });
      return {
        sequence,
        views: Object.freeze(hand.seats.map((seat) => this.decorateView(lifecycle.viewFor(seat.playerId), sequence, room.hostPlayerId!, room.status === 'COMPLETED', false, undefined, room.players))),
      };
    });
  }

  /** Persists a player's voluntary showdown reveal without trusting client cards. */
  async revealShowdownCardAtomically({ roomId, playerId, cardIndex }: RevealShowdownCardInput) {
    const activeKey = this.privateSnapshotKeyring.entries().next().value as [string, PrivateSnapshotSigningKey] | undefined;
    if (!activeKey) throw new Error('Showdown reveal is unavailable');
    const [keyId, key] = activeKey;
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({
        where: { id: roomId },
        select: { status: true, hostPlayerId: true, finalSummaryVisible: true, players: { where: { leftAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true, avatarDataUrl: true, currentStack: true, isSittingOut: true, rebuyDecisionPending: true } } },
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
      const view = lifecycle.revealShowdownCard(playerId, cardIndex);
      const sequence = latest.sequence + 1;
      const snapshot = signPrivateHandSnapshot(lifecycle.handForDurableSnapshot(), { roomId, sequence, keyId }, key);
      await tx.gameEvent.create({ data: { roomId, sequence, type: 'SHOWDOWN_CARD_REVEALED', payload: { playerId, cardIndex } } });
      await tx.gameSnapshot.create({ data: { roomId, sequence, state: snapshot as unknown as Prisma.InputJsonValue } });
      return {
        sequence,
        view: this.decorateView(view, sequence, room.hostPlayerId, room.status === 'COMPLETED', room.finalSummaryVisible, undefined, room.players),
        views: Object.freeze(recovery.hand.seats.map((seat) => this.decorateView(lifecycle.viewFor(seat.playerId), sequence, room.hostPlayerId!, room.status === 'COMPLETED', room.finalSummaryVisible, undefined, room.players))),
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
      await tx.preAction.deleteMany({ where: { roomId: room.id } });
      await tx.gameEvent.create({
        data: {
          roomId: room.id,
          sequence,
          type: nextHandIsFinal ? 'FINAL_HAND_STARTED' : 'HAND_STARTED',
          payload: { dealerSeat: hand.dealerSeat, smallBlind: hand.smallBlindAmount, bigBlind: hand.bigBlindAmount },
        },
      });
      await tx.gameSnapshot.create({ data: { roomId: room.id, sequence, state: snapshot as unknown as Prisma.InputJsonValue } });
      await tx.room.update({
        where: { id: room.id },
        data: {
          turnDeadlineAt: new Date(Date.now() + TURN_DURATION_MS),
          ...(continuingCompleted ? { status: 'IN_PROGRESS' as const, finalSummaryVisible: false, nextHandIsFinal: false } : {}),
          ...(!continuingCompleted && lockedRoom.nextHandIsFinal ? { nextHandIsFinal: false } : {}),
        },
      });
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

  /** Account-scoped history; never use a room URL or a legacy room cookie as authority. */
  async listGamesForAccount(accountId: string) {
    const rooms = await this.db.room.findMany({
      where: { players: { some: { accountId } } },
      orderBy: { updatedAt: 'desc' },
      select: {
        joinId: true, status: true, createdAt: true, updatedAt: true,
        players: { where: { accountId }, select: { id: true, initialStack: true, currentStack: true } },
        chipAdjustments: { where: { player: { accountId }, status: 'APPLIED' }, select: { playerId: true, amount: true } },
        _count: { select: { settlements: true } },
      },
    });
    return rooms.map((room) => ({
      joinId: room.joinId, status: room.status,
      createdAt: room.createdAt.toISOString(), updatedAt: room.updatedAt.toISOString(),
      handCount: room._count.settlements,
      yourNet: room.players.reduce((total, player) => total + player.currentStack - player.initialStack
        - room.chipAdjustments.filter((adjustment) => adjustment.playerId === player.id).reduce((sum, adjustment) => sum + adjustment.amount, 0), 0),
    }));
  }

  async listHandsForAccount(accountId: string, joinId: string) {
    const room = await this.db.room.findFirst({
      where: { joinId, players: { some: { accountId } } },
      select: {
        id: true, joinId: true, status: true, createdAt: true,
        settlements: { orderBy: { createdAt: 'asc' }, select: { idempotencyKey: true, createdAt: true } },
      },
    });
    if (!room) return null;
    return {
      joinId: room.joinId, status: room.status, createdAt: room.createdAt.toISOString(),
      hands: room.settlements.map((settlement, index) => ({
        key: settlement.idempotencyKey, number: index + 1, settledAt: settlement.createdAt.toISOString(),
      })),
    };
  }

  async getHandForAccount(accountId: string, joinId: string, handKey: string) {
    if (!/^hand-\d+$/.test(handKey)) return null;
    const room = await this.db.room.findFirst({
      where: { joinId, players: { some: { accountId } } },
      select: { id: true, players: { where: { accountId }, select: { id: true } },
        settlements: { where: { idempotencyKey: handKey }, take: 1, select: { result: true, createdAt: true } } },
    });
    const settlement = room?.settlements[0];
    if (!room || !settlement) return null;
    const finalSequence = Number(handKey.slice(5)) + 1;
    const start = await this.db.gameEvent.findFirst({
      where: { roomId: room.id, sequence: { lte: finalSequence }, type: { in: ['GAME_STARTED', 'HAND_STARTED', 'FINAL_HAND_STARTED'] } },
      orderBy: { sequence: 'desc' }, select: { sequence: true },
    });
    const next = await this.db.gameEvent.findFirst({
      where: { roomId: room.id, sequence: { gt: finalSequence }, type: { in: ['HAND_STARTED', 'FINAL_HAND_STARTED'] } },
      orderBy: { sequence: 'asc' }, select: { sequence: true },
    });
    const events = await this.db.gameEvent.findMany({
      where: { roomId: room.id, sequence: { gte: start?.sequence ?? finalSequence, ...(next ? { lt: next.sequence } : {}) }, type: { in: ['PLAYER_ACTION', 'SHOWDOWN_CARD_REVEALED'] } },
      orderBy: { sequence: 'asc' }, select: { sequence: true, type: true, payload: true, createdAt: true },
    });
    return { key: handKey, settledAt: settlement.createdAt.toISOString(),
      ...projectHandHistory(settlement.result, new Set(room.players.map((player) => player.id)), events) };
  }

  /** Returns only the public audit trail and final stacks to a room participant. */
  async getFinalSummaryForPlayer(roomId: string, playerId: string) {
    const room = await this.db.room.findFirst({
      where: { id: roomId, status: 'COMPLETED', finalSummaryVisible: true, players: { some: { id: playerId } } },
      select: {
        joinId: true, initialStack: true, smallBlind: true, bigBlind: true,
        players: { orderBy: { createdAt: 'asc' }, select: { id: true, displayName: true, avatarDataUrl: true, initialStack: true, currentStack: true, leftAt: true } },
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
          ...(player.avatarDataUrl ? { avatarDataUrl: player.avatarDataUrl } : {}),
          initialStack: player.initialStack,
          addedChips,
          totalBuyIn,
          finalStack: player.currentStack,
          net: player.currentStack - totalBuyIn,
          leftAt: player.leftAt?.toISOString() ?? null,
        });
      }).sort((first, second) => second.net - first.net || second.finalStack - first.finalStack)),
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
