import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers';

import { attachSocketSessionTransport } from '../apps/server/src/socket-transport.ts';

const token = 'B'.repeat(43);

test('socket transport authenticates before connection, joins only its authenticated room, and emits no private token', async () => {
  let middleware;
  let connection;
  const io = { use(fn) { middleware = fn; }, on(name, fn) { assert.equal(name, 'connection'); connection = fn; } };
  const repository = {
    async findPlayerByRoomJoinIdAndAccessToken() { return { id: 'player-1', roomId: 'db-room-1', displayName: 'אורי' }; },
    async recoverLatestPlayerViewForPlayer() { return null; },
    async persistPlayerActionAtomically() { throw new Error('not used'); },
  };
  attachSocketSessionTransport(io, repository);

  const handlers = {};
  const socket = { handshake: { auth: { roomJoinId: '0123456789abcdef', playerId: 'attacker' }, headers: { cookie: `poker_player_token=${token}` } }, data: {}, joined: [], emitted: [], join(room) { this.joined.push(room); }, emit(name, payload) { this.emitted.push([name, payload]); }, on(name, handler) { handlers[name] = handler; } };
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
  const repository = {
    async findPlayerByRoomJoinIdAndAccessToken() { throw new Error('should not look up'); },
    async recoverLatestPlayerViewForPlayer() { throw new Error('should not recover'); },
    async persistPlayerActionAtomically() { throw new Error('should not persist'); },
  };
  attachSocketSessionTransport(io, repository);
  const socket = { handshake: { auth: { roomJoinId: '0123456789abcdef' }, headers: {} }, data: {}, join() { throw new Error('must not join'); }, emit() {}, on() {} };
  await assert.rejects(() => new Promise((resolve, reject) => middleware(socket, (error) => error ? reject(error) : resolve())), /unauthorized socket/i);
});

test('socket transport restores and fans out each player’s own view without broadcasting private cards', async () => {
  let middleware;
  let connection;
  const io = { use(fn) { middleware = fn; }, on(_name, fn) { connection = fn; } };
  const views = [
    { playerId: 'player-1', holeCards: [{ rank: 'A', suit: 'spades' }, { rank: 'K', suit: 'spades' }] },
    { playerId: 'player-2', holeCards: [{ rank: 'Q', suit: 'hearts' }, { rank: 'J', suit: 'hearts' }] },
  ];
  const repository = {
    async findPlayerByRoomJoinIdAndAccessToken(joinId, tokenValue) {
      assert.equal(joinId, '0123456789abcdef');
      assert.equal(tokenValue, token);
      return { id: 'player-1', roomId: 'db-room-1', displayName: 'אורי' };
    },
    async recoverLatestPlayerViewForPlayer(_roomId, playerId) { return views.find((view) => view.playerId === playerId) ?? null; },
    async persistPlayerActionAtomically({ roomId, playerId, action }) {
      assert.deepEqual({ roomId, playerId, action }, { roomId: 'db-room-1', playerId: 'player-1', action: { type: 'call' } });
      return { sequence: 1, views };
    },
  };
  attachSocketSessionTransport(io, repository);

  const handlers = {};
  const socket = {
    handshake: { auth: { roomJoinId: '0123456789abcdef' }, headers: { cookie: `poker_player_token=${token}` } }, data: {}, emitted: [],
    join() {}, emit(name, payload) { this.emitted.push([name, payload]); }, on(name, handler) { handlers[name] = handler; },
  };
  await new Promise((resolve, reject) => middleware(socket, (error) => error ? reject(error) : resolve()));
  connection(socket);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.emitted, [
    ['session:ready', { roomJoinId: '0123456789abcdef', playerId: 'player-1', displayName: 'אורי' }],
    ['game:state', views[0]],
  ]);

  handlers['game:action']({ type: 'call', playerId: 'attacker' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.emitted.at(-1), ['game:error', { code: 'ACTION_UNAVAILABLE' }]);

  handlers['game:action']({ type: 'call' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.emitted.at(-1), ['game:state', views[0]]);
  assert.equal(JSON.stringify(socket.emitted).includes('hearts'), false);
});

test('a reconnect authenticates the same durable player session and restores that player’s current view', async () => {
  let middleware;
  let connection;
  let recoveries = 0;
  const io = { use(fn) { middleware = fn; }, on(_name, fn) { connection = fn; } };
  const view = { playerId: 'player-1', street: 'turn', holeCards: [{ rank: 'A', suit: 'spades' }, { rank: 'K', suit: 'spades' }] };
  const repository = {
    async findPlayerByRoomJoinIdAndAccessToken(joinId, tokenValue) {
      assert.equal(joinId, '0123456789abcdef');
      assert.equal(tokenValue, token);
      return { id: 'player-1', roomId: 'db-room-1', displayName: 'אורי' };
    },
    async recoverLatestPlayerViewForPlayer(roomId, playerId) {
      recoveries += 1;
      assert.deepEqual({ roomId, playerId }, { roomId: 'db-room-1', playerId: 'player-1' });
      return view;
    },
    async persistPlayerActionAtomically() { throw new Error('not used'); },
  };
  attachSocketSessionTransport(io, repository);

  const connect = async () => {
    const handlers = {};
    const socket = {
      handshake: { auth: { roomJoinId: '0123456789abcdef' }, headers: { cookie: `poker_player_token=${token}` } }, data: {}, emitted: [],
      join() {}, emit(name, payload) { this.emitted.push([name, payload]); }, on(name, handler) { handlers[name] = handler; },
    };
    await new Promise((resolve, reject) => middleware(socket, (error) => error ? reject(error) : resolve()));
    connection(socket);
    await new Promise((resolve) => setImmediate(resolve));
    return socket;
  };

  const first = await connect();
  const resumed = await connect();
  assert.equal(recoveries, 2);
  assert.deepEqual(first.emitted.at(-1), ['game:state', view]);
  assert.deepEqual(resumed.emitted.at(-1), ['game:state', view]);
  assert.equal(resumed.data.session.playerId, 'player-1');
});
