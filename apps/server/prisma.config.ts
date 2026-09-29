import { defineConfig, env } from 'prisma/config';

const databaseUrl = env('DATABASE_URL');

// Supabase's transaction pooler (port 6543) is ideal for the short-lived
// runtime connections used by Vercel, but Prisma migrations require a
// session connection. Both poolers use the same host and credentials, so
// Prisma CLI commands can safely use the session-pooler port instead.
const prismaCliUrl = databaseUrl.replace(/:6543(?=\/)/, ':5432');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: prismaCliUrl,
  },
});
