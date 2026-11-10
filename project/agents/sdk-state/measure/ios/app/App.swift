// Step 5 overhead harness: one tiny UIKit + SwiftUI app compiled three ways.
//   (no flag)  baseline, no SDK linked
//   -D OUO     ouo11y iOS SDK (OuoSDK, local path sdk/ios)
//   -D SENTRY  sentry-cocoa 9.x (product "Sentry", static xcframework)
// Runtime environment (SIMCTL_CHILD_*):
//   STEP5_REPLAY=1     replay on (ouo replaySampleRate 1 / Sentry sessionSampleRate 1)
//   STEP5_ACTION       "init" (start, note the init time, stay idle) or "journey"
//   STEP5_SINK         base URL of the capture server, e.g. http://127.0.0.1:47100
// The app writes Documents/step5.jsonl: {"kind":"init","initMs":..} and journey steps.
#if OUO
import OuoSDK
#endif
#if SENTRY
import Sentry
#endif
import SwiftUI
import UIKit

enum Bench {
    static let env = ProcessInfo.processInfo.environment
    static let replay = env["STEP5_REPLAY"] == "1"
    static let sink = env["STEP5_SINK"] ?? "http://127.0.0.1:47100"
    static func port(_ offset: Int) -> String {
        let u = URL(string: sink)!
        return "\(u.scheme!)://\(u.host!):\(u.port! + offset)"
    }
    // capture.py ports: +0 backend (the app's own API calls), +1 ouo OTLP, +2 ouo replay, +3 Sentry
    static var backend: String { port(0) }

    static func note(_ kind: String, _ extra: [String: Any] = [:]) {
        var o: [String: Any] = ["ts": Date().timeIntervalSince1970 * 1000, "kind": kind]
        o.merge(extra) { a, _ in a }
        guard let data = try? JSONSerialization.data(withJSONObject: o) else { return }
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("step5.jsonl")
        let line = data + Data("\n".utf8)
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile(); h.write(line); try? h.close()
        } else {
            try? line.write(to: url)
        }
    }

    /// Starts the SDK of this build on the main thread; returns the time spent in the call (ms).
    static func startSDK() -> Double? {
        #if OUO
        let config = OuoConfig(endpoint: URL(string: port(1))!, projectId: "demo",
                               projectToken: "pt_dev_demo_0000000000000000", serviceName: "step5-bench")
        config.environment = "bench"
        config.replayEndpoint = URL(string: port(2))!
        config.propagateTo = [backend]
        config.replaySampleRate = replay ? 1 : 0
        let t0 = DispatchTime.now().uptimeNanoseconds
        Ouo.start(config)
        return Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6
        #elseif SENTRY
        let dsn = "http://pub@" + URL(string: port(3))!.host! + ":\(URL(string: port(3))!.port!)/1"
        let t0 = DispatchTime.now().uptimeNanoseconds
        SentrySDK.start { o in
            o.dsn = dsn
            o.environment = "bench"
            o.tracesSampleRate = 1
            if replay {
                o.sessionReplay.sessionSampleRate = 1
                o.sessionReplay.onErrorSampleRate = 1
            }
        }
        return Double(DispatchTime.now().uptimeNanoseconds - t0) / 1e6
        #else
        return nil
        #endif
    }

    static func captureError(_ e: Error) {
        #if OUO
        Ouo.captureError(e)
        #elseif SENTRY
        SentrySDK.capture(error: e)
        #endif
    }

    static func request(_ path: String) {
        URLSession.shared.dataTask(with: URL(string: backend + path)!) { _, r, _ in
            note("request", ["path": path, "status": (r as? HTTPURLResponse)?.statusCode ?? 0])
        }.resume()
    }

    /// The journey, from launch: 20 s idle, then 60 s of screens and requests, then idle until killed.
    /// Every 6 s: push Products (+ GET /api/products), +2 s push Cart (+ GET /api/cart),
    /// +4 s POST /api/checkout and pop to root. One handled error at the first cycle.
    static func run(_ nav: UINavigationController) {
        guard env["STEP5_ACTION"] == "journey" else { return }
        let start = 20.0
        DispatchQueue.main.asyncAfter(deadline: .now() + start) { note("journey-start") }
        for i in 0..<10 {
            let t = start + Double(i) * 6
            DispatchQueue.main.asyncAfter(deadline: .now() + t) {
                nav.pushViewController(Products.controller(), animated: true)
                request("/api/products")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + t + 2) {
                nav.pushViewController(CartViewController(), animated: true)
                request("/api/cart")
                if i == 0 {
                    captureError(NSError(domain: "Step5", code: 7, userInfo: [NSLocalizedDescriptionKey: "handled error"]))
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + t + 4) {
                var r = URLRequest(url: URL(string: backend + "/api/checkout")!)
                r.httpMethod = "POST"
                r.httpBody = Data(#"{"items":3}"#.utf8)
                URLSession.shared.dataTask(with: r) { _, _, _ in note("request", ["path": "/api/checkout"]) }.resume()
                nav.popToRootViewController(animated: true)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + start + 60) { note("journey-end") }
    }
}

final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let ms = Bench.startSDK()
        Bench.note("init", ["initMs": ms ?? 0, "sdk": ms != nil, "replay": Bench.replay])
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
        Bench.run(nav)
    }
}

final class HomeViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Home"
        view.backgroundColor = .systemBackground
        let label = UILabel()
        label.text = "Hello, Ada Lovelace"
        let open = UIButton(type: .system)
        open.setTitle("Products", for: .normal)
        open.addAction(UIAction { [weak self] _ in self?.navigationController?.pushViewController(Products.controller(), animated: true) }, for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [label, open])
        stack.axis = .vertical
        stack.spacing = 24
        stack.frame = CGRect(x: 24, y: 160, width: 320, height: 120)
        view.addSubview(stack)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Bench.note("home")
    }
}

struct Products: View {
    static func controller() -> UIViewController {
        let host = UIHostingController(rootView: Products())
        host.title = "Products"
        return host
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Espresso cup, 4.50").font(.title3)
            Text("Card ending 4242")
            Text("Total 4.50")
            Image(systemName: "cup.and.saucer.fill").font(.largeTitle)
            Button("Add to cart") {}
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

final class CartViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Cart"
        view.backgroundColor = .systemBackground
        let promo = UITextField(frame: CGRect(x: 24, y: 140, width: 320, height: 40))
        promo.placeholder = "Promo code"
        promo.text = "SECRET-42"
        promo.borderStyle = .roundedRect
        let list = UIScrollView(frame: CGRect(x: 24, y: 200, width: 320, height: 80))
        list.contentSize = CGSize(width: 960, height: 80)
        for i in 0..<3 {
            let item = UILabel(frame: CGRect(x: CGFloat(i) * 320 + 8, y: 20, width: 300, height: 40))
            item.text = "Item \(i + 1)"
            list.addSubview(item)
        }
        let checkout = UIButton(type: .system)
        checkout.setTitle("Checkout", for: .normal)
        checkout.frame = CGRect(x: 24, y: 300, width: 320, height: 44)
        [promo, list, checkout].forEach(view.addSubview)
    }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
