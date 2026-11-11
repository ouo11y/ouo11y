// iOS capture app for Step 6 vendor research. Sends Datadog RUM, Logs and Session Replay
// to the local capture server (server.mjs) through each feature's `customEndpoint`.
// Fake client token and application id; nothing reaches Datadog.
import UIKit
import DatadogCore
import DatadogRUM
import DatadogLogs
import DatadogSessionReplay

let captureBase = ProcessInfo.processInfo.environment["CAPTURE_BASE"] ?? "http://127.0.0.1:4560"
func endpoint(_ track: String) -> URL { URL(string: "\(captureBase)/api/v2/\(track)")! }

var logger: LoggerProtocol?

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        Datadog.verbosityLevel = .debug
        Datadog.initialize(
            with: Datadog.Configuration(
                clientToken: "pub00000000000000000000000000000000",
                env: "local",
                site: .eu1,
                service: "datadog-capture-ios",
                batchSize: .small,
                uploadFrequency: .frequent
            ),
            trackingConsent: .granted
        )
        RUM.enable(with: RUM.Configuration(
            applicationID: "00000000-0000-4000-8000-000000000000",
            uiKitViewsPredicate: DefaultUIKitRUMViewsPredicate(),
            uiKitActionsPredicate: DefaultUIKitRUMActionsPredicate(),
            urlSessionTracking: .init(firstPartyHostsTracing: .trace(hosts: ["127.0.0.1"], sampleRate: 100)),
            customEndpoint: endpoint("rum"),
            telemetrySampleRate: 100
        ))
        URLSessionInstrumentation.enableDurationBreakdown(with: .init(delegateClass: SessionDelegate.self))
        Logs.enable(with: Logs.Configuration(customEndpoint: endpoint("logs")))
        // Defaults on purpose: text/input maskAll, images maskAll, touches hide.
        SessionReplay.enable(with: SessionReplay.Configuration(customEndpoint: endpoint("replay")))
        logger = Logger.create(with: Logger.Configuration(name: "capture", networkInfoEnabled: true, remoteLogThreshold: .info))
        Datadog.setUserInfo(id: "user-123", name: "Demo User")

        return true
    }
}

// iOS 27 SDK requires the UIScene life cycle.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = UINavigationController(rootViewController: HomeViewController())
        window.makeKeyAndVisible()
        self.window = window
        // Autopilot (the simulator panel could not be used for taps): exercise the app on a timer.
        if ProcessInfo.processInfo.environment["AUTOPILOT"] == "1" || CommandLine.arguments.contains("-autopilot") {
            Autopilot.run(in: window)
        }
    }
}

final class SessionDelegate: NSObject, URLSessionDataDelegate {}

final class HomeViewController: UIViewController {
    private let label = UILabel()
    private let field = UITextField()
    private var session: URLSession!

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Home"
        view.backgroundColor = .systemBackground
        session = URLSession(configuration: .default, delegate: SessionDelegate(), delegateQueue: nil)

        label.text = "Hello replay: this text is masked by default"
        label.numberOfLines = 0
        field.placeholder = "Type here"
        field.borderStyle = .roundedRect
        field.accessibilityIdentifier = "field"
        let image = UIImageView(image: UIImage(systemName: "star.fill"))
        image.tintColor = .systemOrange
        let shape = UIView()
        shape.backgroundColor = .systemTeal
        shape.layer.cornerRadius = 12
        shape.heightAnchor.constraint(equalToConstant: 40).isActive = true

        let buttons: [(String, Selector)] = [
            ("Fetch OK", #selector(fetchOK)),
            ("Fetch 500", #selector(fetchFail)),
            ("Add error + log", #selector(addError)),
            ("Custom action", #selector(customAction)),
            ("Block main thread 300 ms", #selector(longTask)),
            ("Open detail", #selector(openDetail)),
        ].map { ($0.0, $0.1) }

        let stack = UIStackView(arrangedSubviews: [label, field, image, shape] + buttons.map { title, action in
            let b = UIButton(type: .system)
            b.setTitle(title, for: .normal)
            b.accessibilityIdentifier = title
            b.addTarget(self, action: action, for: .touchUpInside)
            return b
        })
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
        ])
    }

    func typeDemoText() {
        field.becomeFirstResponder()
        field.text = "Jane Secret"
        field.sendActions(for: .editingChanged)
        field.resignFirstResponder()
    }

    @objc private func fetchOK() { session.dataTask(with: URL(string: "\(captureBase)/api/ok")!).resume() }
    @objc private func fetchFail() { session.dataTask(with: URL(string: "\(captureBase)/api/fail")!).resume() }
    @objc private func addError() {
        RUMMonitor.shared().addError(message: "Demo handled error", type: "DemoError", source: .source, attributes: ["component": "checkout"])
        logger?.error("Demo error log", attributes: ["order.id": 42])
        logger?.info("Demo info log")
    }
    @objc private func customAction() {
        RUMMonitor.shared().addAction(type: .custom, name: "checkout.started", attributes: ["cart.items": 3])
        label.text = "Clicked at \(Date())"
    }
    @objc private func longTask() { Thread.sleep(forTimeInterval: 0.3) }
    @objc private func openDetail() { navigationController?.pushViewController(DetailViewController(), animated: true) }
}

final class DetailViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Detail"
        view.backgroundColor = .secondarySystemBackground
        let l = UILabel()
        l.text = "Detail screen"
        l.frame = CGRect(x: 24, y: 160, width: 300, height: 40)
        view.addSubview(l)
    }
}

enum Autopilot {
    static func run(in window: UIWindow) {
        guard let nav = window.rootViewController as? UINavigationController,
              let home = nav.viewControllers.first as? HomeViewController else { return }
        let steps: [(TimeInterval, () -> Void)] = [
            (2, { home.perform(NSSelectorFromString("fetchOK")) }),
            (3, { home.perform(NSSelectorFromString("fetchFail")) }),
            (4, { home.perform(NSSelectorFromString("addError")) }),
            (5, { home.perform(NSSelectorFromString("customAction")) }),
            (6, { home.perform(NSSelectorFromString("longTask")) }),
            (7, { home.typeDemoText() }),
            (9, { home.perform(NSSelectorFromString("openDetail")) }),
            (14, { nav.popViewController(animated: true) }),
            (16, { home.perform(NSSelectorFromString("customAction")) }),
        ]
        for (delay, step) in steps {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: step)
        }
    }
}
