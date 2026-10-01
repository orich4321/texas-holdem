import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

const SESSION_DAYS = 30;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const profileSelect = { id: true, displayName: true, avatarDataUrl: true } as const;

export type AccountProfile = Readonly<{
  id: string;
  displayName: string | null;
  avatarDataUrl: string | null;
}>;

export class AccountRepository {
  constructor(private readonly db: PrismaClient) {}

  async createSession(supabaseUserId: string): Promise<{ token: string; profile: AccountProfile }> {
    const account = await this.db.account.upsert({
      where: { supabaseUserId },
      create: { supabaseUserId },
      update: {},
      select: profileSelect,
    });
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
