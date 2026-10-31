import OuoSDK
import UIKit

/// What a run does (OUO_ACTION), and its notes for the suite's checker: one JSON line per step in
/// Documents/journey.jsonl. Taps are made by hand or by a driver (tests/e2e/mobile-native/README.md):
/// the app cannot synthesise real touches.
enum Journey {
    static let env = ProcessInfo.processInfo.environment
    static var backend: String { env["OUO_BACKEND"] ?? "http://localhost:8081" }

    static func note(_ kind: String, _ extra: [String: Any] = [:]) {
        var o: [String: Any] = ["ts": Int64(Date().timeIntervalSince1970 * 1000), "kind": kind, "session": Ouo.sessionId ?? ""]
        o.merge(extra) { a, _ in a }
        guard let data = try? JSONSerialization.data(withJSONObject: o) else { return }
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("journey.jsonl")
        let line = data + Data("\n".utf8)
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile()
            h.write(line)
            try? h.close()
        } else {
            try? line.write(to: url)
        }
    }

    private static var appeared = false

    /// Home's first `viewDidAppear`: the end of the benchmark's app start.
    static func homeAppeared() {
        guard !appeared else { return }
        appeared = true
        note("home")
    }

    /// The checkout request inside a span (C5, C9), and a log line.
    static func checkout() {
        Ouo.withSpan("checkout") { _ in
            URLSession.shared.dataTask(with: URL(string: backend + "/api/products")!) { _, _, _ in note("request") }.resume()
        }
        Ouo.log(.info, "golden log line")
    }

    static func run(_ nav: UINavigationController) {
        let after = { (s: Double, f: @escaping () -> Void) in DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: f) }
        let push = { (vc: UIViewController) in nav.pushViewController(vc, animated: true) }
        switch env["OUO_ACTION"] ?? "idle" {
        case "journey":
            after(1) { push(Products.controller()) }
            after(2.2) { push(CartViewController()) }
            after(3.2) {
                Ouo.captureError(NSError(domain: "OuoExample", code: 7, userInfo: [NSLocalizedDescriptionKey: "golden handled error"]))
                checkout()
            }
            after(4.2) { note("feedback", ["id": Ouo.feedback("golden feedback", contact: "ada@example.com", screenshot: true) ?? ""]) }
        case "hang":
            after(1.5) { push(CartViewController()) }
            after(3) {
                note("block")
                Thread.sleep(forTimeInterval: 3)
            }
        case "crash":
            after(3) {
                note("crash")
                UnsafeMutablePointer<Int>(bitPattern: 8)!.pointee = 1
            }
        case "early":
            after(0.2) {
                note("crash")
                UnsafeMutablePointer<Int>(bitPattern: 8)!.pointee = 1
            }
        case "oom":
            after(2) {
                NotificationCenter.default.post(name: UIApplication.didReceiveMemoryWarningNotification, object: UIApplication.shared)
                note("kill")
                after(1) { kill(getpid(), SIGKILL) }
            }
        case "bench":
            // The benchmark journey: Products and Cart pushed and popped every 2 s, no faults.
            var step = 0
            Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
                step += 1
                switch step % 3 {
                case 1: push(Products.controller())
                case 2: push(CartViewController())
                default: nav.popToRootViewController(animated: true)
                }
            }
        case "offline":
            Ouo.addEvent("offline-step")
        case "dump":
            after(1) { push(Products.controller()) }
            after(3) { note("dump", ["views": dump(nav.view.window!)]) }
        default:
            break
        }
    }

    /// Class names of the view tree and of the layers without a view: what replay's masking sees.
    static func dump(_ view: UIView, depth: Int = 0) -> [String] {
        var out = [String(repeating: " ", count: depth) + NSStringFromClass(type(of: view)) + " " + (view.accessibilityIdentifier ?? "")]
        func layers(_ l: CALayer, _ d: Int) {
            for s in l.sublayers ?? [] where !view.subviews.contains(where: { $0.layer === s }) {
                out.append(String(repeating: " ", count: d) + "layer " + NSStringFromClass(type(of: s)) + " \(s.frame)")
                layers(s, d + 1)
            }
        }
        layers(view.layer, depth + 1)
        for v in view.subviews { out += dump(v, depth: depth + 1) }
        return out
    }
}
