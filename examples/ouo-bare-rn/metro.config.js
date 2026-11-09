// Metro config of the bare app. install-expo-modules switched it to expo/metro-config (needed for
// `export:embed`, the bundle command its Gradle and Xcode changes use). On top of that, two things only
// this monorepo example needs:
//   - @ouo11y/react-native comes through a `file:` link (a symlink into ../../sdk/react-native), so
//     its peer imports must resolve to this app's copies (project/kb/otel-react-native.md);
//   - the screens and the journey are the golden app's (../ouo-mobile: App.tsx, src/,
//     modules/ouo-chaos), so the conformance suites drive the same UI. Their imports resolve here too:
//     ../ouo-mobile/node_modules holds Expo 57 / React Native 0.86, not this app's versions.
// A client app installed from npm needs none of this: the stock config install-expo-modules writes is enough.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const sdkRoot = path.resolve(projectRoot, "../../sdk/react-native");
const goldenRoot = path.resolve(projectRoot, "../ouo-mobile");
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const config = getDefaultConfig(projectRoot);

// Metro only serves files under its watch folders; both trees live outside the app.
config.watchFolders = [...(config.watchFolders ?? []), sdkRoot, goldenRoot];

// Never crawl or bundle their node_modules or native projects.
const existing = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
  new RegExp(`^${escape(path.join(sdkRoot, "node_modules"))}/.*`),
  ...["node_modules", "ios", "android", ".expo"].map((d) => new RegExp(`^${escape(path.join(goldenRoot, d))}/.*`)),
];

// A package import (not a relative path) from either tree resolves from this app's root.
const appIndex = path.join(projectRoot, "index.js");
const outside = (file) => file.startsWith(sdkRoot + path.sep) || file.startsWith(goldenRoot + path.sep);
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (outside(context.originModulePath) && !moduleName.startsWith(".") && !path.isAbsolute(moduleName)) {
    return context.resolveRequest({ ...context, originModulePath: appIndex }, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
