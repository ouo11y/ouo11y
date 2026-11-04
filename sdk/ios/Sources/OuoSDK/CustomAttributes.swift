import Foundation

/// User and session attributes (docs/specs/attributes.md, gap F1): the rules of `setUser(_:attributes:)`
/// and `setAttributes(_:)`. Keys are kept without the `ouo.attr.` prefix the records carry.
enum CustomAttributes {
    /// Every attribute is `ouo.attr.<key>` on the wire.
    static let prefix = "ouo.attr."
    /// Distinct keys in the user set and the app set together.
    static let maxKeys = 20
    static let maxKeyLength = 40
    /// A longer string is cut to this many characters (Unicode scalars, what rum-api counts).
    static let maxStringLength = 128

    /// `^[A-Za-z][A-Za-z0-9_]{0,39}$`.
    static func validKey(_ key: String) -> Bool {
        let u = Array(key.utf8)
        guard (1...maxKeyLength).contains(u.count) else { return false }
        func letter(_ c: UInt8) -> Bool { (65...90).contains(c) || (97...122).contains(c) }
        guard letter(u[0]) else { return false }
        return u.dropFirst().allSatisfy { letter($0) || (48...57).contains($0) || $0 == 95 }
    }

    /// A string (cut to 128), a finite number or a boolean (`NSNumber` keeps which it is, as
    /// `AttributeValue(any:)` reads it); nil for anything else (nil, `NSNull`, arrays, dictionaries,
    /// dates, NaN, infinities).
    static func value(_ v: Any) -> AttributeValue? {
        switch v {
        case let s as String:
            return .string(cut(s))
        case let n as NSNumber:
            return AttributeValue(any: n)
        case let a as AttributeValue:
            switch a {
            case .string(let s): return .string(cut(s))
            case .double(let d): return d.isFinite ? a : nil
            default: return a
            }
        default:
            return nil
        }
    }

    static func cut(_ s: String) -> String {
        s.unicodeScalars.count <= maxStringLength ? s : String(String.UnicodeScalarView(s.unicodeScalars.prefix(maxStringLength)))
    }

    /// The valid entries of what the app passed, and the keys dropped (with why) for the debug log.
    /// Reads app values only: called without the core's lock.
    static func clean(_ map: [String: Any]) -> (Attributes, [String]) {
        var out: Attributes = [:]
        var dropped: [String] = []
        for (k, v) in map {
            guard validKey(k) else {
                dropped.append("key \"\(k.prefix(64))\" is invalid (a letter, then letters, digits and _, at most 40)")
                continue
            }
            guard let value = value(v) else {
                dropped.append("key \"\(k)\": the value is not a string, a finite number or a boolean")
                continue
            }
            out[k] = value
        }
        return (out, dropped.sorted())
    }

    /// The entries that fit in `maxKeys` distinct keys with the `existing` ones (in key order, so the
    /// same call keeps the same keys): a key already there is always kept, a new one while there is
    /// room.
    static func capped(_ entries: Attributes, existing: Set<String>) -> (Attributes, [String]) {
        var keys = existing
        var kept: Attributes = [:]
        var dropped: [String] = []
        for k in entries.keys.sorted() {
            if keys.contains(k) || keys.count < maxKeys {
                keys.insert(k)
                kept[k] = entries[k]
            } else {
                dropped.append("key \"\(k)\": already \(maxKeys) attributes")
            }
        }
        return (kept, dropped)
    }

    static func report(_ dropped: [String], _ call: String, _ log: Log) {
        for d in dropped { log.warn("\(call): attribute dropped, \(d)") }
    }
}
