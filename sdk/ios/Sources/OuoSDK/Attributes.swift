import Foundation

/// An OTLP attribute value: the four scalar types the spec's records use.
public enum AttributeValue: Equatable, Sendable {
    case string(String)
    case int(Int64)
    case double(Double)
    case bool(Bool)

    /// From a value an app passes (`[String: Any]`, an `NSDictionary` from Objective-C): strings,
    /// numbers and booleans (`NSNumber` keeps which it is); a non-finite number is left out (JSON
    /// has none), anything else becomes its description.
    public init?(any value: Any) {
        switch value {
        case let v as AttributeValue:
            self = v
        case let s as String:
            self = .string(s)
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() {
                self = .bool(n.boolValue)
            } else if CFNumberIsFloatType(n) {
                guard n.doubleValue.isFinite else { return nil }
                self = .double(n.doubleValue)
            } else {
                self = .int(n.int64Value)
            }
        default:
            self = .string(String(describing: value))
        }
    }

    /// The value as `ouo.last_events` and readable bodies print it.
    var text: String {
        switch self {
        case .string(let s): return s
        case .int(let i): return String(i)
        case .double(let d): return d.rounded() == d && abs(d) < 1e15 ? String(Int64(d)) : String(d)
        case .bool(let b): return b ? "true" : "false"
        }
    }
}

extension AttributeValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByBooleanLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int64) { self = .int(value) }
    public init(floatLiteral value: Double) { self = .double(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
}

public typealias Attributes = [String: AttributeValue]

extension Dictionary where Key == String, Value == AttributeValue {
    /// The attributes an app passed, converted (`AttributeValue(any:)`).
    init(app: [String: Any]?) {
        self.init()
        for (k, v) in app ?? [:] {
            if let a = AttributeValue(any: v) { self[k] = a }
        }
    }
}

/// Epoch milliseconds that never jump: the wall clock at process start plus a monotonic clock that
/// keeps counting while the device sleeps (`CLOCK_MONOTONIC` on Darwin). A user setting the clock
/// back or forward mid-run does not reorder this run's records, expire its session or give a
/// negative duration; the next launch reads the wall clock again.
public enum SteadyClock {
    private static let anchor: (wall: Double, mono: UInt64) = (Date().timeIntervalSince1970 * 1000, clock_gettime_nsec_np(CLOCK_MONOTONIC))

    public static func nowMs() -> Double {
        anchor.wall + Double(clock_gettime_nsec_np(CLOCK_MONOTONIC) &- anchor.mono) / 1_000_000
    }
}

/// Deterministic session sampling, the rule of `@ouo11y/react-native` and rum-api's server-side cap
/// (`sdk/react-native/src/sampling.ts`): a session is in the sample of `rate` for `salt` when
/// `fmix32(fnv1a32(salt + ":" + sessionId)) / 2^32 < rate`, FNV-1a over UTF-16 code units.
enum Sampling {
    static let session = "session"
    static let replay = "replay"

    static func hash(_ s: String) -> UInt32 {
        var h: UInt32 = 0x811c9dc5
        for unit in s.utf16 {
            h ^= UInt32(unit)
            h = h &* 0x01000193
        }
        h ^= h >> 16
        h = h &* 0x85ebca6b
        h ^= h >> 13
        h = h &* 0xc2b2ae35
        h ^= h >> 16
        return h
    }

    static func sampled(_ sessionId: String, rate: Double, salt: String) -> Bool {
        if rate >= 1 { return true }
        if !(rate > 0) { return false }
        return Double(hash("\(salt):\(sessionId)")) / 4_294_967_296 < rate
    }
}

/// The bridge's cut (React Native `cutUtf8`, Go `truncate`): longer than `maxBytes` of UTF-8, the
/// longest prefix of whole code points that fits in `maxBytes`, followed by "…".
func cutUtf8(_ s: String, _ maxBytes: Int) -> String {
    if s.utf8.count <= maxBytes { return s }
    var out = String.UnicodeScalarView()
    var used = 0
    for u in s.unicodeScalars {
        let n = String(u).utf8.count
        if used + n > maxBytes { break }
        out.append(u)
        used += n
    }
    return String(out) + "…"
}

/// `[ouo]` debug log, silent unless enabled.
struct Log {
    let enabled: Bool
    func log(_ message: @autoclosure () -> String) {
        if enabled { NSLog("[ouo] %@", message()) }
    }
    func warn(_ message: @autoclosure () -> String) {
        if enabled { NSLog("[ouo] warning: %@", message()) }
    }
}
