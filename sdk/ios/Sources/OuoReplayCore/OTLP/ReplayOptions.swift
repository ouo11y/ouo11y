import Foundation

/// The one customer option that picks the recorder, `replay.mode` (ADR-0021 decision 5). There is
/// no shorthand: `pixel` alone is not a value. The format id each one puts on the wire is the
/// recorder's (`ouo.replay.format`).
public enum ReplayRecorderMode: String, Sendable, CaseIterable {
    /// ouo's own recorder: masked JPEG frames and tile patches, `ouo-frames/3`. The default.
    case pixelFrames = "pixel/frames"
    /// `ouo-video/1`. Not in this build.
    case pixelVideo = "pixel/video"
    /// `ouo-wireframe/1`. Not in this build.
    case structureWireframe = "structure/wireframe"

    /// What this build of the iOS SDK can record.
    public static let supported: Set<ReplayRecorderMode> = [.pixelFrames]
}

/// The OTLP replay options of `start(endpoint, options)`, read from what JavaScript passed
/// (ADR-0021 decision 5). Reading never throws and never traps (ERR-1): a value of the wrong type
/// or out of range falls back to its default and is listed in `problems`. A missing or unusable
/// `otlp.logsUrl`, or a `mode` this build does not record, leaves replay off.
///
/// | Key | Type | Default | |
/// |---|---|---|---|
/// | `otlp.logsUrl` | string | required | http(s) URL of `/v1/logs` |
/// | `otlp.resource` | object of string, number, boolean | `{}` | resource attributes, written in key order |
/// | `otlp.schemaUrl`, `otlp.scopeVersion` | string | `""` | on ScopeLogs and the scope |
/// | `otlp.previousExit` | `crash` or `background_kill` | `background_kill` | end reason of a stream the last run left open |
/// | `mode` | string | `pixel/frames` | the recorder |
/// | `cadence` | `auto`, `session`, `navigation` | `auto` | when to look (what `mode` meant before) |
/// | `buffer` | `{ seconds }` | absent | present: keep a ring and send on `capture(trigger)`; absent: record the whole session |
/// | `replayId` | 32 lowercase hex | generated | |
/// | `keyframeIntervalMs` | number | 300000 | 1000 to 3600000 |
/// | `chunkMaxBytes` | number | 262144 | 4096 to 1048576 |
public struct ReplayOTLPOptions: Sendable {
    public var logsUrl: URL
    public var scope: ReplayScope
    public var recorder: ReplayRecorderMode
    /// When to look: the pacing the legacy path calls `mode`.
    public var cadence: ReplayMode
    /// Seconds the ring holds; nil records the whole session.
    public var bufferSeconds: Double?
    /// 32 lowercase hex characters, nil to generate one.
    public var replayId: String?
    public var keyframeIntervalMs: Int64
    public var chunkMaxBytes: Int
    /// What ended the previous process, for the `ouo.replay.ended` of a stream it left open.
    public var previousExit: ReplayEndReason

    public init(logsUrl: URL, scope: ReplayScope, recorder: ReplayRecorderMode = .pixelFrames, cadence: ReplayMode = .auto, bufferSeconds: Double? = nil, replayId: String? = nil, keyframeIntervalMs: Int64 = 300_000, chunkMaxBytes: Int = 256 * 1024, previousExit: ReplayEndReason = .backgroundKill) {
        self.logsUrl = logsUrl
        self.scope = scope
        self.recorder = recorder
        self.cadence = cadence
        self.bufferSeconds = bufferSeconds
        self.replayId = replayId
        self.keyframeIntervalMs = keyframeIntervalMs
        self.chunkMaxBytes = chunkMaxBytes
        self.previousExit = previousExit
    }

    public var streamConfig: ReplayStreamConfig {
        ReplayStreamConfig(mode: bufferSeconds == nil ? .session : .buffer, bufferSeconds: bufferSeconds ?? 60, keyframeIntervalMs: keyframeIntervalMs, chunkMaxBytes: chunkMaxBytes)
    }

    public enum Parsed: Sendable {
        /// No `otlp` key: the caller wants the upload path that existed before, with its options
        /// read as before.
        case legacy
        case otlp(ReplayOTLPOptions, problems: [String])
        /// OTLP was asked for but replay cannot run: nothing starts, nothing throws.
        case off(problems: [String])
    }

    static let maxResourceAttributes = 128
    static let maxStringLength = 2048
    public static let defaultBufferSeconds = 60.0

    public static func parse(_ raw: [String: Any]) -> Parsed {
        guard let rawOtlp = raw["otlp"], !(rawOtlp is NSNull) else { return .legacy }
        var problems: [String] = []
        guard let otlp = rawOtlp as? [String: Any] else {
            return .off(problems: ["otlp is not an object"])
        }
        guard let logs = string(otlp["logsUrl"]), let url = URL(string: logs.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", let host = url.host, !host.isEmpty else {
            return .off(problems: ["otlp.logsUrl is missing or not an http(s) URL"])
        }

        func text(_ key: String, in dict: [String: Any], _ path: String) -> String? {
            guard let value = dict[key], !(value is NSNull) else { return nil }
            guard let s = string(value) else {
                problems.append("\(path) is not a string")
                return nil
            }
            return String(s.prefix(maxStringLength))
        }
        func clamped(_ value: Any?, _ path: String, _ range: ClosedRange<Double>) -> Double? {
            guard let value, !(value is NSNull) else { return nil }
            guard let n = number(value) else {
                problems.append("\(path) is not a finite number")
                return nil
            }
            if !range.contains(n) { problems.append("\(path) is out of range, clamped") }
            return min(max(n, range.lowerBound), range.upperBound)
        }

        // The recorder first: a mode this build cannot record leaves replay off (never a guess).
        var recorder = ReplayRecorderMode.pixelFrames
        if let rawMode = raw["mode"], !(rawMode is NSNull) {
            guard let name = string(rawMode), let mode = ReplayRecorderMode(rawValue: name) else {
                return .off(problems: ["mode is not a replay mode (pixel/frames, pixel/video, structure/wireframe)"])
            }
            guard ReplayRecorderMode.supported.contains(mode) else {
                return .off(problems: ["mode \(mode.rawValue) is not supported by this build"])
            }
            recorder = mode
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

        var options = ReplayOTLPOptions(
            logsUrl: url,
            scope: ReplayScope(
                resource: resource,
                scopeVersion: text("scopeVersion", in: otlp, "otlp.scopeVersion") ?? "",
                schemaUrl: text("schemaUrl", in: otlp, "otlp.schemaUrl") ?? ""
            ),
            recorder: recorder
        )
        if let cadence = text("cadence", in: raw, "cadence") {
            if let c = ReplayMode(rawValue: cadence) { options.cadence = c } else { problems.append("cadence is not auto, session or navigation") }
        }
        // `buffer` absent, null or false: the whole session. An object: its seconds. Anything else
        // still asks for a buffer, so it gets the default rather than a full recording.
        if let rawBuffer = raw["buffer"], !(rawBuffer is NSNull), bool(rawBuffer) != false {
            if let buffer = rawBuffer as? [String: Any] {
                options.bufferSeconds = clamped(buffer["seconds"], "buffer.seconds", 5...600) ?? defaultBufferSeconds
            } else {
                problems.append("buffer is not an object, \(Int(defaultBufferSeconds)) seconds assumed")
                options.bufferSeconds = defaultBufferSeconds
            }
        }
        if let id = text("replayId", in: raw, "replayId"), !id.isEmpty {
            if ReplayStream.isValidId(id) { options.replayId = id } else { problems.append("replayId is not 32 lowercase hex characters, a new one is generated") }
        }
        if let exit = text("previousExit", in: otlp, "otlp.previousExit") {
            if exit == ReplayEndReason.crash.rawValue { options.previousExit = .crash } else if exit != ReplayEndReason.backgroundKill.rawValue { problems.append("otlp.previousExit is not crash or background_kill") }
        }
        if let n = clamped(raw["keyframeIntervalMs"], "keyframeIntervalMs", 1000...3_600_000) { options.keyframeIntervalMs = Int64(n) }
        if let n = clamped(raw["chunkMaxBytes"], "chunkMaxBytes", 4096...Double(ReplayStreamConfig.hardLimitBytes)) { options.chunkMaxBytes = Int(n) }
        return .otlp(options, problems: problems)
    }

    /// The start options that are not about OTLP (credential, session, pacing, masking), read
    /// with the same leniency for the OTLP path. The legacy path keeps its own strict reading.
    public struct Common: Sendable, Equatable {
        public var sessionId = ""
        public var projectId = ""
        public var projectToken = ""
        public var frameInterval = 1.0
        public var maskText = true
        public var maskInputs = true
        public var maskImages = true
        public var maskWebViews = true
        public var debug = false

        public init() {}

        /// `problems` lists every value that was there but not usable. A mask option that is not
        /// a boolean masks (the safe side).
        public static func parse(_ raw: [String: Any]) -> (common: Common, problems: [String]) {
            var c = Common()
            var problems: [String] = []
            func text(_ key: String) -> String? {
                guard let value = raw[key], !(value is NSNull) else { return nil }
                guard let s = value as? String else {
                    problems.append("\(key) is not a string")
                    return nil
                }
                return String(s.trimmingCharacters(in: .whitespacesAndNewlines).prefix(maxStringLength))
            }
            func flag(_ key: String, _ fallback: Bool) -> Bool {
                guard let value = raw[key], !(value is NSNull) else { return fallback }
                guard let b = ReplayOTLPOptions.bool(value) else {
                    problems.append("\(key) is not a boolean")
                    return fallback
                }
                return b
            }
            c.sessionId = text("sessionId") ?? ""
            c.projectId = text("projectId") ?? ""
            c.projectToken = text("projectToken") ?? ""
            if let value = raw["frameInterval"], !(value is NSNull) {
                if let n = ReplayOTLPOptions.number(value) {
                    if !(0.1...60).contains(n) { problems.append("frameInterval is out of range, clamped") }
                    c.frameInterval = min(max(n, 0.1), 60)
                } else {
                    problems.append("frameInterval is not a finite number")
                }
            }
            c.maskText = flag("maskText", true)
            c.maskInputs = flag("maskInputs", true)
            c.maskImages = flag("maskImages", true)
            c.maskWebViews = flag("maskWebViews", true)
            c.debug = flag("debug", false)
            return (c, problems)
        }
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
        guard let value, isBoolean(value) else { return nil }
        return (value as? Bool) ?? (value as? NSNumber)?.boolValue
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
