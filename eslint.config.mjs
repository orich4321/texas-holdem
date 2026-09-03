import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    settings: { next: { rootDir: 'apps/web/' } },
    plugins: { '@next/next': nextPlugin },
    rules: nextPlugin.configs.recommended.rules,
  },
];
