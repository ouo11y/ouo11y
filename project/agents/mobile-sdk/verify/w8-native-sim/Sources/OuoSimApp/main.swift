import OuoSDK
import SimKit
import UIKit

/// No scenes: the app delegate owns the window.
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        startOuo(variant: "app")
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = Screen()
        window?.makeKeyAndVisible()
        Ouo.trackScreen("Home")
        runAction(application)
        return true
    }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
