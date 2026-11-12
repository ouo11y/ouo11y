import Foundation
import Testing
@testable import OuoReplayCore

/// Item G: the start options as JavaScript passes them (ADR-0021 decision 5).
@Suite struct ReplayOptionsTests {
    private let otlp: [String: Any] = ["logsUrl": "http://localhost:4318/v1/logs"]

    private func parsed(_ raw: [String: Any]) throws -> (ReplayOTLPOptions, [String]) {
        guard case .otlp(let options, let problems) = ReplayOTLPOptions.parse(raw) else {
            throw NSError(domain: "expected otlp options", code: 0)
        }
        return (options, problems)
    }

    private func isLegacy(_ raw: [String: Any]) -> Bool {
        if case .legacy = ReplayOTLPOptions.parse(raw) { return true }
        return false
    }

    private func offProblems(_ raw: [String: Any]) -> [String]? {
        if case .off(let problems) = ReplayOTLPOptions.parse(raw) { return problems }
        return nil
    }

    @Test func WithoutOtlpTheLegacyPathIsUntouched() {
        #expect(isLegacy([:]))
        #expect(isLegacy(["otlp": NSNull()]))
        // Today's options, the old `mode` values included: none of them is looked at.
        #expect(isLegacy(["sessionId": "s", "projectId": "demo", "projectToken": "t", "mode": "navigation", "frameInterval": 1.0, "holdUploads": true]))
        #expect(isLegacy(["mode": "pixel/frames", "buffer": ["seconds": 30]]))
    }

    @Test func Defaults() throws {
        let (o, problems) = try parsed(["otlp": otlp])
        #expect(problems.isEmpty)
        #expect(o.logsUrl.absoluteString == "http://localhost:4318/v1/logs")
        #expect(o.recorder == .pixelFrames)
        #expect(o.cadence == .auto)
        #expect(o.bufferSeconds == nil)
        #expect(o.replayId == nil)
        #expect(o.keyframeIntervalMs == 300_000)
        #expect(o.chunkMaxBytes == 256 * 1024)
        #expect(o.previousExit == .backgroundKill)
        #expect(o.scope == ReplayScope(resource: [], scopeVersion: "", schemaUrl: ""))
        let config = o.streamConfig
        #expect(config.mode == .session)
        #expect(config.chunkMaxMs == 5000)
        #expect(config.chunkMaxBytes == 262_144)
    }

    @Test func EveryKey() throws {
        let (o, problems) = try parsed([
            "otlp": [
                "logsUrl": " https://collector.example.com/v1/logs ",
                "resource": ["service.name": "shop", "build": 42, "ratio": 0.5, "debuggable": true, "big": 1e20],
                "schemaUrl": "https://opentelemetry.io/schemas/1.0.0",
                "scopeVersion": "1.2.3",
                "previousExit": "crash",
            ] as [String: Any],
            "mode": "pixel/frames",
            "cadence": "navigation",
            "buffer": ["seconds": 30],
            "replayId": "00112233445566778899aabbccddeeff",
            "keyframeIntervalMs": 60_000,
            "chunkMaxBytes": 100_000.0,
        ])
        #expect(problems.isEmpty)
        #expect(o.logsUrl.absoluteString == "https://collector.example.com/v1/logs")
        // In key order, so two launches write the same bytes.
        #expect(o.scope.resource == [
            ReplayAttribute("big", .double(1e20)),
            ReplayAttribute("build", Int64(42)),
            ReplayAttribute("debuggable", true),
            ReplayAttribute("ratio", .double(0.5)),
            ReplayAttribute("service.name", "shop"),
        ])
        #expect(o.scope.schemaUrl == "https://opentelemetry.io/schemas/1.0.0")
        #expect(o.scope.scopeVersion == "1.2.3")
        #expect(o.previousExit == .crash)
        #expect(o.cadence == .navigation)
        #expect(o.bufferSeconds == 30)
        #expect(o.replayId == "00112233445566778899aabbccddeeff")
        #expect(o.keyframeIntervalMs == 60_000)
        #expect(o.chunkMaxBytes == 100_000)
        #expect(o.streamConfig.mode == .buffer)
        #expect(o.streamConfig.bufferSeconds == 30)
    }

    @Test func ModeIsOneStringWithNoShorthand() throws {
        #expect(ReplayRecorderMode.allCases.map(\.rawValue) == ["pixel/frames", "pixel/video", "structure/wireframe"])
        #expect(ReplayRecorderMode.supported == [.pixelFrames])
        // Modes this build does not record leave replay off; so does anything that is not a mode,
        // the shorthands and the legacy cadence values included. Nothing throws.
        for mode in ["pixel/video", "structure/wireframe"] {
            #expect(offProblems(["otlp": otlp, "mode": mode]) == ["mode \(mode) is not supported by this build"])
        }
        for mode: Any in ["pixel", "structure", "frames", "PIXEL/FRAMES", "pixel/frames ", "structure/dom", "auto", "session", "navigation", "buffer", "", 3, true, ["pixel/frames"]] {
            #expect(offProblems(["otlp": otlp, "mode": mode])?.count == 1)
        }
        #expect(try parsed(["otlp": otlp, "mode": NSNull()]).0.recorder == .pixelFrames)
        // There is no `format` or `replayMode` key: they are not read.
        let (o, problems) = try parsed(["otlp": otlp, "format": "structure", "replayMode": "buffer", "bufferSeconds": 10])
        #expect(problems.isEmpty)
        #expect(o.recorder == .pixelFrames)
        #expect(o.bufferSeconds == nil)
    }

    @Test func BufferIsAKeyNotAMode() throws {
        #expect(try parsed(["otlp": otlp]).0.bufferSeconds == nil)
        #expect(try parsed(["otlp": otlp, "buffer": NSNull()]).0.bufferSeconds == nil)
        #expect(try parsed(["otlp": otlp, "buffer": false]).0.bufferSeconds == nil)
        // Present without seconds: the default.
        #expect(try parsed(["otlp": otlp, "buffer": [String: Any]()]).0.bufferSeconds == 60)
        #expect(try parsed(["otlp": otlp, "buffer": ["seconds": NSNull()]]).0.bufferSeconds == 60)
        #expect(try parsed(["otlp": otlp, "buffer": ["seconds": 45.5]]).0.bufferSeconds == 45.5)
        // Out of range: clamped and reported.
        let low = try parsed(["otlp": otlp, "buffer": ["seconds": 0]])
        #expect(low.0.bufferSeconds == 5)
        #expect(low.1 == ["buffer.seconds is out of range, clamped"])
        #expect(try parsed(["otlp": otlp, "buffer": ["seconds": 1e12]]).0.bufferSeconds == 600)
        #expect(try parsed(["otlp": otlp, "buffer": ["seconds": -5]]).0.bufferSeconds == 5)
        // Asked for, but not in a usable shape: still a buffer, never a full recording.
        for odd: Any in [true, 30, "30", ["seconds"]] {
            let (o, problems) = try parsed(["otlp": otlp, "buffer": odd])
            #expect(o.bufferSeconds == 60)
            #expect(problems.count == 1)
        }
        let (o, problems) = try parsed(["otlp": otlp, "buffer": ["seconds": "soon"]])
        #expect(o.bufferSeconds == 60)
        #expect(problems == ["buffer.seconds is not a finite number"])
    }

    @Test func CadenceKeepsTheOldValuesUnderItsNewName() throws {
        for (name, mode) in [("auto", ReplayMode.auto), ("session", .session), ("navigation", .navigation)] {
            let (o, problems) = try parsed(["otlp": otlp, "cadence": name])
            #expect(o.cadence == mode)
            #expect(problems.isEmpty)
        }
        let (o, problems) = try parsed(["otlp": otlp, "cadence": "fast"])
        #expect(o.cadence == .auto)
        #expect(problems == ["cadence is not auto, session or navigation"])
    }

    @Test func AnUnusableLogsUrlLeavesReplayOff() {
        let bad: [Any] = [
            "nope", ["logsUrl": ""], ["logsUrl": "not a url"], ["logsUrl": "ftp://host/v1/logs"], ["logsUrl": "/v1/logs"],
            ["logsUrl": "http://"], ["logsUrl": 4318], ["logsUrl": NSNull()], [String: Any](), ["url": "http://localhost:4318/v1/logs"], 7, true, ["a", "b"],
        ]
        for value in bad {
            #expect(offProblems(["otlp": value])?.count == 1)
        }
    }

    @Test func CommonOptionsAreReadLeniently() {
        let (c, problems) = ReplayOTLPOptions.Common.parse([
            "sessionId": " abc ", "projectId": "demo", "projectToken": "pt", "frameInterval": 2, "maskText": false, "maskInputs": true,
            "maskImages": false, "maskWebViews": true, "debug": true,
        ])
        #expect(problems.isEmpty)
        #expect(c.sessionId == "abc")
        #expect(c.projectId == "demo")
        #expect(c.projectToken == "pt")
        #expect(c.frameInterval == 2)
        #expect(!c.maskText && c.maskInputs && !c.maskImages && c.maskWebViews && c.debug)

        #expect(ReplayOTLPOptions.Common.parse([:]).common == ReplayOTLPOptions.Common())
        // Wrong types: defaults, and a mask option that is not a boolean masks.
        let (odd, oddProblems) = ReplayOTLPOptions.Common.parse([
            "sessionId": 5, "projectId": ["x"], "projectToken": NSNull(), "frameInterval": "fast", "maskText": "no", "maskInputs": 0,
            "maskImages": NSNull(), "maskWebViews": [false], "debug": "yes",
        ])
        #expect(odd == ReplayOTLPOptions.Common())
        #expect(oddProblems.count == 7)
        #expect(ReplayOTLPOptions.Common.parse(["frameInterval": 0]).common.frameInterval == 0.1)
        #expect(ReplayOTLPOptions.Common.parse(["frameInterval": 1e9]).common.frameInterval == 60)
        #expect(ReplayOTLPOptions.Common.parse(["frameInterval": Double.nan]).common.frameInterval == 1)
    }

    @Test func NumbersAndBooleansFromTheBridgeAreToldApart() {
        // The bridge can hand a number or a boolean over as NSNumber.
        #expect(ReplayOTLPOptions.number(NSNumber(value: 1)) == 1)
        #expect(ReplayOTLPOptions.number(NSNumber(value: 2.5)) == 2.5)
        #expect(ReplayOTLPOptions.number(NSNumber(value: true)) == nil)
        #expect(ReplayOTLPOptions.number(true) == nil)
        #expect(ReplayOTLPOptions.number(3) == 3)
        #expect(ReplayOTLPOptions.number("3") == nil)
        #expect(ReplayOTLPOptions.number(Double.infinity) == nil)
        #expect(ReplayOTLPOptions.number(nil) == nil)
        #expect(ReplayOTLPOptions.bool(NSNumber(value: true)) == true)
        #expect(ReplayOTLPOptions.bool(false) == false)
        #expect(ReplayOTLPOptions.bool(NSNumber(value: 1)) == nil)
        #expect(ReplayOTLPOptions.bool(1) == nil)
        #expect(ReplayOTLPOptions.bool("true") == nil)
        #expect(ReplayOTLPOptions.attribute(NSNumber(value: true)) == .bool(true))
        #expect(ReplayOTLPOptions.attribute(NSNumber(value: 1)) == .int(1))
        #expect(ReplayOTLPOptions.attribute(1.0) == .int(1))
        #expect(ReplayOTLPOptions.attribute(1.5) == .double(1.5))
        #expect(ReplayOTLPOptions.attribute(["a"]) == nil)
    }
}
