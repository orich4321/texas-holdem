import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

import { createApp } from '../apps/server/src/http-app.ts';
import { GoogleOAuth, safeAuthDestination } from '../apps/server/src/google-oauth.ts';
import { authenticateSocketSession } from '../apps/server/src/socket-session.ts';
import { AccountRepository, usernameBaseFromEmail } from '../apps/server/src/persistence/account-repository.ts';
import { SocialRepository } from '../apps/server/src/persistence/social-repository.ts';

const joinId = '0123456789abcdef';
const accountToken = 'A'.repeat(43);
const account = { id: 'account-1', displayName: 'אורי', avatarDataUrl: null };

async function withServer(roomRepository, accountRepository, run, socialRepository) {
  const app = createApp({
    roomRepository,
    accountRepository,
    socialRepository,
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
  assert.equal(safeAuthDestination(`/history/${joinId}`), `/history/${joinId}`);
  for (const input of ['//evil.example', 'https://evil.example', '/\\evil.example', '/admin', '/r/nope']) {
    assert.equal(safeAuthDestination(input), '/');
  }
});

test('friends and room invitations require authenticated recipients and the actual room host', async () => {
  const requestId = '018f7b16-690c-4d1f-9d0b-a8c4a14ae999';
  const otherId = '018f7b16-690c-4d1f-9d0b-a8c4a14ae998';
  const calls = [];
  const accounts = { async findIdentityBySession(token) {
    return token === accountToken ? { id: account.id } : token === 'B'.repeat(43) ? { id: otherId } : null;
  } };
  const rooms = {
    async findPlayerByRoomJoinIdAndAccountId(_joinId, accountId) { return accountId === account.id ? { id: 'host-player' } : null; },
    async findPlayerByRoomJoinIdAndAccessToken() { return null; },
    async findRoomByJoinId() { return { hostPlayerId: 'host-player' }; },
  };
  const social = {
    async overview(id) { calls.push(['overview', id]); return { friends: [], incoming: [], outgoing: [], invitations: [] }; },
    async listUsers(id, cursor) { calls.push(['users', id, cursor]); return { users: [{ id: otherId, username: 'other', displayName: 'אחר', avatarDataUrl: null }], nextCursor: null }; },
    async notificationSnapshot(id) { calls.push(['notifications', id]); return { invitations: [], pendingFriendRequests: 1 }; },
    async requestFriend(id, username) { calls.push(['request', id, username]); return 'sent'; },
    async answerFriendRequest(id, target, accept) { calls.push(['answer', id, target, accept]); return id === otherId; },
    async inviteFriend(room, id, target) { calls.push(['invite', room, id, target]); return 'sent'; },
    async answerGameInvite(id, target, accept) { calls.push(['invite-answer', id, target, accept]); return id === otherId ? joinId : null; },
  };
  await withServer(rooms, accounts, async (base) => {
    const json = { 'content-type': 'application/json' };
    assert.equal((await globalThis.fetch(`${base}/social`)).status, 401);
    assert.equal((await globalThis.fetch(`${base}/social`, { headers: { cookie: `poker_account_token=${accountToken}` } })).status, 200);
    assert.equal((await globalThis.fetch(`${base}/social/users`)).status, 401);
    assert.equal((await globalThis.fetch(`${base}/social/users?cursor=bad%20cursor`, { headers: { cookie: `poker_account_token=${accountToken}` } })).status, 400);
    const directory = await globalThis.fetch(`${base}/social/users?cursor=ori`, { headers: { cookie: `poker_account_token=${accountToken}` } });
    assert.equal(directory.status, 200);
    assert.equal(directory.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await directory.json(), { users: [{ id: otherId, username: 'other', displayName: 'אחר', avatarDataUrl: null }], nextCursor: null });
    assert.deepEqual(calls.find((call) => call[0] === 'users'), ['users', account.id, 'ori']);
    const notifications = await globalThis.fetch(`${base}/social/invitations`, { headers: { cookie: `poker_account_token=${accountToken}` } });
    assert.deepEqual(await notifications.json(), { invitations: [], pendingFriendRequests: 1 });
    const friendRequest = await globalThis.fetch(`${base}/social/friend-requests`, { method: 'POST', headers: { ...json, cookie: `poker_account_token=${accountToken}` }, body: JSON.stringify({ username: 'OriCh4321' }) });
    assert.equal(friendRequest.status, 201);
    assert.deepEqual(calls.find((call) => call[0] === 'request'), ['request', account.id, 'orich4321']);
    const wrongRecipient = await globalThis.fetch(`${base}/social/friend-requests/${requestId}`, { method: 'PUT', headers: { ...json, cookie: `poker_account_token=${accountToken}` }, body: JSON.stringify({ accept: true }) });
    assert.equal(wrongRecipient.status, 404);
    const accepted = await globalThis.fetch(`${base}/social/friend-requests/${requestId}`, { method: 'PUT', headers: { ...json, cookie: `poker_account_token=${'B'.repeat(43)}` }, body: JSON.stringify({ accept: true }) });
    assert.equal(accepted.status, 204);
    const forgedInvite = await globalThis.fetch(`${base}/rooms/${joinId}/invites`, { method: 'POST', headers: { ...json, cookie: `poker_account_token=${'B'.repeat(43)}` }, body: JSON.stringify({ friendId: otherId }) });
    assert.equal(forgedInvite.status, 403);
    const sentInvite = await globalThis.fetch(`${base}/rooms/${joinId}/invites`, { method: 'POST', headers: { ...json, cookie: `poker_account_token=${accountToken}` }, body: JSON.stringify({ friendId: otherId }) });
    assert.equal(sentInvite.status, 201);
    assert.deepEqual(calls.find((call) => call[0] === 'invite'), ['invite', joinId, account.id, otherId]);
    const wrongInviteRecipient = await globalThis.fetch(`${base}/social/invitations/${requestId}`, { method: 'PUT', headers: { ...json, cookie: `poker_account_token=${accountToken}` }, body: JSON.stringify({ accept: true }) });
    assert.equal(wrongInviteRecipient.status, 404);
    const acceptedInvite = await globalThis.fetch(`${base}/social/invitations/${requestId}`, { method: 'PUT', headers: { ...json, cookie: `poker_account_token=${'B'.repeat(43)}` }, body: JSON.stringify({ accept: true }) });
    assert.equal(acceptedInvite.status, 200);
    assert.deepEqual(await acceptedInvite.json(), { joinPath: `/r/${joinId}` });
  }, social);
});

test('user directory is bounded, ordered, excludes the requester, and selects no email', async () => {
  const queries = [];
  const rows = Array.from({ length: 21 }, (_, index) => ({ id: `user-${index}`, username: `user${String(index).padStart(2, '0')}`, displayName: `שחקן ${index}`, avatarDataUrl: null }));
  const repository = new SocialRepository({ account: { async findMany(query) { queries.push(query); return rows; } } });
  const first = await repository.listUsers(account.id);
  assert.equal(first.users.length, 20);
  assert.equal(first.nextCursor, 'user19');
  await repository.listUsers(account.id, first.nextCursor);
  assert.deepEqual(queries[0].where, {
    id: { not: account.id },
    displayName: { not: null },
    username: { not: null },
    OR: [{ directoryVisibleToAccountId: null }, { directoryVisibleToAccountId: account.id }],
  });
  assert.deepEqual(queries[1].where.username, { not: null, gt: 'user19' });
  assert.deepEqual(queries[0].orderBy, { username: 'asc' });
  assert.equal(queries[0].take, 21);
  assert.deepEqual(queries[0].select, { id: true, username: true, displayName: true, avatarDataUrl: true });
});

test('private test accounts are listed only for their designated account', async () => {
  const ownerId = '018f7b16-690c-4d1f-9d0b-a8c4a14ae999';
  const otherId = '018f7b16-690c-4d1f-9d0b-a8c4a14ae998';
  const records = [
    { id: 'test-1', username: 'orich4320', displayName: 'טסט', avatarDataUrl: null, directoryVisibleToAccountId: ownerId },
    { id: 'test-2', username: 'orich4322', displayName: 'בדיקה', avatarDataUrl: null, directoryVisibleToAccountId: ownerId },
    { id: 'public', username: 'public', displayName: 'שחקן', avatarDataUrl: null, directoryVisibleToAccountId: null },
  ];
  const repository = new SocialRepository({ account: { async findMany({ where, select }) {
    return records.filter((record) => record.id !== where.id.not
      && where.OR.some((condition) => condition.directoryVisibleToAccountId === record.directoryVisibleToAccountId))
      .map((record) => Object.fromEntries(Object.keys(select).map((key) => [key, record[key]])));
  } } });
  assert.deepEqual((await repository.listUsers(ownerId)).users.map((user) => user.username), ['orich4320', 'orich4322', 'public']);
  assert.deepEqual((await repository.listUsers(otherId)).users.map((user) => user.username), ['public']);
});

test('private accounts are also excluded from friend lists, request counts, and direct friend requests', async () => {
  const ownerId = '018f7b16-690c-4d1f-9d0b-a8c4a14ae999';
  const otherId = '018f7b16-690c-4d1f-9d0b-a8c4a14ae998';
  const queries = {};
  const repository = new SocialRepository({
    account: { async findUnique() { return { id: 'private', directoryVisibleToAccountId: ownerId }; } },
    friend: { async findMany(query) { queries.friends = query; return []; } },
    friendRequest: {
      async findMany(query) { (queries.requests ??= []).push(query); return []; },
      async count(query) { queries.count = query; return 0; },
    },
    gameInvite: { async findMany() { return []; } },
  });
  assert.equal(await repository.requestFriend(otherId, 'orich4320'), 'not-found');
  await repository.overview(otherId);
  await repository.notificationSnapshot(otherId);
  const visible = { OR: [{ directoryVisibleToAccountId: null }, { directoryVisibleToAccountId: otherId }] };
  assert.deepEqual(queries.friends.where.OR, [
    { accountAId: otherId, accountB: { is: visible } },
    { accountBId: otherId, accountA: { is: visible } },
  ]);
  assert.deepEqual(queries.requests[0].where, { toAccountId: otherId, fromAccount: { is: visible } });
  assert.deepEqual(queries.requests[1].where, { fromAccountId: otherId, toAccount: { is: visible } });
  assert.deepEqual(queries.count.where, { toAccountId: otherId, fromAccount: { is: visible } });
});

test('Google OAuth uses PKCE and accepts only a verified Google identity from this Supabase project', async () => {
  const verifier = 'v'.repeat(43);
  const calls = [];
  const oauth = new GoogleOAuth('https://project.supabase.co', 'public-key', 'https://poker.example/server/auth/google/callback', async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/token?')) return { ok: true, json: async () => ({ access_token: 'verified-access-token' }) };
    return { ok: true, json: async () => ({ id: '018f7b16-690c-4d1f-9d0b-a8c4a14ae999', email: 'orich4321@gmail.com', app_metadata: { providers: ['google'] } }) };
  });
  const authorizationUrl = new globalThis.URL(oauth.authorizationUrl(verifier));
  assert.equal(authorizationUrl.searchParams.get('provider'), 'google');
  assert.equal(authorizationUrl.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 's256');
  assert.deepEqual(await oauth.exchangeCode('code-12345678', verifier), { id: '018f7b16-690c-4d1f-9d0b-a8c4a14ae999', email: 'orich4321@gmail.com' });
  assert.equal(usernameBaseFromEmail('orich4321@gmail.com'), 'orich4321');
  assert.equal(usernameBaseFromEmail('Ori.Name+foo@example.com'), 'ori.name-foo');
  assert.equal(calls[0].init.body, JSON.stringify({ auth_code: 'code-12345678', code_verifier: verifier }));
  assert.equal(calls[1].init.headers.authorization, 'Bearer verified-access-token');

  const badProvider = new GoogleOAuth('https://project.supabase.co', 'public-key', 'https://poker.example/server/auth/google/callback', async (url) => url.includes('/token?')
    ? { ok: true, json: async () => ({ access_token: 'token' }) }
    : { ok: true, json: async () => ({ id: '018f7b16-690c-4d1f-9d0b-a8c4a14ae999', app_metadata: { providers: ['email'] } }) });
  await assert.rejects(badProvider.exchangeCode('code-12345678', verifier), /Google identity required/);
});

test('OAuth username allocation adds a suffix when another Google email uses the same local part', async () => {
  let storedUsername = null;
  const attempts = [];
  const db = {
    account: {
      async upsert() { return { id: account.id, username: null, displayName: null, avatarDataUrl: null }; },
      async updateMany({ data }) {
        attempts.push(data.username);
        if (data.username === 'orich4321') throw { code: 'P2002' };
        storedUsername = data.username;
        return { count: 1 };
      },
      async findUniqueOrThrow() { return { id: account.id, username: storedUsername, displayName: null, avatarDataUrl: null }; },
    },
    accountSession: { async create() { return {}; } },
  };
  const result = await new AccountRepository(db).createSession('018f7b16-690c-4d1f-9d0b-a8c4a14ae999', 'orich4321@another.example');
  assert.equal(result.profile.username, 'orich4321-2');
  assert.deepEqual(attempts, ['orich4321', 'orich4321-2']);
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

test('saved game settings are scoped to the authenticated account and validated by the server', async () => {
  const presetId = '018f7b16-690c-4d1f-9d0b-a8c4a14ae999';
  const saved = [];
  const deleted = [];
  const accounts = {
    async findIdentityBySession(token) {
      return token === accountToken ? { id: account.id } : token === 'B'.repeat(43) ? { id: 'another-account' } : null;
    },
    async listGamePresets(accountId) { return saved.filter((item) => item.accountId === accountId); },
    async saveGamePreset(accountId, name, initialStack, smallBlind, bigBlind) {
      const preset = { id: presetId, name, initialStack, smallBlind, bigBlind, accountId };
      saved.push(preset);
      return preset;
    },
    async deleteGamePreset(accountId, id) {
      deleted.push([accountId, id]);
      return accountId === account.id && id === presetId;
    },
  };
  await withServer({}, accounts, async (base) => {
    const endpoint = `${base}/auth/game-presets`;
    const body = JSON.stringify({ name: 'משחק קצר', initialStack: 500, smallBlind: 1, bigBlind: 2 });
    const anonymous = await globalThis.fetch(endpoint);
    assert.equal(anonymous.status, 401);
    const invalid = await globalThis.fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: `poker_account_token=${accountToken}` }, body: JSON.stringify({ name: 'רע', initialStack: 500, smallBlind: 5, bigBlind: 2 }) });
    assert.equal(invalid.status, 400);
    const created = await globalThis.fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: `poker_account_token=${accountToken}` }, body });
    assert.equal(created.status, 200);
    assert.equal(saved.length, 1);
    const own = await globalThis.fetch(endpoint, { headers: { cookie: `poker_account_token=${accountToken}` } });
    assert.equal((await own.json()).presets.length, 1);
    const other = await globalThis.fetch(endpoint, { headers: { cookie: `poker_account_token=${'B'.repeat(43)}` } });
    assert.deepEqual((await other.json()).presets, []);
    const forbiddenDelete = await globalThis.fetch(`${endpoint}/${presetId}`, { method: 'DELETE', headers: { cookie: `poker_account_token=${'B'.repeat(43)}` } });
    assert.equal(forbiddenDelete.status, 404);
    const ownDelete = await globalThis.fetch(`${endpoint}/${presetId}`, { method: 'DELETE', headers: { cookie: `poker_account_token=${accountToken}` } });
    assert.equal(ownDelete.status, 204);
    assert.deepEqual(deleted, [['another-account', presetId], [account.id, presetId]]);
  });
});
