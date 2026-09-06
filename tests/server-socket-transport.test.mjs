import assert from 'node:assert/strict';
import { test } from 'node:test';

import { attachSocketSessionTransport } from '../apps/server/src/socket-transport.ts';

const token = 'B'.repeat(43);

test('socket transport authenticates before connection, joins only its authenticated room, and emits no private token', async () => {
  let middleware;
  let connection;
  const io = { use(fn) { middleware = fn; }, on(name, fn) { assert.equal(name, 'connection'); connection = fn; } };
  const repository = { async findPlayerByRoomJoinIdAndAccessToken() { return { id: 'player-1', roomId: 'db-room-1', displayName: 'אורי' }; } };
  attachSocketSessionTransport(io, repository);

  const socket = { handshake: { auth: { roomJoinId: '0123456789abcdef', playerId: 'attacker' }, headers: { cookie: `poker_player_token=${token}` } }, data: {}, joined: [], emitted: [], join(room) { this.joined.push(room); }, emit(name, payload) { this.emitted.push([name, payload]); } };
  await new Promise((resolve, reject) => middleware(socket, (error) => error ? reject(error) : resolve()));
  connection(socket);

  assert.deepEqual(socket.joined, ['0123456789abcdef']);
  assert.deepEqual(socket.emitted, [['session:ready', { roomJoinId: '0123456789abcdef', playerId: 'player-1', displayName: 'אורי' }]]);
  assert.equal(JSON.stringify(socket).includes(token), true, 'test fixture has cookie; emitted payload is the public boundary');
  assert.deepEqual(socket.data.session, { roomJoinId: '0123456789abcdef', roomId: 'db-room-1', playerId: 'player-1', displayName: 'אורי' });
});

test('socket transport rejects unauthenticated handshakes before they can join a room', async () => {
  let middleware;
  const io = { use(fn) { middleware = fn; }, on() {} };
  const repository = { async findPlayerByRoomJoinIdAndAccessToken() { throw new Error('should not look up'); } };
  attachSocketSessionTransport(io, repository);
  const socket = { handshake: { auth: { roomJoinId: '0123456789abcdef' }, headers: {} }, data: {}, join() { throw new Error('must not join'); } };
  await assert.rejects(() => new Promise((resolve, reject) => middleware(socket, (error) => error ? reject(error) : resolve())), /unauthorized socket/i);
});
