import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// `waitFor` defaults to a ONE SECOND budget, which is not a budget at all when
// vitest runs several jsdom files in parallel on a loaded machine: `pnpm -w
// test` failed on 2026-08-24 with a pair-button assertion that passes every
// time the same file runs alone. A timeout is a way of saying "this will never
// happen", so five seconds is the honest number — a genuinely broken
// expectation still fails, it just stops depending on how busy the CPU is.
// `apps/mobile/jest.setup.ts` learned this a release earlier and set fifteen;
// these files mount plain components rather than a navigation stack, so five
// keeps a real failure fast.
configure({ asyncUtilTimeout: 5_000 });

// @testing-library/react's auto-cleanup relies on the test framework calling
// its registered afterEach hook, which only happens automatically under
// Jest's global environment detection — Vitest needs this wired explicitly,
// or every test after the first in a file renders on top of the previous
// test's leftover DOM (surfaces as spurious "found multiple elements"
// failures that have nothing to do with the component under test).
afterEach(() => {
  cleanup();
});
