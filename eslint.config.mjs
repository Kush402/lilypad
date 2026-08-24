// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/node_modules/**',
      'apps/desktop/src-tauri/target/**',
      'apps/mobile/ios/**',
      'apps/mobile/android/**',
      '**/*.config.{js,cjs,mjs}',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node CLI scripts (doctor/bootstrap/run-tauri/clean/e2e-audit) — plain ESM
    // run by node, so the Node globals are real there. `fetch`, `Buffer`,
    // `AbortSignal`, `crypto` and `performance` are all globals in Node 20+,
    // which `engines` already requires.
    //
    // The list was short by five, which cost 16 no-undef errors across
    // watchdog/e2e-audit/apple-preflight — invisible because `pnpm lint` is
    // `turbo run lint` and `scripts/` belongs to no workspace, so nothing ever
    // linted them. `lint:scripts` does now.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        AbortSignal: 'readonly',
        crypto: 'readonly',
        performance: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
);
