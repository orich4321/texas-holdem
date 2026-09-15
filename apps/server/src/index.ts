import { createServer } from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { createApp } from './http-app.js';
import { createOriginPolicy, isAllowedRequestOrigin } from './origin-policy.js';
import { prisma } from './persistence/prisma.js';
import { RoomRepository } from './persistence/room-repository.js';
import { createPrivateSnapshotKeyring } from './persistence/private-snapshot-keyring.js';
import { attachSocketSessionTransport } from './socket-transport.js';

// Keep the framework import visible to Vercel's Express entrypoint detector.
void express;

const isOriginAllowed = createOriginPolicy();
const serviceBasePath = process.env.SERVICE_BASE_PATH;
const roomRepository = new RoomRepository(prisma, undefined, undefined, undefined, createPrivateSnapshotKeyring());
const app = createApp({
  roomRepository,
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

attachSocketSessionTransport(io, roomRepository);

// Vercel invokes the exported HTTP server. Local development retains a normal
// listener so the Socket.IO transport can be exercised outside its runtime.
if (!process.env.VERCEL) {
  httpServer.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}

export default httpServer;
