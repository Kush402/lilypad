import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Env is provided per-test where needed; keep runs deterministic + quiet.
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
    // Vitest's five-second default is a statement about the machine, not the
    // code. `authMethods.test.ts` calls `vi.resetModules()` and re-imports the
    // whole auth route graph, which takes ~200 ms alone and blew the default
    // under `pnpm -w test`, where four packages transform TypeScript at once.
    // A test that finishes returns immediately either way; all this changes is
    // whether a busy laptop can make `main` randomly red. Same reasoning as
    // `apps/mobile/jest.setup.ts` and `apps/desktop/src/test/setup.ts`.
    testTimeout: 20_000,
  },
});
