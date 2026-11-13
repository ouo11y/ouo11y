import OuoReplay
import OuoSDK
import UIKit

/// The default shape of a new Xcode project: an app delegate and a scene delegate. Configuration
/// comes from the environment (`SIMCTL_CHILD_*` on the simulator): OUO_OTLP (collector OTLP/HTTP),
/// OUO_REPLAY (its replay receiver, when not OUO_OTLP's port 4318 plus one),
/// OUO_BACKEND (the demo backend), OUO_ACTION (the journey, Journey.swift), OUO_OFF=1 (no SDK: the
/// benchmark's `none` cell), OUO_TAP_LABELS=0 (the labels kill switch), OUO_DEBUG=1. The
/// Sentry-derived video recorder runs on the OTLP path only (`replay.mode` `pixel/video`, React
/// Native); this app records frames.
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let env = ProcessInfo.processInfo.environment
        guard env["OUO_OFF"] != "1" else {
            Journey.note("launch", ["sdk": false])
            return true
        }
        let config = OuoConfig(endpoint: URL(string: env["OUO_OTLP"] ?? "http://localhost:4318")!,
                               projectId: "demo", projectToken: "pt_dev_demo_0000000000000000", serviceName: "ouo-ios-example")
        config.environment = "example"
        config.propagateTo = [Journey.backend]
        if let replay = env["OUO_REPLAY"].flatMap(URL.init(string:)) { config.replayEndpoint = replay }
        config.backgroundTimeout = 5
        config.replaySampleRate = 1
        config.tapLabels = env["OUO_TAP_LABELS"] != "0"
        config.debug = env["OUO_DEBUG"] == "1"
        let t0 = CFAbsoluteTimeGetCurrent()
        Ouo.start(config)
        Journey.note("launch", ["sdk": true, "startMs": (CFAbsoluteTimeGetCurrent() - t0) * 1000])
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in Journey.note("active") }
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let c = UISceneConfiguration(name: nil, sessionRole: session.role)
        c.delegateClass = SceneDelegate.self
        return c
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let nav = UINavigationController(rootViewController: HomeViewController())
        let w = UIWindow(windowScene: scene)
        w.rootViewController = nav
        w.makeKeyAndVisible()
        window = w
        Journey.run(nav)
    }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
