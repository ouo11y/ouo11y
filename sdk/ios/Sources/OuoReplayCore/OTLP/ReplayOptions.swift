import Foundation

/// `format` of the start options.
public enum ReplayFormatKind: String, Sendable {
    /// `ouo-frames/3`.
    case pixel
    /// `ouo-wireframe/1`.
    case structure
}

/// The OTLP replay options of `start(endpoint, options)`, read from what JavaScript passed
/// (ADR-0019 decision 5). Reading never throws and never traps (ERR-1): a value of the wrong type
/// or out of range falls back to its default and is listed in `problems`; only a missing or
/// unusable `otlp.logsUrl` makes the options unusable, and replay then does not start.
public struct ReplayOTLPOptions: Sendable {
    public var logsUrl: URL
    public var scope: ReplayScope
    public var format: ReplayFormatKind
    public var mode: ReplayCaptureMode
    public var bufferSeconds: Double
    /// 32 lowercase hex characters, nil to generate one.
    public var replayId: String?
    public var keyframeIntervalMs: Int64
    public var chunkMaxBytes: Int
    /// What ended the previous process, for the `ouo.replay.ended` of a stream it left open:
    /// `crash` or `background_kill` (the default).
    public var previousExit: ReplayEndReason

    public init(logsUrl: URL, scope: ReplayScope, format: ReplayFormatKind = .pixel, mode: ReplayCaptureMode = .session, bufferSeconds: Double = 60, replayId: String? = nil, keyframeIntervalMs: Int64 = 300_000, chunkMaxBytes: Int = 256 * 1024, previousExit: ReplayEndReason = .backgroundKill) {
        self.logsUrl = logsUrl
        self.scope = scope
        self.format = format
        self.mode = mode
        self.bufferSeconds = bufferSeconds
        self.replayId = replayId
        self.keyframeIntervalMs = keyframeIntervalMs
        self.chunkMaxBytes = chunkMaxBytes
        self.previousExit = previousExit
    }

    public var streamConfig: ReplayStreamConfig {
        ReplayStreamConfig(mode: mode, bufferSeconds: bufferSeconds, keyframeIntervalMs: keyframeIntervalMs, chunkMaxBytes: chunkMaxBytes)
    }

    public enum Parsed: Sendable {
        /// No `otlp` key: the caller wants the upload path that existed before.
        case legacy
        case otlp(ReplayOTLPOptions, problems: [String])
        /// `otlp` was asked for but cannot be used: replay must not start.
        case invalid(problems: [String])
    }

    static let maxResourceAttributes = 128
    static let maxStringLength = 2048

    public static func parse(_ raw: [String: Any]) -> Parsed {
        guard let rawOtlp = raw["otlp"], !(rawOtlp is NSNull) else { return .legacy }
        var problems: [String] = []
        guard let otlp = rawOtlp as? [String: Any] else {
            return .invalid(problems: ["otlp is not an object"])
        }
        guard let logs = string(otlp["logsUrl"]), let url = URL(string: logs.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", let host = url.host, !host.isEmpty else {
            return .invalid(problems: ["otlp.logsUrl is missing or not an http(s) URL"])
        }

        var resource: [ReplayAttribute] = []
        if let rawResource = otlp["resource"], !(rawResource is NSNull) {
            if let dict = rawResource as? [String: Any] {
                for key in dict.keys.sorted() {
                    guard resource.count < maxResourceAttributes else {
                        problems.append("otlp.resource has more than \(maxResourceAttributes) attributes, the rest are left out")
                        break
                    }
                    guard !key.isEmpty, let value = attribute(dict[key]) else {
                        problems.append("otlp.resource.\(key.prefix(64)) is not a string, number or boolean")
                        continue
                    }
                    resource.append(ReplayAttribute(String(key.prefix(256)), value))
                }
            } else {
                problems.append("otlp.resource is not an object")
            }
        }

        func text(_ key: String, in dict: [String: Any], _ path: String) -> String? {
            guard let value = dict[key], !(value is NSNull) else { return nil }
            guard let s = string(value) else {
                problems.append("\(path) is not a string")
                return nil
            }
            return String(s.prefix(maxStringLength))
        }
        func double(_ key: String, _ range: ClosedRange<Double>) -> Double? {
            guard let value = raw[key], !(value is NSNull) else { return nil }
            guard let n = number(value) else {
                problems.append("\(key) is not a finite number")
                return nil
            }
            if !range.contains(n) { problems.append("\(key) is out of range, clamped") }
            return min(max(n, range.lowerBound), range.upperBound)
        }

        var options = ReplayOTLPOptions(
            logsUrl: url,
            scope: ReplayScope(
                resource: resource,
                scopeVersion: text("scopeVersion", in: otlp, "otlp.scopeVersion") ?? "",
                schemaUrl: text("schemaUrl", in: otlp, "otlp.schemaUrl") ?? ""
            )
        )
        if let format = text("format", in: raw, "format") {
            if let kind = ReplayFormatKind(rawValue: format) { options.format = kind } else { problems.append("format is not pixel or structure") }
        }
        if let mode = text("replayMode", in: raw, "replayMode") {
            if let m = ReplayCaptureMode(rawValue: mode) { options.mode = m } else { problems.append("replayMode is not session or buffer") }
        }
        if let id = text("replayId", in: raw, "replayId"), !id.isEmpty {
            if ReplayStream.isValidId(id) { options.replayId = id } else { problems.append("replayId is not 32 lowercase hex characters, a new one is generated") }
        }
        if let exit = text("previousExit", in: otlp, "otlp.previousExit") {
            if exit == ReplayEndReason.crash.rawValue { options.previousExit = .crash } else if exit != ReplayEndReason.backgroundKill.rawValue { problems.append("otlp.previousExit is not crash or background_kill") }
        }
        if let n = double("bufferSeconds", 5...600) { options.bufferSeconds = n }
        if let n = double("keyframeIntervalMs", 1000...3_600_000) { options.keyframeIntervalMs = Int64(n) }
        if let n = double("chunkMaxBytes", 4096...Double(ReplayStreamConfig.hardLimitBytes)) { options.chunkMaxBytes = Int(n) }
        return .otlp(options, problems: problems)
    }

    // MARK: lenient readers, shared with the Expo module

    public static func string(_ value: Any?) -> String? {
        value as? String
    }

    /// A finite number. A boolean is not a number, although the bridge can deliver one as `NSNumber`.
    public static func number(_ value: Any?) -> Double? {
        guard let value, !isBoolean(value) else { return nil }
        let d: Double
        if let v = value as? Double { d = v } else if let v = value as? Int { d = Double(v) } else if let v = value as? NSNumber { d = v.doubleValue } else { return nil }
        return d.isFinite ? d : nil
    }

    public static func bool(_ value: Any?) -> Bool? {
        guard let value else { return nil }
        if isBoolean(value) { return (value as? NSNumber)?.boolValue }
        return type(of: value) == Bool.self ? value as? Bool : nil
    }

    private static func isBoolean(_ value: Any) -> Bool {
        if type(of: value) == Bool.self { return true }
        #if canImport(ObjectiveC)
        if let n = value as? NSNumber { return CFGetTypeID(n) == CFBooleanGetTypeID() }
        #endif
        return false
    }

    /// A resource value: a string, a boolean, or a number (an int when it is integral and exact
    /// in a double, else a double).
    static func attribute(_ value: Any?) -> ReplayAttribute.Value? {
        if let s = value as? String { return .string(String(s.prefix(maxStringLength))) }
        if let b = bool(value) { return .bool(b) }
        guard let n = number(value) else { return nil }
        if n == n.rounded(), abs(n) <= 9_007_199_254_740_992 { return .int(Int64(n)) }
        return .double(n)
    }
}
