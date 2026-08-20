module.exports = {
  preset: 'react-native',
  setupFilesAfterEnv: ['@testing-library/react-native/extend-expect'],
  // React Native rendering plus `findBy*`'s polling makes these tests slow by
  // nature — a passing file routinely takes tens of seconds of wall clock. At
  // jest's 5s default, individual tests inside it began timing out whenever
  // the whole monorepo's suites ran in parallel and the machine was busy, and
  // then passed on a re-run. That is a flaky suite, not a slow one, and a
  // flaky suite teaches people to re-run CI instead of reading it.
  testTimeout: 30_000,
  // @lilypad/protocol ships pure ESM (`"type": "module"`, no "require" export
  // condition) — Jest's CJS resolver can't require() it. Map straight to the
  // TypeScript source instead of dist/, so babel-jest transforms it exactly
  // like the rest of the app's TS.
  moduleNameMapper: {
    '^@lilypad/protocol$': '<rootDir>/../../packages/protocol/src/index.ts',
    // @lilypad/design is pure ESM for the same reason and needs the same map.
    '^@lilypad/design$': '<rootDir>/../../packages/design/src/index.ts',
    // The protocol package's source uses explicit ".js" extensions on relative
    // imports (correct for its own tsc/ESM build) — strip them so Jest's
    // runtime resolver finds the sibling ".ts" file instead of a literal ".js".
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // pnpm nests real packages under node_modules/.pnpm/<pkg>/node_modules/<pkg>,
  // so a plain "node_modules/(?!pkg/)" prefix match never sees past the
  // ".pnpm" segment. Search across the whole remaining path instead.
  // `@noble/*` is ESM-only too (M8 device identity), so it needs the same
  // treatment as react-native's own ESM packages.
  transformIgnorePatterns: ['node_modules/(?!.*(react-native|@react-navigation|@noble))'],
};
