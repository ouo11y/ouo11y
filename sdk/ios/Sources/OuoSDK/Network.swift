import Foundation
import ObjectiveC

/// `URLSession` instrumentation (mobile SDK spec C5) by swizzling `-[NSURLSessionTask resume]`, the
/// one call every task goes through (completion handlers, delegates, `async` APIs, any session):
/// the hook sees the task before it starts, can replace its `currentRequest` with one that carries
/// `traceparent` and `baggage` (what sentry-cocoa does), and observes `state` to learn the answer.
/// Background sessions run out of process and are not seen.
enum URLSessionHook {
    private static let lock = NSLock()
    private static var installed = false
    private static var handler: ((URLSessionTask) -> Void)?
    private static var marker = 0

    /// Installs the swizzle once per process; later calls only replace the handler (nil turns it off).
    static func install(_ onResume: ((URLSessionTask) -> Void)?) {
        lock.lock()
        defer { lock.unlock() }
        handler = onResume
        guard !installed else { return }
        installed = true
        // The concrete task classes are private and may override `resume` at several levels (they
        // differ by OS version): walk the hierarchy of real tasks and swizzle every class that
        // implements its own (AFNetworking's approach). A task is handled once (`claim`).
        let session = URLSession(configuration: .ephemeral)
        let url = URL(string: "https://127.0.0.1/")!
        let tasks: [URLSessionTask] = [session.dataTask(with: url), session.downloadTask(with: url), session.uploadTask(with: URLRequest(url: url), from: Data())]
        var done = Set<ObjectIdentifier>()
        for t in tasks {
            var cls: AnyClass? = object_getClass(t)
            while let c = cls {
                if !done.contains(ObjectIdentifier(c)) {
                    done.insert(ObjectIdentifier(c))
                    swizzleResume(c)
                }
                if c == URLSessionTask.self { break }
                cls = class_getSuperclass(c)
            }
            t.cancel()
        }
        session.invalidateAndCancel()
    }

    private static func swizzleResume(_ c: AnyClass) {
        let sel = NSSelectorFromString("resume")
        guard let m = class_getInstanceMethod(c, sel) else { return }
        // Inherited: the method belongs to the superclass, which the walk reaches next.
        if let s = class_getSuperclass(c), let sm = class_getInstanceMethod(s, sel), method_getImplementation(sm) == method_getImplementation(m) { return }
        typealias Resume = @convention(c) (AnyObject, Selector) -> Void
        let original = unsafeBitCast(method_getImplementation(m), to: Resume.self)
        let block: @convention(block) (AnyObject) -> Void = { obj in
            if let task = obj as? URLSessionTask, claim(task), let h = lock.withLock({ handler }) { h(task) }
            original(obj, sel)
        }
        method_setImplementation(m, imp_implementationWithBlock(block))
    }

    /// True the first time a task is seen (`resume` runs at several class levels, and after `suspend`).
    private static func claim(_ task: URLSessionTask) -> Bool {
        guard objc_getAssociatedObject(task, &marker) == nil else { return false }
        objc_setAssociatedObject(task, &marker, true, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        return true
    }

    /// Replaces the task's request before it starts; false when this OS's task cannot take one.
    static func setRequest(_ request: URLRequest, on task: URLSessionTask) -> Bool {
        // KVC on a missing key raises an Objective-C exception: ask first.
        guard task.state == .suspended, task.responds(to: NSSelectorFromString("setCurrentRequest:")) else { return false }
        task.setValue(request, forKey: "currentRequest")
        return true
    }

    private static var observationKey = 0

    /// Calls `done` once when the task completes (KVO on `state`, kept alive by the task).
    static func onCompletion(_ task: URLSessionTask, _ done: @escaping (URLSessionTask) -> Void) {
        let once = Once()
        let observation = task.observe(\.state, options: [.new]) { t, _ in
            if t.state == .completed, once.first() { done(t) }
        }
        objc_setAssociatedObject(task, &observationKey, observation, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    }
}

private final class Once {
    private let lock = NSLock()
    private var fired = false
    func first() -> Bool { lock.withLock { defer { fired = true }; return !fired } }
}

/// URL lists of the config (`propagateTo`, `ignoreUrls`): prefixes, matched at a boundary, so
/// `https://api.example.com` matches `https://api.example.com/x` and not `https://api.example.com.evil.net`.
enum URLMatch {
    static func matches(_ url: String, _ prefixes: [String]) -> Bool {
        prefixes.contains { p in
            guard !p.isEmpty, url.hasPrefix(p) else { return false }
            if url.count == p.count || p.hasSuffix("/") { return true }
            let next = url[url.index(url.startIndex, offsetBy: p.count)]
            return next == "/" || next == "?" || next == "#"
        }
    }
}

/// W3C Trace Context and Baggage headers (C5): `traceparent` only when the request has none (two
/// would be invalid), `baggage` merged with the app's (its own keys win nothing over the session's).
enum Propagation {
    static func traceparent(traceId: String, spanId: String) -> String { "00-\(traceId)-\(spanId)-01" }

    static func baggage(existing: String?, _ entries: [(String, String)]) -> String {
        let keys = Set(entries.map(\.0))
        var parts = (existing ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { part in
            guard !part.isEmpty else { return false }
            let key = part.split(separator: "=", maxSplits: 1).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
            return !keys.contains(key)
        }
        parts += entries.map { "\($0.0)=\(encode($0.1))" }
        return parts.joined(separator: ",")
    }

    /// Baggage values are percent-encoded outside printable ASCII without space, `"`, `,`, `;`, `\` and `%`.
    private static let allowed: CharacterSet = {
        var s = CharacterSet(charactersIn: Unicode.Scalar(0x21)...Unicode.Scalar(0x7e))
        s.remove(charactersIn: "\",;\\%")
        return s
    }()

    static func encode(_ v: String) -> String { v.addingPercentEncoding(withAllowedCharacters: allowed) ?? "" }
}
