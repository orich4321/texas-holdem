import { createServer } from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { createApp } from './http-app.js';
import { createOriginPolicy } from './origin-policy.js';
import { prisma } from './persistence/prisma.js';
import { RoomRepository } from './persistence/room-repository.js';
import { createPrivateSnapshotKeyring } from './persistence/private-snapshot-keyring.js';
import { attachSocketSessionTransport } from './socket-transport.js';

// Keep the framework import visible to Vercel's Express entrypoint detector.
void express;

const isOriginAllowed = createOriginPolicy();
const roomRepository = new RoomRepository(prisma, undefined, undefined, undefined, createPrivateSnapshotKeyring());
const app = createApp({
  roomRepository,
  isOriginAllowed,
});
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => callback(null, isOriginAllowed(origin)),
    credentials: true,
  },
  allowRequest: (request, callback) => callback(null, isOriginAllowed(request.headers.origin)),
});
const port = Number(process.env.SERVER_PORT ?? 3001);

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});

attachSocketSessionTransport(io, roomRepository);

// Vercel invokes the exported HTTP server. Local development retains a normal
// listener so the Socket.IO transport can be exercised outside its runtime.
if (!process.env.VERCEL) {
  httpServer.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}

export default httpServer;
