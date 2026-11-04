# ADR-0019 Rage and dead taps on mobile: the web's records, a UI commit as the answer

Status: proposed (2026-11-04, JUHI gap F4); extends [ADR-0015](0015-mobile-sdk-spec-and-conformance.md)'s capability C6.

## Context

The browser SDK reports frustration on clicks: `ouo.rage_click` for a burst of clicks on one spot and `ouo.dead_click` for a click on a button or link after which nothing happened (no request, no DOM mutation, no navigation). The mobile SDKs had only `ui.tap`, so a mobile session showed no frustration at all, while a pilot replacing Sentry asks for both on React Native.

Two things differ on a phone:

- **What "nothing happened" means.** The web's answer is a DOM mutation. The obvious mobile equivalent, the native "window drew" flag the replay recorders keep, fires for a control's own press highlight (`TouchableOpacity`'s fade, Android's ripple), so every tap on a control would look answered. React Native's Fabric renderer hands every committed UI change to `nativeFabricUIManager.completeRoot`, and only when something on screen changed; a native-driven press highlight is not a commit, a state update that changes what is shown is.
- **Taps that must not count.** A stepper's `+` is tapped quickly on purpose; a control whose only answer is a haptic or a native-driven animation commits nothing.

## Decision

1. **Same records as the web**, named `ouo.rage_click` and `ouo.dead_click` on every platform, severity `WARN`, with the web's attributes where they apply: `app.widget.id` (the C6 tap target: a label or test id, never text), `app.screen.coordinate.x` / `.y`, `ouo.click.count` and `ouo.click.duration_ms`, plus the screen as `app.screen.name` and `ouo.ui.view_type`. One name per concept keeps queries, funnels and the plugin's markers platform-free.
2. **Rage tap**: 3 taps (gesture `tap`) on the same target or within 30 points of the first, within 1 s of the first, one record per burst stamped at its first tap: the web's defaults, configurable (`timeline.rageTaps`).
3. **Dead tap**: a tap on a control (a button-like accessibility role or a React Native touchable) after which, within 1 s of the finger lifting, there was no navigation, no request, no move to the background and no UI commit. The commit is counted in JavaScript by wrapping the global `nativeFabricUIManager` before the renderer loads (`initRUM` runs first); the signal counts only once a commit was seen, so without Fabric (old architecture) or with a late `initRUM` dead taps stay off instead of reporting every tap.
4. **Opt-out** per control: `ouo-frustration={false}` on it or an ancestor removes its taps from both detectors (steppers, haptic-only or animation-only controls); `timeline.rageTaps: false` and `timeline.deadTaps: false` turn them off.
5. One implementation in `@ouo11y/react-native`'s JavaScript for both platforms; the native packages get the same records with their own touch handling later (checks C6.2 and C6.3 are pending in the native iOS suite until then).

## Consequences

- A control whose press highlight re-renders it (a `Pressable` style that depends on `pressed`, `TouchableHighlight`) commits on every tap, so it never has dead taps: missed dead taps, never false ones. A haptic-only or native-animation-only control needs the opt-out to avoid false ones.
- The commit probe depends on a React Native internal (the global's name and `completeRoot`); a renamed internal turns dead taps off (the probe sees no commit), it does not break the app.
- The plugin shows both records as timeline and replay markers for web and mobile sessions alike.
