import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
};

const databaseUrl = process.env.NODE_ENV === 'test'
  ? process.env.TEST_DATABASE_URL
  : process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required (TEST_DATABASE_URL when NODE_ENV=test)');
}

// Vercel scales the service into short-lived instances. Keep each instance to
// one PostgreSQL connection so Supabase's transaction pooler is not exhausted
// by Prisma's default application-side pool.
const adapter = new PrismaPg({
  connectionString: databaseUrl,
  max: 1,
});

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
