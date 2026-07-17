import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Env is provided per-test where needed; keep runs deterministic + quiet.
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  },
});
