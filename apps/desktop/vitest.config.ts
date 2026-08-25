import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    /**
     * Bigger than vitest's 5s default, and for the same reason the backend's
     * is 20s: the default is a statement about the MACHINE, not about the code.
     *
     * `setup.ts` already raises testing-library's `asyncUtilTimeout` to 5s, so
     * a `waitFor` that is about to give up and a test that is about to be
     * killed were racing at the same number. Under a full-suite run — a dozen
     * jsdom workers on one laptop — the kill won, and suites that pass in
     * isolation (`linkPolling`, `SoftwareUpdate`) failed with "Test timed out
     * in 5000ms" while asserting nothing about the product.
     *
     * A real hang still fails, four times slower.
     */
    testTimeout: 20_000,
  },
});
