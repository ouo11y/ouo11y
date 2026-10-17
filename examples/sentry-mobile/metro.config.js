// Sentry's Metro wrapper adds debug ids to the bundle (what a real Sentry Expo app ships).
// @ouo/react-native is consumed through a `file:` link (../../sdk/react-native) for the
// `parallel` and `ouo` rollout modes (ROLLOUT.md): the same resolver rules as examples/mobile, see project/kb/otel-react-native.md.
const path = require("node:path");
const { getSentryExpoConfig } = require("@sentry/react-native/metro");

const projectRoot = __dirname;
const sdkRoot = path.resolve(projectRoot, "../../sdk/react-native");
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The SDK's peers must resolve to this app's copies, never to the SDK's own devDependencies.
const PEERS = ["react", "react-native", "@react-native-async-storage/async-storage", "promise", "expo-modules-core"];

const config = getSentryExpoConfig(projectRoot);
config.watchFolders = [...(config.watchFolders ?? []), sdkRoot];
const existing = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
  new RegExp(`^${escape(path.join(sdkRoot, "node_modules"))}/.*`),
];
const appIndex = path.join(projectRoot, "index.ts");
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromSdk = context.originModulePath.startsWith(sdkRoot + path.sep);
  const isPeer = PEERS.some((p) => moduleName === p || moduleName.startsWith(`${p}/`));
  const ctx = fromSdk && isPeer ? { ...context, originModulePath: appIndex } : context;
  return upstream ? upstream(ctx, moduleName, platform) : ctx.resolveRequest(ctx, moduleName, platform);
};

module.exports = config;
