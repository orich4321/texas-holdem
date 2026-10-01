import { createServer } from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { createApp } from './http-app.js';
import { createOriginPolicy, isAllowedRequestOrigin } from './origin-policy.js';
import { prisma } from './persistence/prisma.js';
import { RoomRepository } from './persistence/room-repository.js';
import { AccountRepository } from './persistence/account-repository.js';
import { SocialRepository } from './persistence/social-repository.js';
import { GoogleOAuth } from './google-oauth.js';
import { createPrivateSnapshotKeyring } from './persistence/private-snapshot-keyring.js';
import { attachSocketSessionTransport } from './socket-transport.js';

// Keep the framework import visible to Vercel's Express entrypoint detector.
void express;

const isOriginAllowed = createOriginPolicy();
const serviceBasePath = process.env.SERVICE_BASE_PATH;
const roomRepository = new RoomRepository(prisma, undefined, undefined, undefined, createPrivateSnapshotKeyring());
const supabaseUrl = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const appOrigin = process.env.PUBLIC_APP_ORIGIN;
// Keep room creation available if the Supabase Google provider has not yet
// been enabled. Explicitly switch over only after the provider is verified.
const accountRepository = process.env.GOOGLE_AUTH_ENABLED === 'true' && supabaseUrl && publishableKey && appOrigin
  ? new AccountRepository(prisma) : undefined;
const socialRepository = accountRepository ? new SocialRepository(prisma) : undefined;
const googleOAuth = accountRepository ? new GoogleOAuth(
  supabaseUrl!, publishableKey!,
  process.env.NODE_ENV === 'production'
    ? `${appOrigin!.replace(/\/$/, '')}/server/auth/google/callback`
    : `${process.env.LOCAL_SERVER_ORIGIN ?? 'http://localhost:3001'}/auth/google/callback`,
) : undefined;
const app = createApp({
  roomRepository,
  accountRepository,
  socialRepository,
  googleOAuth,
  publicAppOrigin: appOrigin,
  isOriginAllowed,
  basePath: serviceBasePath,
});
const httpServer = createServer(app);
const io = new Server(httpServer, {
  path: process.env.SOCKET_IO_PATH ?? '/socket.io',
  cors: {
    // allowRequest below enforces the origin with access to the request Host.
    // Socket.IO's CORS callback has no Host argument, so it only reflects it.
    origin: true,
    credentials: true,
  },
  allowRequest: (request, callback) => callback(
    null,
    isAllowedRequestOrigin(request.headers.origin, request.headers.host, isOriginAllowed),
  ),
});
const port = Number(process.env.SERVER_PORT ?? 3001);

const health = (_request: express.Request, response: express.Response) => {
  response.json({ status: 'ok' });
};
app.get('/health', health);
if (serviceBasePath) app.get(`${serviceBasePath}/health`, health);

attachSocketSessionTransport(io, roomRepository, accountRepository);

// Vercel invokes the exported HTTP server. Local development retains a normal
// listener so the Socket.IO transport can be exercised outside its runtime.
if (!process.env.VERCEL) {
  httpServer.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}

export default httpServer;
