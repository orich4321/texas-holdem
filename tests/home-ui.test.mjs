import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

async function source(path) {
  return readFile(resolve(root, path), 'utf8');
}

async function roomCreation() {
  return import(pathToFileURL(resolve(root, 'apps/web/app/room-creation.ts')).href);
}

function rule(styles, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

function relativeLuminance(hex) {
  const channels = hex.match(/[\da-f]{2}/gi).map((channel) => Number.parseInt(channel, 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(foreground, background) {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test('home presents a minimal Hebrew room-hosting flow with an accessible dark UI', async () => {
  const [page, layout, styles] = await Promise.all([
    source('apps/web/app/page.tsx'),
    source('apps/web/app/layout.tsx'),
    source('apps/web/app/globals.css'),
  ]);

  assert.match(layout, /<html lang="he" dir="rtl">/);
  assert.match(layout, /import ['"]\.\/globals\.css['"]/);

  assert.match(page, /פותחים משחק/);
  assert.match(page, /השם שלכם בשולחן/);
  assert.match(page, /פתיחת שולחן/);
  assert.match(page, /entry-settings/);
  assert.match(page, /href="\/enter-room"/);
  assert.doesNotMatch(page, /name="room-code"|הצטרף לחדר/);
  assert.doesNotMatch(page, /home-benefits|home-hero|hero-cards/);

  assert.match(styles, /color-scheme:\s*dark/);
  assert.match(styles, /min-height:\s*44px/);
  assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(styles, /@media\s*\(min-width:/);
  assert.match(styles, /input:not\(\[type="range"\]\), select, textarea\s*\{\s*font-size:\s*16px/);
});

test('profile editing and private hand history open from home, not the active table or lobby', async () => {
  const [home, panel, table, lobby, history] = await Promise.all([
    source('apps/web/app/page.tsx'),
    source('apps/web/app/home-account-panel.tsx'),
    source('apps/web/app/r/[joinId]/table-client.tsx'),
    source('apps/web/app/r/[joinId]/lobby-client.tsx'),
    source('apps/web/app/history/history-list.tsx'),
  ]);
  assert.match(home, /<HomeAccountPanel/);
  assert.match(home, /החברים והיסטוריית המשחקים/);
  assert.match(panel, /<AvatarPicker/);
  assert.match(panel, /<HistoryList onSelectGame=/);
  assert.match(panel, /<HistoryGame joinId=/);
  assert.match(history, /credentials: 'include'/);
  assert.doesNotMatch(table, /AccountLink/);
  assert.match(table, /חזרה למסך הראשי/);
  assert.match(table, /צפייה בידיים במשחק/);
  assert.doesNotMatch(lobby, /AccountLink|\/history/);
});

test('friends panel shows an account directory instead of requiring a typed username', async () => {
  const [panel, api] = await Promise.all([
    source('apps/web/app/home-account-panel.tsx'),
    source('apps/web/app/social-api.ts'),
  ]);
  assert.match(panel, /שחקנים באפליקציה/);
  assert.match(panel, /loadSocialUsers/);
  assert.match(panel, /הצגת שחקנים נוספים/);
  assert.doesNotMatch(panel, /friend-username|social-request-form/);
  assert.match(api, /credentials: 'include'/);
});

test('minimal entry button text meets WCAG AA contrast', async () => {
  assert.ok(contrastRatio('#f2eee4', '#526252') >= 4.5);
});

test('friend avatars stay circular instead of inheriting the flexible text-column layout', async () => {
  const styles = await source('apps/web/app/globals.css');
  const avatar = rule(styles, '.social-avatar');
  assert.match(avatar, /width:\s*34px/);
  assert.match(avatar, /height:\s*34px/);
  assert.match(avatar, /flex:\s*0 0 34px/);
  assert.match(avatar, /border-radius:\s*50%/);
  assert.match(styles, /\.social-person > span:not\(\.social-avatar\)\s*\{/);
  assert.match(styles, /\.lobby-friend-invite > span:not\(\.social-avatar\)\s*\{/);
  assert.doesNotMatch(styles, /\.social-person > span\s*\{/);
  assert.doesNotMatch(styles, /\.lobby-friend-invite > span\s*\{/);
});

test('friend removal is red and room invitations have a separate named action', async () => {
  const styles = await source('apps/web/app/globals.css');
  const home = await source('apps/web/app/home-account-panel.tsx');
  const lobby = await source('apps/web/app/r/[joinId]/lobby-client.tsx');
  assert.match(home, /className="social-remove-friend"[^]*>הסרה<\/button>/);
  assert.match(styles, /\.social-person button\.social-remove-friend\s*\{[^}]*background:\s*#703b38;/);
  assert.match(lobby, /className="lobby-friend-invite"[^]*<strong>\{friend\.displayName \?\? friend\.username\}<\/strong>[^]*<button[^]*>\{invitingFriendId === friend\.id \? 'שולחים…' : 'הזמנה'\}<\/button>/);
});

test('main app shells fill the dynamic viewport without page-level scrolling', async () => {
  const styles = await source('apps/web/app/globals.css');
  const shell = rule(styles, '.entry-shell');
  const document = rule(styles, 'html, body');
  const roster = rule(styles, '.lobby-roster ul');

  assert.match(shell, /grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/);
  assert.match(shell, /height:\s*100dvh/);
  assert.doesNotMatch(shell, /overflow(?:-y)?:\s*hidden/);
  assert.match(document, /overflow:\s*hidden/);
  assert.match(roster, /overflow-y:\s*auto/);
});

test('entry typography rules are scoped and use logical alignment', async () => {
  const styles = await source('apps/web/app/globals.css');

  assert.match(styles, /\.entry-intro\s+h1\s*\{/);
  assert.match(styles, /\.entry-form\s*\{/);
  assert.doesNotMatch(styles, /(?:^|\n)h1\s*\{/);
  assert.doesNotMatch(styles, /(?:^|\n)footer\s*\{/);
  assert.match(rule(styles, '.entry-form'), /text-align:\s*start/);
  assert.doesNotMatch(styles, /text-align:\s*right/);
});

test('the poker palette uses restrained felt, brass, and action colors without neon mint', async () => {
  const styles = await source('apps/web/app/globals.css');

  assert.match(styles, /--felt:\s*#164936/);
  assert.match(styles, /--brass-button:\s*#8d6c3d/);
  assert.match(styles, /--action:\s*#3d604e/);
  assert.doesNotMatch(
    styles,
    /#(?:8ceac8|40ca98|54d7a5|69d7ac|51d3a5|43cf9d|3bc997|2fbd8d|80e8c3|96eed0)\b/i,
  );
});

test('room creation posts the normalized nickname and host-selected table settings before navigating to the matching host route', async () => {
  const { submitRoomCreation } = await roomCreation();
  const requests = [];
  const destinations = [];

  const result = await submitRoomCreation('  אורי  ', {
    fetch: async (...request) => {
      requests.push(request);
      return {
        status: 201,
        json: async () => ({ roomId: 'abc123', hostPath: '/r/abc123/host', invitePath: '/r/abc123' }),
      };
    },
    navigate: (destination) => destinations.push(destination),
  });

  assert.deepEqual(requests, [[
    'http://localhost:3001/rooms',
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'אורי', initialStack: 500, smallBlind: 1, bigBlind: 2, maxPlayers: 9 }),
    },
  ]]);
  assert.deepEqual(destinations, ['/r/abc123/host']);
  assert.deepEqual(result, { ok: true });
});

test('stack display converts chips to the current big blind without changing their chip total', async () => {
  const { formatChipsInBigBlinds } = await import(pathToFileURL(resolve(root, 'apps/web/app/chips-in-blinds.ts')).href);
  assert.equal(formatChipsInBigBlinds(500, 2), '250 BB');
  assert.equal(formatChipsInBigBlinds(500, 3), '166.7 BB');
  assert.equal(formatChipsInBigBlinds(0, 2), '0 BB');
  assert.equal(formatChipsInBigBlinds(1, 100), '<0.1 BB');
  assert.equal(formatChipsInBigBlinds(500, 0), '—');
});

test('room creation rejects an empty nickname without making a request', async () => {
  const { submitRoomCreation } = await roomCreation();
  let requested = false;

  const result = await submitRoomCreation('   ', {
    fetch: async () => {
      requested = true;
      throw new Error('must not request');
    },
    navigate: () => assert.fail('must not navigate'),
  });

  assert.equal(requested, false);
  assert.deepEqual(result, { ok: false, message: 'צריך להזין כינוי כדי לפתוח חדר.' });
});

test('room creation returns one safe Hebrew error for rejected and network responses', async () => {
  const { submitRoomCreation } = await roomCreation();
  const backendBody = 'private backend detail';
  const cases = [
    async () => ({ status: 400, json: async () => ({ error: backendBody }) }),
    async () => { throw new Error(backendBody); },
  ];

  for (const fetch of cases) {
    const result = await submitRoomCreation('אורי', {
      fetch,
      navigate: () => assert.fail('must not navigate'),
    });

    assert.deepEqual(result, { ok: false, message: 'לא הצלחנו לפתוח את החדר. נסו שוב.' });
    assert.doesNotMatch(result.message, new RegExp(backendBody));
  }
});

test('room creation rejects malformed or mismatched success payloads without navigating', async () => {
  const { submitRoomCreation } = await roomCreation();
  const payloads = [
    null,
    { roomId: 'abc123' },
    { roomId: 'abc123', hostPath: '/r/abc123/host', invitePath: '/r/different' },
    { roomId: 'abc123', hostPath: '/r/different/host', invitePath: '/r/abc123' },
    { roomId: 123, hostPath: '/r/123/host', invitePath: '/r/123' },
  ];

  for (const payload of payloads) {
    const result = await submitRoomCreation('אורי', {
      fetch: async () => ({ status: 201, json: async () => payload }),
      navigate: () => assert.fail('must not navigate'),
    });

    assert.deepEqual(result, { ok: false, message: 'לא הצלחנו לפתוח את החדר. נסו שוב.' });
  }
});
