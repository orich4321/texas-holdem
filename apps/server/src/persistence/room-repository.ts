import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, RoomStatus } from '@prisma/client';
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

const roomWithPlayers = {
  players: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.RoomInclude;

export type RoomJoinIdFactory = () => string;

export class RoomRepository {
  constructor(
    private readonly db: PrismaClient,
    private readonly createJoinId: RoomJoinIdFactory = createRoomJoinId,
  ) {}

  async createRoom({ status, host, players = [] }: CreateRoomInput) {
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.create({
        data: { id: randomUUID(), joinId: this.createJoinId(), status },
      });
      const allPlayers = [host, ...players];

      await tx.player.createMany({
        data: allPlayers.map((player) => ({
          ...player,
          roomId: room.id,
          currentStack: player.initialStack,
        })),
      });

      return tx.room.update({
        where: { id: room.id },
        data: { hostPlayerId: host.id },
        include: roomWithPlayers,
      });
    });
  }

  async findRoomByJoinId(joinId: string) {
    return this.db.room.findUnique({
      where: { joinId },
      include: roomWithPlayers,
    });
  }
}
