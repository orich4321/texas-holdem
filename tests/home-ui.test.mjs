import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

async function source(path) {
  return readFile(resolve(root, path), 'utf8');
}

async function roomCreation() {
  return import(resolve(root, 'apps/web/app/room-creation.ts'));
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

test('home presents the focused Hebrew room-hosting flow with an accessible dark UI', async () => {
  const [page, layout, styles] = await Promise.all([
    source('apps/web/app/page.tsx'),
    source('apps/web/app/layout.tsx'),
    source('apps/web/app/globals.css'),
  ]);

  assert.match(layout, /<html lang="he" dir="rtl">/);
  assert.match(layout, /import ['"]\.\/globals\.css['"]/);

  assert.match(page, /הולדם/);
  assert.match(page, /כינוי/);
  assert.match(page, /פתח חדר/);
  assert.match(page, /המארח.*קישור/s);
  assert.doesNotMatch(page, /קוד חדר|הצטרף לחדר/);

  assert.match(styles, /color-scheme:\s*dark/);
  assert.match(styles, /min-height:\s*44px/);
  assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(styles, /@media\s*\(min-width:/);
});

test('home footer text meets WCAG AA contrast against the page background', async () => {
  const styles = await source('apps/web/app/globals.css');
  const footer = rule(styles, '.home-shell > footer');
  const color = footer.match(/color:\s*(#[\da-f]{6})/i)?.[1];

  assert.ok(color, 'home footer must set an explicit six-digit text color');
  assert.ok(
    contrastRatio(color, '#070a09') >= 4.5,
    `${color} must have at least 4.5:1 contrast against #070a09`,
  );
});

test('home shell reserves an in-flow footer and remains vertically scrollable', async () => {
  const styles = await source('apps/web/app/globals.css');
  const shell = rule(styles, '.home-shell');
  const footer = rule(styles, '.home-shell > footer');

  assert.match(shell, /grid-template-rows:\s*minmax\(min-content,\s*1fr\)\s+auto/);
  assert.doesNotMatch(shell, /overflow(?:-y)?:\s*hidden/);
  assert.doesNotMatch(footer, /position:\s*absolute/);
});

test('home typography rules are scoped and use logical alignment', async () => {
  const styles = await source('apps/web/app/globals.css');

  assert.match(styles, /\.home-card\s+h1\s*\{/);
  assert.match(styles, /\.home-shell\s*>\s*footer\s*\{/);
  assert.doesNotMatch(styles, /(?:^|\n)h1\s*\{/);
  assert.doesNotMatch(styles, /(?:^|\n)footer\s*\{/);
  assert.match(rule(styles, '.host-form'), /text-align:\s*start/);
  assert.doesNotMatch(styles, /text-align:\s*right/);
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
      body: JSON.stringify({ displayName: 'אורי', initialStack: 1000, smallBlind: 5, bigBlind: 10, maxPlayers: 6 }),
    },
  ]]);
  assert.deepEqual(destinations, ['/r/abc123/host']);
  assert.deepEqual(result, { ok: true });
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
