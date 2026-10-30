import OuoSDK
import UIKit

/// What the run did, for the checker: one JSON line per step in Documents/w8.jsonl.
func note(_ kind: String) {
    let line = "{\"ts\":\(Int64(Date().timeIntervalSince1970 * 1000)),\"kind\":\"\(kind)\",\"session\":\"\(Ouo.sessionId ?? "")\"}\n"
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("w8.jsonl")
    if let h = try? FileHandle(forWritingTo: url) {
        h.seekToEndOfFile()
        h.write(Data(line.utf8))
        try? h.close()
    } else {
        try? Data(line.utf8).write(to: url)
    }
}

final class Screen: UIViewController {
    override func viewDidLoad() {
        view.backgroundColor = .systemBackground
        let label = UILabel(frame: CGRect(x: 20, y: 120, width: 300, height: 40))
        label.text = "ouo W8 part 1"
        view.addSubview(label)
    }
}

final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    let env = ProcessInfo.processInfo.environment

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let backend = env["OUO_BACKEND"] ?? "http://localhost:8081"
        let config = OuoConfig(endpoint: URL(string: env["OUO_OTLP"] ?? "http://localhost:4318")!, projectId: "demo",
                               projectToken: "pt_dev_demo_0000000000000000", serviceName: "w8-native-sim")
        config.environment = "sim"
        config.propagateTo = [backend]
        config.backgroundTimeout = 5
        config.debug = true
        Ouo.start(config)
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = Screen()
        window?.makeKeyAndVisible()
        Ouo.trackScreen("Home")
        note("launch")
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in note("active") }
        let main = DispatchQueue.main
        switch env["OUO_ACTION"] ?? "idle" {
        case "journey":
            main.asyncAfter(deadline: .now() + 1) {
                Ouo.trackScreen("Products")
                URLSession.shared.dataTask(with: URL(string: backend + "/api/products")!) { _, _, _ in
                    DispatchQueue.main.async {
                        Ouo.reportFullyDisplayed()
                        note("request")
                    }
                }.resume()
            }
            main.asyncAfter(deadline: .now() + 2.5) {
                Ouo.trackScreen("Cart")
                Ouo.captureError(NSError(domain: "W8Golden", code: 7, userInfo: [NSLocalizedDescriptionKey: "golden handled error"]))
                Ouo.log(.info, "golden log line")
                note("error")
            }
        case "hang":
            main.asyncAfter(deadline: .now() + 2) {
                Ouo.trackScreen("Cart")
                note("block")
                Thread.sleep(forTimeInterval: 3)
            }
        case "crash":
            main.asyncAfter(deadline: .now() + 3) {
                note("crash")
                UnsafeMutablePointer<Int>(bitPattern: 8)!.pointee = 1
            }
        case "oom":
            main.asyncAfter(deadline: .now() + 2) {
                NotificationCenter.default.post(name: UIApplication.didReceiveMemoryWarningNotification, object: application)
                note("kill")
                main.asyncAfter(deadline: .now() + 1) { kill(getpid(), SIGKILL) }
            }
        case "offline":
            Ouo.addEvent("offline-step")
        default:
            break
        }
        return true
    }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
