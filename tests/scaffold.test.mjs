import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

async function exists(path) {
  await access(resolve(root, path));
}

test('workspace exposes runnable package entry points and commands', async () => {
  await Promise.all([
    exists('apps/web/app/page.tsx'),
    exists('apps/server/src/index.ts'),
    exists('packages/poker-core/src/index.ts'),
  ]);

  const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  for (const script of ['dev', 'test', 'lint', 'typecheck', 'e2e']) {
    assert.equal(typeof rootPackage.scripts?.[script], 'string');
  }

  assert.match(rootPackage.scripts.lint, /\bapps\b/);
  assert.match(rootPackage.scripts.lint, /\btests\b/);

  const eslintConfig = await readFile(resolve(root, 'eslint.config.mjs'), 'utf8');
  assert.match(eslintConfig, /import nextPlugin from '@next\/eslint-plugin-next';/);
  assert.match(eslintConfig, /plugins:\s*\{\s*'@next\/next':\s*nextPlugin\s*\}/);
  assert.match(eslintConfig, /rootDir:\s*'apps\/web\/'/);
  assert.match(eslintConfig, /'\*\*\/\*\.d\.ts'/);
  assert.match(eslintConfig, /import tseslint from 'typescript-eslint';/);
  assert.equal(typeof rootPackage.devDependencies?.['typescript-eslint'], 'string');
});
