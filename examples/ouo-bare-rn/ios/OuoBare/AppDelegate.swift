import UIKit
import Expo
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

// The React Native 0.82 template's AppDelegate after `npx install-expo-modules --sdk-version 54.0.0`
// (ExpoAppDelegate, ExpoReactNativeFactory), with bindReactNativeFactory, plus the UIScene life cycle: an app built with the iOS 27
// SDK traps at launch without it (_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption).
// Info.plist's UIApplicationSceneManifest names SceneDelegate below, which creates the window and
// starts React Native in it; the app delegate only builds the factory. Nothing here is ouo-specific.
@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    // Expo SDK 54's own template does this; install-expo-modules does not add it. Without it the first
    // root view traps in ExpoAppDelegate.recreateRootView ("Missing factory in ExpoAppDelegate").
    bindReactNativeFactory(factory)

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene,
          let app = UIApplication.shared.delegate as? AppDelegate,
          let factory = app.reactNativeFactory else { return }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    app.window = window
    factory.startReactNative(withModuleName: "OuoBare", in: window, launchOptions: nil)
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
