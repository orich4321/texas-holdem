import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

const SESSION_DAYS = 30;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const profileSelect = { id: true, displayName: true, avatarDataUrl: true, username: true } as const;

export function usernameBaseFromEmail(email: string): string {
  const localPart = email.split('@', 1)[0].toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '');
  return localPart.slice(0, 24) || 'player';
}

export type AccountProfile = Readonly<{
  id: string;
  displayName: string | null;
  avatarDataUrl: string | null;
  username: string | null;
}>;

export type GamePreset = Readonly<{
  id: string;
  name: string;
  initialStack: number;
  smallBlind: number;
  bigBlind: number;
}>;

export class AccountRepository {
  constructor(private readonly db: PrismaClient) {}

  async listGamePresets(accountId: string): Promise<GamePreset[]> {
    return this.db.gamePreset.findMany({
      where: { accountId },
      select: { id: true, name: true, initialStack: true, smallBlind: true, bigBlind: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async saveGamePreset(accountId: string, name: string, initialStack: number, smallBlind: number, bigBlind: number): Promise<GamePreset | null> {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.gamePreset.findUnique({ where: { accountId_name: { accountId, name } }, select: { id: true } });
      if (!existing && await tx.gamePreset.count({ where: { accountId } }) >= 8) return null;
      return tx.gamePreset.upsert({
        where: { accountId_name: { accountId, name } },
        create: { accountId, name, initialStack, smallBlind, bigBlind },
        update: { initialStack, smallBlind, bigBlind },
        select: { id: true, name: true, initialStack: true, smallBlind: true, bigBlind: true },
      });
    });
  }

  async deleteGamePreset(accountId: string, presetId: string): Promise<boolean> {
    const result = await this.db.gamePreset.deleteMany({ where: { id: presetId, accountId } });
    return result.count > 0;
  }

  async createSession(supabaseUserId: string, email: string): Promise<{ token: string; profile: AccountProfile }> {
    let account = await this.db.account.upsert({
      where: { supabaseUserId },
      create: { supabaseUserId },
      update: {},
      select: profileSelect,
    });
    if (!account.username) {
      const base = usernameBaseFromEmail(email);
      for (let suffix = 1; suffix < 10_000 && !account.username; suffix += 1) {
        const postfix = suffix === 1 ? '' : `-${suffix}`;
        const username = `${base.slice(0, 24 - postfix.length)}${postfix}`;
        try {
          const updated = await this.db.account.updateMany({ where: { id: account.id, username: null }, data: { username } });
          account = await this.db.account.findUniqueOrThrow({ where: { id: account.id }, select: profileSelect });
          if (updated.count) break;
        } catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2002') throw error;
        }
      }
      if (!account.username) throw new Error('Unable to allocate username');
    }
    const token = randomBytes(32).toString('base64url');
    await this.db.accountSession.create({
      data: {
        accountId: account.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    return { token, profile: account };
  }

  async findBySession(token: unknown): Promise<AccountProfile | null> {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const session = await this.db.accountSession.findUnique({
      where: { tokenHash: createHash('sha256').update(token).digest('hex') },
      include: { account: { select: profileSelect } },
    });
    return session && session.expiresAt > new Date() ? session.account : null;
  }

  /** Hot-path identity lookup for table polling; profile images stay out of the query. */
  async findIdentityBySession(token: unknown): Promise<{ id: string } | null> {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const session = await this.db.accountSession.findUnique({
      where: { tokenHash: createHash('sha256').update(token).digest('hex') },
      select: { accountId: true, expiresAt: true },
    });
    return session && session.expiresAt > new Date() ? { id: session.accountId } : null;
  }

  async updateProfile(accountId: string, displayName: string, avatarDataUrl: string | null): Promise<AccountProfile> {
    return this.db.$transaction(async (tx) => {
      const profile = await tx.account.update({
        where: { id: accountId },
        data: { displayName, avatarDataUrl },
        select: profileSelect,
      });
      await tx.player.updateMany({
        where: { accountId },
        data: { displayName, avatarDataUrl },
      });
      return profile;
    });
  }

  async revokeSession(token: unknown): Promise<void> {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return;
    await this.db.accountSession.deleteMany({
      where: { tokenHash: createHash('sha256').update(token).digest('hex') },
    });
  }
}
