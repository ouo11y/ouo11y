import Darwin
import Foundation
import OuoSDK
import UIKit

/// What a run did, for the checker: one JSON line per step in Documents/w8.jsonl.
public func note(_ kind: String, _ extra: [String: Any] = [:]) {
    var o: [String: Any] = ["ts": Int64(Date().timeIntervalSince1970 * 1000), "kind": kind, "session": Ouo.sessionId ?? ""]
    o.merge(extra) { a, _ in a }
    guard let data = try? JSONSerialization.data(withJSONObject: o) else { return }
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("w8.jsonl")
    if let h = try? FileHandle(forWritingTo: url) {
        h.seekToEndOfFile()
        h.write(data + Data("\n".utf8))
        try? h.close()
    } else {
        try? (data + Data("\n".utf8)).write(to: url)
    }
}

/// `TASK_CATEGORY_POLICY` role of the process, logged so a run shows what the SDK decided from.
func taskRole() -> Int32 {
    var policy = task_category_policy_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_category_policy_data_t>.size / MemoryLayout<integer_t>.size)
    var getDefault: boolean_t = 0
    _ = withUnsafeMutablePointer(to: &policy) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_policy_get(mach_task_self_, task_policy_flavor_t(TASK_CATEGORY_POLICY), $0, &count, &getDefault)
        }
    }
    return policy.role.rawValue
}

public let env = ProcessInfo.processInfo.environment

/// `Ouo.start` with the run's endpoints; notes the launch with the app state, the task role and how
/// long `start` took on the main thread.
public func startOuo(variant: String) {
    let backend = env["OUO_BACKEND"] ?? "http://localhost:8081"
    let config = OuoConfig(endpoint: URL(string: env["OUO_OTLP"] ?? "http://localhost:4318")!, projectId: "demo",
                           projectToken: "pt_dev_demo_0000000000000000", serviceName: "w8-native-sim")
    config.environment = "sim"
    config.propagateTo = [backend]
    config.backgroundTimeout = 5
    config.debug = env["OUO_DEBUG"] == "1"
    let state = UIApplication.shared.applicationState.rawValue
    let t0 = CFAbsoluteTimeGetCurrent()
    Ouo.start(config)
    let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
    note("launch", ["variant": variant, "applicationState": state, "role": Int(taskRole()), "startMs": ms])
    NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in note("active") }
}

public final class Screen: UIViewController {
    public override func viewDidLoad() {
        view.backgroundColor = .systemBackground
        let label = UILabel(frame: CGRect(x: 20, y: 120, width: 300, height: 40))
        label.text = "ouo W8"
        view.addSubview(label)
    }
}

/// The OUO_ACTION of the run (the no-scene app runs them all).
public func runAction(_ application: UIApplication) {
    let backend = env["OUO_BACKEND"] ?? "http://localhost:8081"
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
}
