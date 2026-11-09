// Metro config for consuming @ouo11y/react-native through a `file:` link (a symlink into
// ../../sdk/react-native). See project/kb-archive/otel-react-native.md.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const sdkRoot = path.resolve(projectRoot, "../../sdk/react-native");
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The SDK's peer dependencies must resolve to THIS app's copies, never to the SDK's own
// devDependencies (sdk/react-native/node_modules holds a second react-native for its tests)
// or to the monorepo root node_modules.
const PEERS = ["react", "react-native", "@react-native-async-storage/async-storage", "promise", "expo-modules-core"];

// 0. Debug ids in release bundles, so Hermes stacks map back to the sources of the exact bundle
//    that threw, embedded or OTA (docs/sourcemaps.md, "React Native"). An app installs
//    @ouo11y/sourcemaps and requires "@ouo11y/sourcemaps/metro"; this example uses the monorepo
//    copy and still runs when it is not built (npm run build -w @ouo11y/sourcemaps).
const beforeAssetSerialization = [];
try {
  beforeAssetSerialization.push(require("../../sdk/sourcemaps/dist/metro.cjs").ouoExpoDebugIdPlugin);
} catch {
  console.warn("ouo: sdk/sourcemaps is not built; release bundles get no debug id");
}

const config = getDefaultConfig(projectRoot, { unstable_beforeAssetSerializationPlugins: beforeAssetSerialization });

// 1. Metro only serves files under its watch folders; the symlink target lives outside the app.
config.watchFolders = [...(config.watchFolders ?? []), sdkRoot];

// 2. Never crawl or bundle the SDK's node_modules.
const existing = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
  new RegExp(`^${escape(path.join(sdkRoot, "node_modules"))}/.*`),
];

// 3. Redirect the SDK's peer imports to the app's node_modules (hierarchical lookup stays on
//    for everything else, so packages nested by npm, e.g. expo/node_modules/expo-asset, still resolve).
const appIndex = path.join(projectRoot, "index.ts");
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromSdk = context.originModulePath.startsWith(sdkRoot + path.sep);
  const isPeer = PEERS.some((p) => moduleName === p || moduleName.startsWith(`${p}/`));
  if (fromSdk && isPeer) {
    return context.resolveRequest({ ...context, originModulePath: appIndex }, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
