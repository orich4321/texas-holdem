import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

async function lobbyApi() {
  return import(pathToFileURL(resolve(root, 'apps/web/app/lobby-api.ts')).href);
}

test('lobby scrolls to its start button on narrow and short screens', async () => {
  const styles = await readFile(resolve(root, 'apps/web/app/globals.css'), 'utf8');
  const shellRule = styles.match(/\.lobby-shell\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.doesNotMatch(shellRule, /overflow\s*:\s*hidden/);
  assert.doesNotMatch(shellRule, /overflow-y\s*:\s*(?:hidden|clip)/);
  const mobile = styles.split('@media (max-width: 760px) {')[1]?.split('@media (max-height: 740px) {')[0] ?? '';
  const shortLandscape = styles.split('@media (orientation: landscape) and (max-height: 560px) {')[1]?.split('@media (min-width: 1180px)')[0] ?? '';
  for (const responsiveRules of [mobile, shortLandscape]) {
    assert.match(responsiveRules, /\.lobby-shell\s*\{[^}]*overflow-y:\s*auto/);
    assert.match(responsiveRules, /\.lobby-card\s*\{[^}]*min-height:\s*max-content/);
    assert.match(responsiveRules, /\.lobby-roster ul\s*\{[^}]*overflow-y:\s*visible/);
  }
  assert.match(mobile, /\.lobby-content\s*\{[^}]*grid-template-rows:\s*auto auto/);
});

test('mobile table UI keeps the player anchored, reconnects safely, and exposes chip-based thumb-sized actions', async () => {
  const [table, lobby, styles] = await Promise.all([
    readFile(resolve(root, 'apps/web/app/r/[joinId]/table-client.tsx'), 'utf8'),
    readFile(resolve(root, 'apps/web/app/r/[joinId]/lobby-client.tsx'), 'utf8'),
    readFile(resolve(root, 'apps/web/app/globals.css'), 'utf8'),
  ]);

  assert.match(table, /const orderedSeats = useMemo/);
  assert.match(table, /playing-card-slot/);
  assert.match(table, /className="action-primary"/);
  assert.match(table, /socket\?\.on\('game:state'/);
  assert.match(table, /reconnectionDelayMax:\s*10_000/);
  assert.match(table, /document\.addEventListener\('visibilitychange'/);
  assert.match(table, /CHIP_VALUES\.map\(\(value\)/);
  assert.match(table, /className=\{`chip-tray\$\{!isTurn \|\| !canBetWithChips/);
  assert.match(table, /className="chip-piles"/);
  assert.doesNotMatch(table, /type="range"/);
  assert.doesNotMatch(table, /showRaiseControls/);
  assert.match(table, /ownSeat && !ownSeat\.isSittingOut \? <section/);
  assert.match(table, /onPointerUpCapture=\{handleTablePointerUp\}/);
  assert.match(table, /void act\(\{ type: 'check' \}\)/);
  assert.match(table, /onPointerMove=\{moveCardDrag\}/);
  assert.match(table, /void act\(\{ type: 'fold' \}\)/);
  assert.doesNotMatch(table, /className="action-fold"/);
  assert.doesNotMatch(table, />צ׳ק<\/button>/);
  assert.match(table, /isTurn && view\.toCall > 0 \? <div className="action-bar"/);
  assert.match(table, /isTurn && canBetWithChips \? <div className="chip-tray-actions"/);
  assert.match(table, /selectedRaiseTo === view\.allInRaiseTo \? \{ type: 'all-in' \}/);
  assert.match(table, /selectedRaiseTo === view\.allInRaiseTo \|\| \(view\.raise && selectedRaiseTo >= view\.raise\.minRaiseTo/);
  assert.match(table, /className="table-wagers"/);
  assert.match(table, /className="table-board-actions"/);
  assert.match(table, /isCurrentHost && !view\.finalSummaryVisible && \(view\.allInRunout \|\| view\.rabbitRunout \|\| view\.showdown\)/);
  assert.doesNotMatch(table, /className="all-in-runout-panel"/);
  assert.match(styles, /\.player-panel:has\(\.chip-tray\) \{ height: clamp/);
  assert.match(styles, /\.player-panel:has\(\.chip-tray\) \{[^}]*grid-template-rows: minmax\(0,1fr\) auto;[^}]*overflow: visible;/);
  assert.match(styles, /\.pre-action-bar \{ grid-column: 3; grid-row: 1;/);
  assert.match(styles, /\.chip-tray \{ grid-column: 1\/-1; grid-row: 2;/);
  assert.match(styles, /\.seat-wager \.chip-amount-piece > \.bet-chip \{ width: 20px; height: 20px;/);
  assert.match(table, /'--wager-mobile-y': `\$\{50 \+ Math\.sin\(angle\) \* 34\}%`/);
  assert.match(styles, /\.table-board-actions \{ position: absolute/);
  assert.match(table, /<ChipAmount amount=\{seat\.currentBet\}/);
  assert.doesNotMatch(table, /className="action-all-in"/);
  assert.match(table, /onClick=\{\(\) => setChipTray\(selectAllChips\)\}>אול אין/);
  assert.match(styles, /\.chip-tray-actions \{ display: grid/);
  assert.match(styles, /\.chip-tray-footer button \{[^}]*min-height: 44px;/);
  assert.match(styles, /\.chip-tray-footer \{ display: grid; grid-template-columns:/);
  assert.match(table, /className="chip-tray-footer"><button[^]*className="chip-bet-submit"[^]*className="chip-all-in"[^]*>איפוס<\/button>/);
  assert.match(table, /game\/final-hand/);
  assert.match(table, /className="table-management-button"/);
  assert.match(table, /management\/transfer-host/);
  assert.match(table, /management\/players\/\$\{encodeURIComponent\(targetPlayerId\)\}\/chips/);
  assert.match(table, /setTimeout\([^]*250\)/);
  assert.doesNotMatch(table, /className="action-notifications"/);
  assert.match(table, /className=\{`seat-action seat-action-\$\{presentedAction\.tone\}`\}/);
  assert.doesNotMatch(table, /setActionNotices/);
  assert.match(table, /className="table-seat-avatar" dataUrl=\{seat\.avatarDataUrl\}/);
  assert.match(table, /className="table-seat-info"/);
  assert.match(table, /seenActionSequenceRef/);
  assert.match(table, /className="table-timer"/);
  assert.match(table, /gameStartedAt/);
  assert.match(table, /game\/runout\/uncontested/);
  assert.match(table, /חשיפת \$\{streetNames\[view\.rabbitRunout\.nextStreet\]\}/);
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
  assert.match(styles, /\.pot-award-card\s*\{[^}]*grid-row:\s*2/s);
  assert.doesNotMatch(styles, /\.pot-award-card\s*\{[^}]*position:\s*absolute/s);
  assert.match(styles, /\.table-seat-pot-eligible\s*\{/);
  assert.match(table, /selectedRaiseTo === view\.allInRaiseTo \? \{ type: 'all-in' \}/);
  assert.match(table, /seat\.seatNumber === view\.smallBlindSeat/);
  assert.match(table, /seat\.seatNumber === view\.bigBlindSeat/);
  assert.match(table, /table-seat-sitting-out/);
  assert.match(styles, /\.table-seat-sitting-out\s*\{/);
  assert.match(table, /view\?\.holeCards\.length === 2/);
  assert.doesNotMatch(table, /canRevealAtShowdown[\s\S]{0,250}!ownSeat\.isFolded/);
  assert.match(table, /בחרו קלף לחשיפה/);
  assert.match(table, /JSON\.stringify\(\{ cardIndex \}\)/);
  assert.match(table, /setSeatActions\(new Map\(\)\)/);
  assert.match(table, /if \(view\?\.street !== 'showdown'\) return;\s*setSeatActions\(new Map\(\)\);/s);
  assert.match(styles, /\.reveal-card-picker\s*\{/);
  assert.match(styles, /\.table-seat-winner\s*\{/);
  assert.match(styles, /\.playing-card-winning\s*\{/);
  assert.doesNotMatch(styles, /\.action-notification\s*\{/);
  assert.match(styles, /\.community-cards\s*\{[^}]*z-index:\s*7/s);
  assert.match(styles, /\.seat-action-fold\s*\{[^}]*#d77f79/s);
  assert.match(styles, /\.seat-action-call, \.seat-action-bet\s*\{[^}]*#78a7c2/s);
  assert.match(table, /function seatPosition\(index: number, count: number\)/);
  assert.match(table, /index \* 360/);
  assert.match(table, /style=\{seatPosition\(seatIndex, orderedSeats\.length\)\}/);
  assert.match(styles, /\.table-seat\s*\{[^}]*top:\s*var\(--seat-y\);[^}]*left:\s*var\(--seat-x\)/s);
  assert.match(styles, /top:\s*var\(--seat-mobile-y\);\s*left:\s*var\(--seat-mobile-x\)/);
  assert.match(styles, /\.table-seat\s*\{[^}]*width:\s*clamp\(104px,[^}]*min-height:\s*clamp\(60px/s);
  assert.match(styles, /\.table-seat-avatar\s*\{[^}]*width:\s*clamp\(34px,[^}]*background-size:\s*cover/s);
  assert.match(table, /className="seat-rebuy-actions"/);
  assert.match(table, /＋ ז׳יטונים/);
  assert.match(table, /לא כרגע/);
  assert.match(table, /className="rebuy-amount-dialog"/);
  assert.doesNotMatch(table, /className="rebuy-backdrop"/);
  assert.match(styles, /\.seat-rebuy-actions\s*\{/);
  assert.match(styles, /\.rebuy-amount-backdrop\s*\{[^}]*background:\s*rgba\(2,8,5,\.18\)/s);
  const seatNameRule = styles.match(/\.table-seat strong\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(seatNameRule, /overflow-wrap:\s*anywhere/);
  assert.match(seatNameRule, /white-space:\s*normal/);
  assert.doesNotMatch(seatNameRule, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(styles, /@keyframes action-notification-in/);
  assert.match(styles, /\.player-panel\s*\{[^}]*position:\s*sticky/s);
  assert.match(styles, /\.action-bar button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(lobby, /lobby\.settings\.initialStack\.toLocaleString\('he-IL'\)/);
  assert.doesNotMatch(lobby, />1,000 צ׳יפים</);
  assert.match(lobby, /!lobby\.isParticipant && !lobby\.isHost/);
  assert.match(lobby, /className="entry-panel join-entry-panel"/);
  assert.match(lobby, /השם שלכם בשולחן/);
  assert.doesNotMatch(lobby, /className="lobby-join-form"/);
});

test('server game authority uses one poker-core module identity in production', async () => {
  const [lifecycle, handStart] = await Promise.all([
    readFile(resolve(root, 'apps/server/src/game-lifecycle.ts'), 'utf8'),
    readFile(resolve(root, 'apps/server/src/hand-start.ts'), 'utf8'),
  ]);
  assert.match(lifecycle, /advanceUncontestedRunout[\s\S]*from '@texas-holdem\/poker-core\/server'/);
  assert.doesNotMatch(lifecycle, /packages\/poker-core\/src/);
  assert.doesNotMatch(handStart, /packages\/poker-core\/src/);
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

test('waiting-room removal sends the selected seat to a host-only endpoint', async () => {
  const { removeWaitingPlayer } = await lobbyApi();
  const requests = [];
  const result = await removeWaitingPlayer('abc123', 'seat-id', {
    fetch: async (...request) => { requests.push(request); return { status: 200, json: async () => null }; },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(requests, [[
    'http://localhost:3001/rooms/abc123/lobby/players/seat-id/remove',
    { method: 'POST', credentials: 'include' },
  ]]);
  const rejected = await removeWaitingPlayer('abc123', 'seat-id', {
    fetch: async () => ({ status: 403, json: async () => ({ error: 'private detail' }) }),
  });
  assert.equal(rejected.ok, false);
  assert.doesNotMatch(rejected.message, /private detail/);
});
