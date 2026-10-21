// The shared logic is source-only (packages/cloud-client): Metro watches that folder and resolves the
// package name to its entry, so a change there reaches the app without a build step.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const client = path.resolve(__dirname, '../cloud-client');

config.watchFolders = [...(config.watchFolders ?? []), client];
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@maka-cloud/client': client,
};
// The shared package must use this app's React, never a copy of its own.
config.resolver.disableHierarchicalLookup = false;
module.exports = config;
