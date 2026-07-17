module.exports = {
  preset: 'react-native',
  setupFilesAfterEnv: ['@testing-library/react-native/extend-expect'],
  // @lilypad/protocol ships pure ESM (`"type": "module"`, no "require" export
  // condition) — Jest's CJS resolver can't require() it. Map straight to the
  // TypeScript source instead of dist/, so babel-jest transforms it exactly
  // like the rest of the app's TS.
  moduleNameMapper: {
    '^@lilypad/protocol$': '<rootDir>/../../packages/protocol/src/index.ts',
    // The protocol package's source uses explicit ".js" extensions on relative
    // imports (correct for its own tsc/ESM build) — strip them so Jest's
    // runtime resolver finds the sibling ".ts" file instead of a literal ".js".
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // pnpm nests real packages under node_modules/.pnpm/<pkg>/node_modules/<pkg>,
  // so a plain "node_modules/(?!pkg/)" prefix match never sees past the
  // ".pnpm" segment. Search across the whole remaining path instead.
  transformIgnorePatterns: ['node_modules/(?!.*(react-native|@react-navigation))'],
};
