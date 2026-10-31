import Foundation

/// A span of the span API (mobile SDK spec C9) and of the URLSession hook (C5). It carries the
/// session's ids from its start; `end()` exports it once. Thread-safe.
@objc(OuoSpan)
public final class OuoSpan: NSObject {
    @objc public let traceId: String
    @objc public let spanId: String
    private let lock = NSLock()
    private var record: SpanRecord
    private var ended = false
    private weak var core: Core?

    /// Without `core` (the SDK not started) the span is never exported.
    init(core: Core?, name: String, kind: SpanRecord.Kind, attributes: Attributes, parent: OuoSpan?, start: Double) {
        self.core = core
        traceId = parent?.traceId ?? Ids.trace()
        spanId = Ids.span()
        var a = core?.correlation() ?? [:]
        a.merge(attributes) { _, own in own }
        record = SpanRecord(traceId: traceId, spanId: spanId, parentSpanId: parent?.spanId, name: name, kind: kind, startMs: start, endMs: start, attributes: a, error: nil)
        super.init()
    }

    /// Sets an attribute (a string, number or boolean).
    @objc public func setAttribute(_ key: String, value: Any) {
        guard let v = AttributeValue(any: value) else { return }
        set(key, v)
    }

    func set(_ key: String, _ v: AttributeValue) {
        lock.withLock { if !ended { record.attributes[key] = v } }
    }

    /// Marks the span failed (status error) with `message`.
    @objc public func setError(_ message: String) {
        lock.withLock { if !ended { record.error = message } }
    }

    /// Ends the span now; later calls do nothing.
    @objc public func end() {
        let now = core?.now() ?? SteadyClock.nowMs()
        let done: SpanRecord? = lock.withLock {
            guard !ended else { return nil }
            ended = true
            record.endMs = max(record.startMs, now)
            return record
        }
        if let done { core?.export(done) }
    }

    // MARK: - the active span (thread-local)

    private static let key = "dev.ouo.active-spans"

    /// The innermost `withSpan` span on this thread: requests, logs and errors there join its trace.
    static var active: OuoSpan? {
        (Thread.current.threadDictionary[key] as? [OuoSpan])?.last
    }

    static func push(_ s: OuoSpan) {
        var stack = Thread.current.threadDictionary[key] as? [OuoSpan] ?? []
        stack.append(s)
        Thread.current.threadDictionary[key] = stack
    }

    static func pop(_ s: OuoSpan) {
        var stack = Thread.current.threadDictionary[key] as? [OuoSpan] ?? []
        if let i = stack.lastIndex(of: s) { stack.remove(at: i) }
        Thread.current.threadDictionary[key] = stack.isEmpty ? nil : stack
    }
}
