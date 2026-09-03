import { createServer } from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { createOriginPolicy } from './origin-policy.js';

const app = express();
const httpServer = createServer(app);
const isOriginAllowed = createOriginPolicy();
const io = new Server(httpServer, {
  cors: { origin: (origin, callback) => callback(null, isOriginAllowed(origin)) },
  allowRequest: (request, callback) => callback(null, isOriginAllowed(request.headers.origin)),
});
const port = Number(process.env.SERVER_PORT ?? 3001);

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});

io.on('connection', () => undefined);

httpServer.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
