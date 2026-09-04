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

export class RoomRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly createJoinId: RoomJoinIdFactory = createRoomJoinId,
    private readonly createAccessToken: PlayerAccessTokenFactory = createPlayerAccessToken,
    private readonly hashAccessToken: PlayerAccessTokenHasher = hashPlayerAccessToken,
  ) {}

  async createRoom({ status, host, players = [] }: CreateRoomInput) {
    const allPlayers = [host, ...players].map((player) => {
      const accessToken = this.createAccessToken();
      return { ...player, accessToken, accessTokenHash: this.hashAccessToken(accessToken).toString('hex') };
    });
    const hostAccessToken = allPlayers[0].accessToken;

    return this.db.$transaction(async (tx) => {
      const room = await tx.room.create({
        data: { id: randomUUID(), joinId: this.createJoinId(), status },
      });

      await tx.player.createMany({
        data: allPlayers.map(({ id, displayName, initialStack, accessTokenHash }) => ({
          id,
          displayName,
          initialStack,
          accessTokenHash,
          roomId: room.id,
          currentStack: initialStack,
        })),
      });

      const persistedRoom = await tx.room.update({
        where: { id: room.id },
        data: { hostPlayerId: host.id },
        include: roomWithPlayers,
      });
      return { ...persistedRoom, hostAccessToken };
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
}
