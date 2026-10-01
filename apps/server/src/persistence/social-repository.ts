import type { PrismaClient } from '@prisma/client';

const publicAccount = { id: true, username: true, displayName: true, avatarDataUrl: true } as const;

function pair(a: string, b: string) {
  return a < b ? { accountAId: a, accountBId: b } : { accountAId: b, accountBId: a };
}

export class SocialRepository {
  constructor(private readonly db: PrismaClient) {}

  /** A bounded, account-only directory; never return email or auth metadata. */
  async listUsers(accountId: string, after?: string) {
    const users = await this.db.account.findMany({
      where: { id: { not: accountId }, displayName: { not: null }, username: { not: null, ...(after ? { gt: after } : {}) } },
      orderBy: { username: 'asc' },
      take: 21,
      select: publicAccount,
    });
    const page = users.slice(0, 20);
    return { users: page, nextCursor: users.length > 20 ? page[page.length - 1]?.username ?? null : null };
  }

  async overview(accountId: string) {
    const [friends, incoming, outgoing, invitations] = await Promise.all([
      this.db.friend.findMany({ where: { OR: [{ accountAId: accountId }, { accountBId: accountId }] }, include: { accountA: { select: publicAccount }, accountB: { select: publicAccount } } }),
      this.db.friendRequest.findMany({ where: { toAccountId: accountId }, include: { fromAccount: { select: publicAccount } }, orderBy: { createdAt: 'desc' } }),
      this.db.friendRequest.findMany({ where: { fromAccountId: accountId }, include: { toAccount: { select: publicAccount } }, orderBy: { createdAt: 'desc' } }),
      this.listInvitations(accountId),
    ]);
    return {
      friends: friends.map((friend) => friend.accountAId === accountId ? friend.accountB : friend.accountA),
      incoming: incoming.map((request) => ({ id: request.id, from: request.fromAccount })),
      outgoing: outgoing.map((request) => ({ id: request.id, to: request.toAccount })),
      invitations,
    };
  }

  /** Small polling response: avatar data URLs are intentionally excluded. */
  async listInvitations(accountId: string) {
    const invites = await this.db.gameInvite.findMany({
      where: { toAccountId: accountId, status: 'PENDING', room: { status: { in: ['WAITING', 'IN_PROGRESS'] } } },
      select: { id: true, fromAccount: { select: { id: true, username: true, displayName: true } }, room: { select: { joinId: true, status: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    return invites.map((invite) => ({ id: invite.id, from: { ...invite.fromAccount, avatarDataUrl: null }, joinId: invite.room.joinId, roomStatus: invite.room.status }));
  }

  async notificationSnapshot(accountId: string) {
    const [invitations, pendingFriendRequests] = await Promise.all([
      this.listInvitations(accountId),
      this.db.friendRequest.count({ where: { toAccountId: accountId } }),
    ]);
    return { invitations, pendingFriendRequests };
  }

  async requestFriend(accountId: string, username: string): Promise<'sent' | 'not-found' | 'self' | 'already-friends' | 'pending'> {
    const recipient = await this.db.account.findUnique({ where: { username }, select: { id: true } });
    if (!recipient) return 'not-found';
    if (recipient.id === accountId) return 'self';
    const ids = pair(accountId, recipient.id);
    if (await this.db.friend.findUnique({ where: { accountAId_accountBId: ids } })) return 'already-friends';
    if (await this.db.friendRequest.findFirst({ where: { OR: [
      { fromAccountId: accountId, toAccountId: recipient.id },
      { fromAccountId: recipient.id, toAccountId: accountId },
    ] } })) return 'pending';
    try {
      await this.db.friendRequest.create({ data: { fromAccountId: accountId, toAccountId: recipient.id } });
      return 'sent';
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return 'pending';
      throw error;
    }
  }

  async answerFriendRequest(accountId: string, requestId: string, accept: boolean): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const request = await tx.friendRequest.findFirst({ where: { id: requestId, toAccountId: accountId } });
      if (!request) return false;
      await tx.friendRequest.delete({ where: { id: requestId } });
      if (accept) {
        await tx.friend.upsert({ where: { accountAId_accountBId: pair(request.fromAccountId, accountId) }, create: pair(request.fromAccountId, accountId), update: {} });
        await tx.friendRequest.deleteMany({ where: { fromAccountId: accountId, toAccountId: request.fromAccountId } });
      }
      return true;
    });
  }

  async removeFriend(accountId: string, friendId: string): Promise<boolean> {
    const result = await this.db.friend.deleteMany({ where: pair(accountId, friendId) });
    return result.count > 0;
  }

  async inviteFriend(joinId: string, senderId: string, recipientId: string): Promise<'sent' | 'not-friends' | 'unavailable' | 'already-playing'> {
    if (senderId === recipientId || !await this.db.friend.findUnique({ where: { accountAId_accountBId: pair(senderId, recipientId) } })) return 'not-friends';
    return this.db.$transaction(async (tx) => {
      const room = await tx.room.findUnique({ where: { joinId }, select: { id: true, status: true } });
      if (!room || !['WAITING', 'IN_PROGRESS'].includes(room.status)) return 'unavailable';
      const locked = await tx.room.updateMany({ where: { id: room.id, status: room.status }, data: { updatedAt: new Date() } });
      if (locked.count !== 1) return 'unavailable';
      const activeSeat = await tx.player.findFirst({ where: { roomId: room.id, accountId: recipientId, leftAt: null }, select: { id: true } });
      if (activeSeat) return 'already-playing';
      await tx.gameInvite.upsert({
        where: { roomId_toAccountId: { roomId: room.id, toAccountId: recipientId } },
        create: { roomId: room.id, fromAccountId: senderId, toAccountId: recipientId },
        update: { fromAccountId: senderId, status: 'PENDING' },
      });
      return 'sent';
    });
  }

  async answerGameInvite(accountId: string, inviteId: string, accept: boolean): Promise<string | null> {
    return this.db.$transaction(async (tx) => {
      const invite = await tx.gameInvite.findFirst({ where: {
        id: inviteId, toAccountId: accountId, status: 'PENDING', room: { status: { in: ['WAITING', 'IN_PROGRESS'] } },
      }, select: { roomId: true, room: { select: { joinId: true, status: true, maxPlayers: true } } } });
      if (!invite) return null;
      // Serialize acceptance with joining, starting, and host removal. A fresh
      // invitation may reinstate the account's existing seat, never create one.
      const locked = await tx.room.updateMany({
        where: { id: invite.roomId, status: invite.room.status }, data: { updatedAt: new Date() },
      });
      if (locked.count !== 1) return null;
      const previousSeat = accept
        ? await tx.player.findFirst({
          where: { roomId: invite.roomId, accountId }, select: { id: true, leftAt: true },
        }) : null;
      if (previousSeat?.leftAt) {
        const activeCount = await tx.player.count({ where: { roomId: invite.roomId, leftAt: null, isSittingOut: false } });
        if (activeCount >= invite.room.maxPlayers) return null;
      }
      const changed = await tx.gameInvite.updateMany({
        where: { id: inviteId, toAccountId: accountId, status: 'PENDING' },
        data: { status: accept ? 'ACCEPTED' : 'DECLINED' },
      });
      if (changed.count !== 1) return null;
      if (previousSeat?.leftAt) {
        await tx.player.update({
          where: { id: previousSeat.id },
          data: { leftAt: null, isSittingOut: false, leaveAfterHand: false },
        });
      }
      return invite.room.joinId;
    });
  }
}
