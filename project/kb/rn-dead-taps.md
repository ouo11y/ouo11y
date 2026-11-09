# React Native dead taps: what "the screen answered" can mean

Written for F4 (ADR-0019, 2026-11-04). `sdk/react-native/src/commits.ts`, `src/frustration.ts`.

## The signal that is used: Fabric commits

- ReactFabric (`react-native/Libraries/Renderer/implementations/ReactFabric-prod.js`) hands every
  finished tree to the host through `nativeFabricUIManager.completeRoot(container, children)`. It
  calls it only when the host tree changed (the root's flags carry `Update`, bit 4), so a state change
  that renders the same views commits nothing. One call is one visible change of the React tree.
- The renderer reads `completeRoot` once, by destructuring the free global `nativeFabricUIManager`
  when its module loads (`ReactFabric-prod.js`, RN 0.86). A wrapper put on the method afterwards is
  never called, and the method cannot be replaced: the global is a JSI host object.
- **The global must not stay replaced.** Native code reads it back and casts it to the host object:
  `NativeDOM::linkRootNode` → `UIManagerBinding::getBinding` (from `AppRegistry.startSurface`, at
  the first render). A `Proxy` left on the global is no host object, and both apps die with SIGSEGV
  at startup (seen on the iOS simulator and the API 35 emulator, 2026-11-04). The Node stand-in suite
  could not see it: it has no native side.
- What works: put the proxy on the global, make the renderer load right then, put the host object
  back, all synchronously. The renderer loads behind `react-native`'s `findNodeHandle` getter
  (`index.js` → `RendererProxy` → `RendererImplementation`, which imports `ReactFabric`). The SDK's
  dist is CommonJS (`var reactNative = require('react-native')`, read as `reactNative.findNodeHandle`),
  so the read is lazy and happens in `initRUM`, which must run before the first render. If the
  renderer had already loaded, the getter loads nothing and the probe never sees a commit.
- The probe counts as live only after it has seen one commit. Until then (old architecture, a late
  `initRUM`) dead taps are off rather than all reported. One probe per JS runtime (module state):
  the renderer loads once.
- `FabricUIManager.js`'s `getFabricUIManager()` caches a proxy of the global on its first call; if
  that happens during the swap it caches the SDK's proxy, which forwards everything: harmless.

## Signals that were not used

- **The native replay "dirty" flag** (iOS layer drew, Android `ViewTreeObserver.OnDrawListener`):
  it fires on the press feedback itself, such as `TouchableOpacity`'s opacity and the Android ripple,
  so every tap looks answered. Making it exclude feedback would mean knowing which layers are
  feedback. Not cheap.
- **Haptics**: no JS event exists for `Vibration` or expo-haptics.

## What follows for the false positives

- `TouchableOpacity`, `TouchableHighlight` and `TouchableNativeFeedback` animate their feedback
  with the native driver, so a tap on one commits nothing. A broken button of those kinds is a dead
  tap, which is the case we want.
- A `Pressable` with a `pressed` style function re-renders on press in and out, so it commits on
  every tap and **is never a dead tap**. That is a known miss, written down in the README.
- An animation with the native driver, a haptic, or a JS-driven `Animated` value that never goes
  through React (`setNativeProps`) is not an answer the probe sees. Such controls get
  `ouo-frustration={false}`, which the fiber walk in `taps.ts` reads from any ancestor's props.
- Only control-like targets are judged (roles button, link, menuitem, tab, togglebutton,
  imagebutton, switch, checkbox, radio; the core touchable components), so a tap on plain text
  or a background is never dead.
