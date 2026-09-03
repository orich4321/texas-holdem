import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { createSecureRandomInt } from '../apps/server/src/secure-random.ts';

const root = resolve(import.meta.dirname, '..');

test('secure random adapter delegates its max-exclusive bound to the crypto boundary', () => {
  const requestedBounds = [];
  const secureRandomInt = createSecureRandomInt((maxExclusive) => {
    requestedBounds.push(maxExclusive);
    return 3;
  });

  assert.equal(secureRandomInt(10), 3);
  assert.deepEqual(requestedBounds, [10]);
});

test('secure random adapter uses node crypto and never Math.random', async () => {
  const source = await readFile(resolve(root, 'apps/server/src/secure-random.ts'), 'utf8');

  assert.match(source, /from 'node:crypto'/);
  assert.doesNotMatch(source, /Math\.random/);
});
