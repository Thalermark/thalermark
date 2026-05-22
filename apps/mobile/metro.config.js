const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// pnpm monorepo: watch the whole workspace and resolve modules from both
// the local app and the root. Hierarchical lookup stays ON so Metro can
// walk into pnpm's nested layout (`node_modules/.pnpm/<pkg>/node_modules/`)
// when a package like react-native requires a private dep (e.g. `invariant`)
// that isn't hoisted. Expo's monorepo guide suggests disabling it to catch
// phantom deps, but with pnpm + the React Native ecosystem the false-
// positives are too noisy for the safety value.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Workspace packages (e.g. @thalermark/brand) are consumed source-first
// with NodeNext-style imports like `./colors.js` even though the actual
// file is `colors.ts`. Vite and tsx handle that transparently; Metro
// doesn't. Retry .js relative imports as .ts/.tsx when the .js miss
// fails. Restricted to workspace source so we don't mask real bugs in
// node_modules.
const tsExtensions = ['.ts', '.tsx'];
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = originalResolveRequest ?? context.resolveRequest;
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    for (const ext of tsExtensions) {
      try {
        return resolve(context, moduleName.replace(/\.js$/, ext), platform);
      } catch {}
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: './src/global.css' });
