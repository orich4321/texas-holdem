import assert from 'node:assert/strict';
import { test } from 'node:test';

import { authenticateSocketSession, parseCookieHeader } from '../apps/server/src/socket-session.ts';

const token = 'A'.repeat(43);

test('socket authentication binds room and player identity exclusively from joinId plus the httpOnly cookie', async () => {
  const lookups = [];
  const repository = {
    async findPlayerByRoomJoinIdAndAccessToken(joinId, accessToken) {
      lookups.push([joinId, accessToken]);
      return joinId === '0123456789abcdef' && accessToken === token ? { id: 'player-1', roomId: 'db-room-1', displayName: 'אורי' } : null;
    },
  };

  const identity = await authenticateSocketSession(repository, {
    handshake: {
      auth: { roomJoinId: '0123456789abcdef', playerId: 'attacker', token: 'attacker-token' },
      headers: { cookie: `other=value; poker_player_token=${token}` },
    },
  });

  assert.deepEqual(lookups, [['0123456789abcdef', token]]);
  assert.deepEqual(identity, { roomJoinId: '0123456789abcdef', playerId: 'player-1', roomId: 'db-room-1', displayName: 'אורי' });
});

test('socket authentication rejects missing, malformed, or forged room and cookie data without repository lookup', async () => {
  let lookups = 0;
  const repository = { async findPlayerByRoomJoinIdAndAccessToken() { lookups += 1; return null; } };
  const invalidSockets = [
    { handshake: { auth: { roomJoinId: '' }, headers: { cookie: `poker_player_token=${token}` } } },
    { handshake: { auth: { roomJoinId: '0123456789abcdef' }, headers: {} } },
    { handshake: { auth: { roomJoinId: ['room-1'] }, headers: { cookie: `poker_player_token=${token}` } } },
    { handshake: { auth: { roomJoinId: '0123456789abcdef' }, headers: { cookie: 'poker_player_token=not-a-token' } } },
  ];

  for (const socket of invalidSockets) await assert.rejects(() => authenticateSocketSession(repository, socket), /unauthorized socket/i);
  assert.equal(lookups, 0);
});

test('cookie parsing does not decode or trust duplicate cookie values', () => {
  assert.deepEqual(parseCookieHeader('a=1; poker_player_token=first; poker_player_token=second'), { a: '1' });
  assert.deepEqual(parseCookieHeader('poker_player_token=abc%201; x=y'), { poker_player_token: 'abc%201', x: 'y' });
});
