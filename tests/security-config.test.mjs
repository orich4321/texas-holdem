import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { createOriginPolicy } from '../apps/server/src/origin-policy.ts';

const root = resolve(import.meta.dirname, '..');

test('configured client origins allow listed origins and reject unlisted origins', () => {
  const policy = createOriginPolicy('https://poker.example,https://admin.example');

  assert.equal(policy('https://poker.example'), true);
  assert.equal(policy('https://unlisted.example'), false);
});

test('origin policy rejects malformed configured origins', () => {
  assert.throws(() => createOriginPolicy('https://poker.example/path'), /absolute HTTP\(S\) origin/);
  assert.throws(() => createOriginPolicy('https://poker.example,'), /must not contain empty values/);
});

function postgresPortMappings(compose) {
  const lines = compose.split(/\r?\n/);
  const postgresStart = lines.findIndex((line) => /^ {2}postgres:\s*$/.test(line));
  assert.notEqual(postgresStart, -1, 'docker-compose.yml must define a postgres service');

  const postgresEnd = lines.findIndex(
    (line, index) => index > postgresStart && /^(?:\S| {2}\S)/.test(line),
  );
  const serviceLines = lines.slice(postgresStart + 1, postgresEnd === -1 ? undefined : postgresEnd);
  const portsStart = serviceLines.findIndex((line) => /^ {4}ports:\s*$/.test(line));
  assert.notEqual(portsStart, -1, 'postgres service must define a ports list');

  const mappings = [];
  for (const line of serviceLines.slice(portsStart + 1)) {
    if (!/^ {6}-\s+/.test(line)) break;
    mappings.push(line.replace(/^ {6}-\s+['"]?/, '').replace(/['"]?\s*(?:#.*)?$/, ''));
  }
  return mappings;
}

function assertPostgresIsPublishedOnlyOnLoopback(compose) {
  assert.deepEqual(postgresPortMappings(compose), [
    '127.0.0.1:${POSTGRES_PORT:-5432}:5432',
  ], 'PostgreSQL ports must contain exactly one loopback mapping');
}

test('PostgreSQL is published only on the loopback interface', async () => {
  const compose = await readFile(resolve(root, 'docker-compose.yml'), 'utf8');

  assertPostgresIsPublishedOnlyOnLoopback(compose);
});

test('PostgreSQL loopback check rejects an additional public port mapping', async () => {
  const compose = await readFile(resolve(root, 'docker-compose.yml'), 'utf8');
  const composeWithPublicPostgres = compose.replace(
    '      - "127.0.0.1:${POSTGRES_PORT:-5432}:5432"',
    '      - "127.0.0.1:${POSTGRES_PORT:-5432}:5432"\n      - "5432:5432"',
  );

  assert.match(composeWithPublicPostgres, /- "127\.0\.0\.1:\$\{POSTGRES_PORT:-5432\}:5432"/);
  assert.throws(
    () => assertPostgresIsPublishedOnlyOnLoopback(composeWithPublicPostgres),
    /PostgreSQL ports must contain exactly one loopback mapping/,
  );
});

test('dependency safety configuration aligns Express 4 types and pins vulnerable transitives', async () => {
  const serverPackage = JSON.parse(
    await readFile(resolve(root, 'apps/server/package.json'), 'utf8'),
  );
  const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

  assert.match(serverPackage.dependencies.express, /^\^4\./);
  assert.match(serverPackage.devDependencies['@types/express'], /^\^4\./);
  assert.equal(rootPackage.pnpm?.overrides?.postcss, '8.5.23');
  assert.equal(rootPackage.pnpm?.overrides?.qs, '6.16.0');
});

test('Socket.IO enables credentialed CORS while retaining the origin allowlist', async () => {
  const serverEntry = await readFile(resolve(root, 'apps/server/src/index.ts'), 'utf8');

  assert.match(serverEntry, /cors:\s*\{\s*origin:\s*\(origin, callback\) => callback\(null, isOriginAllowed\(origin\)\),\s*credentials:\s*true,?\s*\}/s);
  assert.match(serverEntry, /allowRequest:\s*\(request, callback\) => callback\(null, isOriginAllowed\(request\.headers\.origin\)\)/);
});
