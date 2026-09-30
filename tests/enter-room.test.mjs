import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const code = 'a1b2c3d4e5f60708';

async function entry() {
  return import(pathToFileURL(resolve(root, 'apps/web/app/enter-room/enter-room.ts')).href);
}

const lobby = {
  joinId: code,
  status: 'WAITING',
  isHost: false,
  isParticipant: false,
  canStart: false,
  settings: { initialStack: 500, smallBlind: 1, bigBlind: 2, maxPlayers: 9 },
  host: { displayName: 'Host' },
  players: [{ displayName: 'Host', initialStack: 500, currentStack: 500 }],
};

test('room-code entry rejects malformed codes without a request or navigation', async () => {
  const { enterRoomWithCode, normalizeRoomCode } = await entry();
  let requests = 0;
  let navigations = 0;
  assert.equal(normalizeRoomCode(' A1B2-C3D4 E5F60708 '), code);
  const result = await enterRoomWithCode('not-a-code', {
    fetch: async () => { requests += 1; throw new Error('must not fetch'); },
    navigate: () => { navigations += 1; },
  });
  assert.equal(result.ok, false);
  assert.equal(requests, 0);
  assert.equal(navigations, 0);
});

test('a valid room code resolves the public room then opens its guest profile flow', async () => {
  const { enterRoomWithCode } = await entry();
  const requests = [];
  const navigations = [];
  const result = await enterRoomWithCode('A1B2-C3D4-E5F6-0708', {
    fetch: async (...request) => {
      requests.push(request);
      return { status: 200, json: async () => lobby };
    },
    navigate: (path) => navigations.push(path),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(requests, [[
    'http://localhost:3001/rooms/a1b2c3d4e5f60708',
    { credentials: 'include', cache: 'no-store' },
  ]]);
  assert.deepEqual(navigations, [`/r/${code}`]);
});

test('unknown or completed room codes never navigate into a guest flow', async () => {
  const { enterRoomWithCode } = await entry();
  const navigations = [];
  for (const response of [
    { status: 404, json: async () => ({}) },
    { status: 200, json: async () => ({ ...lobby, status: 'COMPLETED' }) },
  ]) {
    const result = await enterRoomWithCode(code, {
      fetch: async () => response,
      navigate: (path) => navigations.push(path),
    });
    assert.equal(result.ok, false);
  }
  assert.deepEqual(navigations, []);
});

test('entry page and host controls expose the room code without changing join or host authorization', async () => {
  const [page, lobbyClient, tableClient] = await Promise.all([
    readFile(resolve(root, 'apps/web/app/enter-room/page.tsx'), 'utf8'),
    readFile(resolve(root, 'apps/web/app/r/[joinId]/lobby-client.tsx'), 'utf8'),
    readFile(resolve(root, 'apps/web/app/r/[joinId]/table-client.tsx'), 'utf8'),
  ]);
  assert.match(page, /enterRoomWithCode/);
  assert.match(page, /המשך לבחירת שם ותמונה/);
  assert.match(lobbyClient, /קוד החדר/);
  assert.match(tableClient, /קוד החדר/);
  assert.match(lobbyClient, /joinLobby\(joinId, nickname/);
});
