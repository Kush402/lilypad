const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// Monorepo-aware Metro config: watch the workspace root so Metro can follow the
// pnpm symlink into packages/protocol/dist, and resolve deps from both the app
// and the root node_modules.
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

/** @type {import('@react-native/metro-config').MetroConfig} */
const config = {
  projectRoot,
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
    // Metro follows symlinks by default (>=0.80); pnpm workspaces work as-is.
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
