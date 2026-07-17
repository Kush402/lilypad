import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// @testing-library/react's auto-cleanup relies on the test framework calling
// its registered afterEach hook, which only happens automatically under
// Jest's global environment detection — Vitest needs this wired explicitly,
// or every test after the first in a file renders on top of the previous
// test's leftover DOM (surfaces as spurious "found multiple elements"
// failures that have nothing to do with the component under test).
afterEach(() => {
  cleanup();
});
