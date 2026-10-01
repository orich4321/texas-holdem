import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

import { createApp } from '../apps/server/src/http-app.ts';
import { GoogleOAuth, safeAuthDestination } from '../apps/server/src/google-oauth.ts';
import { authenticateSocketSession } from '../apps/server/src/socket-session.ts';

const joinId = '0123456789abcdef';
const accountToken = 'A'.repeat(43);
const account = { id: 'account-1', displayName: 'אורי', avatarDataUrl: null };

async function withServer(roomRepository, accountRepository, run) {
  const app = createApp({
    roomRepository,
    accountRepository,
    googleOAuth: {
      authorizationUrl: () => 'https://example.supabase.co/auth/v1/authorize',
      exchangeCode: async () => '018f7b16-690c-4d1f-9d0b-a8c4a14ae999',
    },
    isOriginAllowed: () => true,
  });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('OAuth destinations never allow external or protocol-relative redirects', () => {
  assert.equal(safeAuthDestination(`/r/${joinId}`), `/r/${joinId}`);
  assert.equal(safeAuthDestination(`/r/${joinId}/host`), `/r/${joinId}/host`);
  for (const input of ['//evil.example', 'https://evil.example', '/\\evil.example', '/admin', '/r/nope']) {
    assert.equal(safeAuthDestination(input), '/');
  }
});

test('Google OAuth uses PKCE and accepts only a verified Google identity from this Supabase project', async () => {
  const verifier = 'v'.repeat(43);
  const calls = [];
  const oauth = new GoogleOAuth('https://project.supabase.co', 'public-key', 'https://poker.example/server/auth/google/callback', async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/token?')) return { ok: true, json: async () => ({ access_token: 'verified-access-token' }) };
    return { ok: true, json: async () => ({ id: '018f7b16-690c-4d1f-9d0b-a8c4a14ae999', app_metadata: { providers: ['google'] } }) };
  });
  const authorizationUrl = new globalThis.URL(oauth.authorizationUrl(verifier));
  assert.equal(authorizationUrl.searchParams.get('provider'), 'google');
  assert.equal(authorizationUrl.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 's256');
  assert.equal(await oauth.exchangeCode('code-12345678', verifier), '018f7b16-690c-4d1f-9d0b-a8c4a14ae999');
  assert.equal(calls[0].init.body, JSON.stringify({ auth_code: 'code-12345678', code_verifier: verifier }));
  assert.equal(calls[1].init.headers.authorization, 'Bearer verified-access-token');

  const badProvider = new GoogleOAuth('https://project.supabase.co', 'public-key', 'https://poker.example/server/auth/google/callback', async (url) => url.includes('/token?')
    ? { ok: true, json: async () => ({ access_token: 'token' }) }
    : { ok: true, json: async () => ({ id: '018f7b16-690c-4d1f-9d0b-a8c4a14ae999', app_metadata: { providers: ['email'] } }) });
  await assert.rejects(badProvider.exchangeCode('code-12345678', verifier), /Google identity required/);
});

test('account-linked rooms use the saved server profile and cannot be created without login', async () => {
  const created = [];
  const rooms = {
    async createRoom(input) {
      created.push(input);
      return { joinId, hostAccessToken: 'H'.repeat(43) };
    },
  };
  const accounts = { async findBySession(token) { return token === accountToken ? account : null; } };
  await withServer(rooms, accounts, async (base) => {
    const body = { displayName: 'forged', avatarDataUrl: null, initialStack: 500, smallBlind: 1, bigBlind: 2 };
    const anonymous = await globalThis.fetch(`${base}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(anonymous.status, 401);
    const loggedIn = await globalThis.fetch(`${base}/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `poker_account_token=${accountToken}` }, body: JSON.stringify(body) });
    assert.equal(loggedIn.status, 201);
    assert.equal(created.length, 1);
    assert.equal(created[0].host.accountId, account.id);
    assert.equal(created[0].host.displayName, account.displayName);
  });
});

test('an account resumes the same socket player despite an unrelated room cookie', async () => {
  const rooms = {
    async findPlayerByRoomJoinIdAndAccountId(room, accountId) {
      assert.equal(room, joinId);
      assert.equal(accountId, account.id);
      return { id: 'same-seat', roomId: 'room-db-id', displayName: account.displayName };
    },
    async findPlayerByRoomJoinIdAndAccessToken() { throw new Error('stale player cookie must not be used'); },
  };
  const accounts = { async findBySession(token) { return token === accountToken ? account : null; } };
  const socket = { handshake: { auth: { roomJoinId: joinId }, headers: { cookie: `poker_player_token=${'X'.repeat(43)}; poker_account_token=${accountToken}` } } };
  const identity = await authenticateSocketSession(rooms, socket, accounts);
  assert.equal(identity.playerId, 'same-seat');
  await assert.rejects(authenticateSocketSession(rooms, { handshake: { auth: { roomJoinId: joinId }, headers: { cookie: 'poker_account_token=forged' } } }, accounts), /Unauthorized socket session/);
});

test('the same Google account rejoins its existing seat and a different account cannot use the host URL', async () => {
  let joins = 0;
  const rooms = {
    async findPlayerByRoomJoinIdAndAccountId(_joinId, accountId) {
      return accountId === account.id ? { id: 'host-seat', roomId: 'db-room-id', displayName: 'אורי' } : null;
    },
    async findPlayerByRoomJoinIdAndAccessToken() { return null; },
    async findRoomByJoinId() { return { hostPlayerId: 'host-seat' }; },
    async joinWaitingRoom() { joins += 1; throw new Error('Duplicate seat must not be created'); },
  };
  const accounts = {
    async findBySession(token) {
      if (token === accountToken) return account;
      if (token === 'B'.repeat(43)) return { id: 'other-account', displayName: 'אחר', avatarDataUrl: null };
      return null;
    },
  };
  await withServer(rooms, accounts, async (base) => {
    const reused = await globalThis.fetch(`${base}/rooms/${joinId}/join`, {
      method: 'POST', headers: { cookie: `poker_account_token=${accountToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'forged' }),
    });
    assert.equal(reused.status, 200);
    assert.equal(joins, 0);

    const host = await globalThis.fetch(`${base}/rooms/${joinId}/host-access`, { headers: { cookie: `poker_account_token=${accountToken}` } });
    assert.equal(host.status, 200);
    const other = await globalThis.fetch(`${base}/rooms/${joinId}/host-access`, { headers: { cookie: `poker_account_token=${'B'.repeat(43)}` } });
    assert.equal(other.status, 403);
  });
});

test('OAuth callback issues only an opaque httpOnly account cookie and profile edits require it', async () => {
  const updates = [];
  const accounts = {
    async createSession() { return { token: accountToken, profile: { ...account, displayName: null } }; },
    async findBySession(token) { return token === accountToken ? account : null; },
    async updateProfile(id, name, avatar) {
      updates.push([id, name, avatar]);
      return { ...account, displayName: name, avatarDataUrl: avatar };
    },
  };
  await withServer({}, accounts, async (base) => {
    const started = await globalThis.fetch(`${base}/auth/google/start?next=%2F%2Fevil.example`, { redirect: 'manual' });
    assert.equal(started.status, 302);
    const verifierCookie = started.headers.getSetCookie().find((cookie) => cookie.startsWith('poker_oauth_verifier='));
    assert.match(verifierCookie, /HttpOnly/);
    const verifier = verifierCookie.split(';')[0];
    const next = started.headers.getSetCookie().find((cookie) => cookie.startsWith('poker_oauth_next=')).split(';')[0];
    const callback = await globalThis.fetch(`${base}/auth/google/callback?code=good-code-12345`, {
      headers: { cookie: `${verifier}; ${next}` }, redirect: 'manual',
    });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/profile?next=%2F');
    const sessionCookie = callback.headers.getSetCookie().find((cookie) => cookie.startsWith('poker_account_token='));
    assert.match(sessionCookie, /HttpOnly/);
    assert.doesNotMatch(sessionCookie, /good-code|access_token/i);

    const anonymousEdit = await globalThis.fetch(`${base}/auth/profile`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'חדש' }),
    });
    assert.equal(anonymousEdit.status, 401);
    const edit = await globalThis.fetch(`${base}/auth/profile`, {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie: `poker_account_token=${accountToken}` }, body: JSON.stringify({ displayName: 'חדש' }),
    });
    assert.equal(edit.status, 200);
    assert.deepEqual(updates, [[account.id, 'חדש', null]]);
  });
});
