import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const root = resolve(import.meta.dirname, '..');

async function lobbyApi() {
  return import(resolve(root, 'apps/web/app/lobby-api.ts'));
}

test('lobby shell preserves vertical scrolling for a full nine-player mobile table', async () => {
  const styles = await readFile(resolve(root, 'apps/web/app/globals.css'), 'utf8');
  const shellRule = styles.match(/\.lobby-shell\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.doesNotMatch(shellRule, /overflow\s*:\s*hidden/);
  assert.doesNotMatch(shellRule, /overflow-y\s*:\s*(?:hidden|clip)/);
});

test('mobile table UI keeps the player anchored, reconnects safely, and exposes slider-based thumb-sized actions', async () => {
  const [table, lobby, styles] = await Promise.all([
    readFile(resolve(root, 'apps/web/app/r/[joinId]/table-client.tsx'), 'utf8'),
    readFile(resolve(root, 'apps/web/app/r/[joinId]/lobby-client.tsx'), 'utf8'),
    readFile(resolve(root, 'apps/web/app/globals.css'), 'utf8'),
  ]);

  assert.match(table, /const orderedSeats = useMemo/);
  assert.match(table, /playing-card-slot/);
  assert.match(table, /className="action-primary"/);
  assert.match(table, /socket\.on\('game:state'/);
  assert.match(table, /reconnectionDelayMax:\s*10_000/);
  assert.match(table, /document\.addEventListener\('visibilitychange'/);
  assert.match(table, /type="range"/);
  assert.match(table, /step=\{view\.raise\.minimumIncrement\}/);
  assert.match(table, /raise-quick-actions/);
  assert.doesNotMatch(table.match(/<div className="raise-control"[\s\S]*?<\/div> : null\}/)?.[0] ?? '', /inputMode="numeric"/);
  assert.match(table, /useState\(false\).*showRaiseControls|showRaiseControls.*useState\(false\)/s);
  assert.match(table, /view\.raise && showRaiseControls \? <div className="raise-control"/);
  assert.match(table, /onClick=\{\(\) => setShowRaiseControls\(\(shown\) => !shown\)\}/);
  assert.doesNotMatch(table, /className="action-all-in"/);
  assert.match(table, /onClick=\{\(\) => setRaiseTo\(view\.raise!\.maxRaiseTo\)\}>אול אין/);
  assert.match(table, /game\/final-hand/);
  assert.match(table, /className="table-management-button"/);
  assert.match(table, /management\/transfer-host/);
  assert.match(table, /management\/players\/\$\{encodeURIComponent\(targetPlayerId\)\}\/chips/);
  assert.match(table, /setTimeout\([^]*250\)/);
  assert.match(table, /className="action-notifications"/);
  assert.match(table, /className=\{`seat-action seat-action-\$\{presentedAction\.tone\}`\}/);
  assert.match(table, /receivedAt \+ \(streetChanged \? 5_000 : 10_000\)/);
  assert.match(table, /setActionNotices\(\(current\).*current\[0\]/s);
  assert.match(table, /className="table-seat-avatar" dataUrl=\{seat\.avatarDataUrl\}/);
  assert.match(table, /className="table-seat-info"/);
  assert.match(table, /seenActionSequenceRef/);
  assert.doesNotMatch(table, /`ממתינים ל\$\{activeSeat/);
  assert.doesNotMatch(table, /setInterval\([^]*650\)/);
  assert.match(table, /final-summary/);
  assert.match(table, /className="final-summary-avatar" dataUrl=\{standing\.avatarDataUrl\}/);
  assert.match(table, /className="final-summary-result"/);
  assert.match(table, /standing\.net > 0 \? 'רווח' : standing\.net < 0 \? 'הפסד'/);
  assert.match(styles, /\.final-summary-result strong\s*\{[^}]*font-size:\s*clamp\(1\.25rem/s);
  assert.match(styles, /\.final-summary ul\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(table, /!view\.finalSummaryVisible/);
  assert.match(table, /game\/final-summary\/reveal/);
  assert.match(table, /הצגת הסיכום/);
  assert.match(table, /game\/continue/);
  assert.match(table, /האם היד הבאה תהיה האחרונה/);
  assert.match(table, /כן, עוד יד אחרונה/);
  assert.match(table, /לא, ממשיכים כרגיל/);
  assert.match(table, /management\/players\/\$\{encodeURIComponent\(targetPlayerId\)\}\/removal/);
  assert.doesNotMatch(table, /className="showdown-panel"/);
  assert.match(table, /table-seat-winner/);
  assert.match(table, /playing-card-winning/);
  assert.match(table, /showdownPotLabel\(safeActivePotIndex\)/);
  assert.match(table, /activeShowdownPot\?\.eligibleSeatNumbers/);
  assert.match(table, /activeShowdownPot\?\.payouts/);
  assert.match(table, /setActivePotIndex\(\(current\).*current \+ 1/s);
  assert.match(table, /4_500/);
  assert.match(styles, /\.pot-award-card\s*\{/);
  assert.match(styles, /\.table-seat-pot-eligible\s*\{/);
  assert.match(table, /view\.seats\.filter\(\(seat\) => !seat\.isFolded\)\.length >= 2/);
  assert.match(table, /'לחשוף את היד שלי'/);
  assert.match(styles, /\.table-seat-winner\s*\{/);
  assert.match(styles, /\.playing-card-winning\s*\{/);
  assert.match(styles, /\.action-notification\s*\{/);
  assert.match(styles, /\.community-cards\s*\{[^}]*z-index:\s*7/s);
  assert.match(styles, /\.seat-action-fold\s*\{[^}]*#d77f79/s);
  assert.match(styles, /\.seat-action-call, \.seat-action-bet\s*\{[^}]*#78a7c2/s);
  assert.match(styles, /\.table-seat:nth-child\(3\)\s*\{\s*top:\s*61%/);
  assert.match(styles, /\.table-seat\s*\{[^}]*width:\s*clamp\(104px,[^}]*min-height:\s*clamp\(60px/s);
  assert.match(styles, /\.table-seat-avatar\s*\{[^}]*width:\s*clamp\(34px,[^}]*background-size:\s*cover/s);
  const seatNameRule = styles.match(/\.table-seat strong\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(seatNameRule, /overflow-wrap:\s*anywhere/);
  assert.match(seatNameRule, /white-space:\s*normal/);
  assert.doesNotMatch(seatNameRule, /text-overflow:\s*ellipsis/);
  assert.match(styles, /@keyframes action-notification-in/);
  assert.match(styles, /\.player-panel\s*\{[^}]*position:\s*sticky/s);
  assert.match(styles, /\.action-bar button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(lobby, /lobby\.settings\.initialStack\.toLocaleString\('he-IL'\)/);
  assert.doesNotMatch(lobby, />1,000 צ׳יפים</);
});

test('production uses the same-origin game service and the host route never offers another seat', async () => {
  const [creation, lobbyApi, lobby, table] = await Promise.all([
    readFile(resolve(root, 'apps/web/app/room-creation.ts'), 'utf8'),
    readFile(resolve(root, 'apps/web/app/lobby-api.ts'), 'utf8'),
    readFile(resolve(root, 'apps/web/app/r/[joinId]/lobby-client.tsx'), 'utf8'),
    readFile(resolve(root, 'apps/web/app/r/[joinId]/table-client.tsx'), 'utf8'),
  ]);

  assert.match(creation, /process\.env\.NODE_ENV === 'production'\s*\? '\/server'/);
  assert.match(lobbyApi, /process\.env\.NODE_ENV === 'production'\s*\? '\/server'/);
  assert.match(table, /process\.env\.NODE_ENV === 'production'\s*\? '\/server'/);
  assert.match(lobby, /isHostRoute && lobby && !lobby\.isHost/);
  assert.match(lobby, /location\.replace\(`\/r\/\$\{encodeURIComponent\(joinId\)\}`\)/);
  assert.match(lobby, /אתם כבר יושבים בשולחן כמארחים/);
  assert.doesNotMatch(lobby, /\{lobby\.players\.length\}<b>\/{lobby\.settings\.maxPlayers}/);
});

test('lobby request loads a validated public waiting-room projection with browser cookies', async () => {
  const { loadLobby } = await lobbyApi();
  const requests = [];
  const projection = {
    joinId: 'abc123',
    status: 'WAITING',
    isHost: false,
    isParticipant: false,
    canStart: false,
    settings: { initialStack: 1000, smallBlind: 5, bigBlind: 10, maxPlayers: 6 },
    host: { displayName: 'אורי' },
    players: [{ displayName: 'אורי', initialStack: 1000, currentStack: 1000 }],
  };

  const result = await loadLobby('abc123', {
    fetch: async (...request) => {
      requests.push(request);
      return { status: 200, json: async () => projection };
    },
  });

  assert.deepEqual(requests, [[
    'http://localhost:3001/rooms/abc123',
    { credentials: 'include', cache: 'no-store' },
  ]]);
  assert.deepEqual(result, { ok: true, lobby: projection });
});

test('lobby request hides backend details for malformed, rejected, and network responses', async () => {
  const { loadLobby, LOBBY_LOAD_ERROR_MESSAGE } = await lobbyApi();
  const privateDetail = 'database connection string';
  const cases = [
    async () => ({ status: 500, json: async () => ({ error: privateDetail }) }),
    async () => ({ status: 200, json: async () => ({ joinId: 'abc', players: [] }) }),
    async () => ({ status: 200, json: async () => ({
      joinId: 'another-room', status: 'WAITING', isHost: false, isParticipant: false, canStart: false, settings: { initialStack: 1000, smallBlind: 5, bigBlind: 10, maxPlayers: 6 }, host: { displayName: 'אורי' }, players: [],
    }) }),
    async () => ({ status: 200, json: async () => ({
      joinId: 'abc123', status: 'WAITING', isHost: false, isParticipant: false, canStart: false, settings: { initialStack: 1000, smallBlind: 5, bigBlind: 10, maxPlayers: 6 }, host: { displayName: 'אורי' },
      players: Array.from({ length: 10 }, () => ({ displayName: 'שחקן', initialStack: 1000, currentStack: 1000 })),
    }) }),
    async () => { throw new Error(privateDetail); },
  ];

  for (const fetch of cases) {
    const result = await loadLobby('abc123', { fetch });
    assert.deepEqual(result, { ok: false, message: LOBBY_LOAD_ERROR_MESSAGE });
    assert.doesNotMatch(result.message, new RegExp(privateDetail));
  }
});

test('joining posts only a normalized nickname because the room assigns its configured stack', async () => {
  const { joinLobby } = await lobbyApi();
  const requests = [];

  const result = await joinLobby('abc123', '  נועה  ', {
    fetch: async (...request) => {
      requests.push(request);
      return { status: 201, json: async () => null };
    },
  });

  assert.deepEqual(requests, [[
    'http://localhost:3001/rooms/abc123/join',
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'נועה' }),
    },
  ]]);
  assert.deepEqual(result, { ok: true });
});

test('joining validates nickname locally and returns generic Hebrew errors without reading backend bodies', async () => {
  const { joinLobby, EMPTY_NICKNAME_MESSAGE, ROOM_FULL_MESSAGE, ROOM_NOT_JOINABLE_MESSAGE, LOBBY_JOIN_ERROR_MESSAGE } = await lobbyApi();
  let requested = false;

  const empty = await joinLobby('abc123', '   ', {
    fetch: async () => {
      requested = true;
      throw new Error('must not request');
    },
  });
  assert.equal(requested, false);
  assert.deepEqual(empty, { ok: false, message: EMPTY_NICKNAME_MESSAGE });

  const full = await joinLobby('abc123', 'נועה', {
    fetch: async () => ({ status: 409, json: async () => ({ error: 'private detail' }) }),
  });
  assert.deepEqual(full, { ok: false, message: ROOM_FULL_MESSAGE });

  const completed = await joinLobby('abc123', 'נועה', {
    fetch: async () => ({ status: 409, json: async () => ({ error: { code: 'ROOM_NOT_JOINABLE' } }) }),
  });
  assert.deepEqual(completed, { ok: false, message: ROOM_NOT_JOINABLE_MESSAGE });

  const missing = await joinLobby('abc123', 'נועה', {
    fetch: async () => ({ status: 404, json: async () => ({ error: 'private detail' }) }),
  });
  assert.deepEqual(missing, { ok: false, message: LOBBY_JOIN_ERROR_MESSAGE });
});

test('host start sends only an authenticated, cookie-backed request and keeps failure details private', async () => {
  const { startLobbyGame } = await lobbyApi();
  const requests = [];
  const started = await startLobbyGame('abc123', {
    fetch: async (...request) => { requests.push(request); return { status: 201, json: async () => null }; },
  });
  assert.deepEqual(started, { ok: true });
  assert.deepEqual(requests, [[
    'http://localhost:3001/rooms/abc123/start',
    { method: 'POST', credentials: 'include' },
  ]]);

  const failed = await startLobbyGame('abc123', {
    fetch: async () => ({ status: 409, json: async () => ({ error: 'private database detail' }) }),
  });
  assert.equal(failed.ok, false);
  assert.doesNotMatch(failed.message, /private database detail/);
});
