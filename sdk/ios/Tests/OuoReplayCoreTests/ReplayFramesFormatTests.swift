import Foundation
import Testing
import CoreGraphics
@testable import OuoReplayCore

/// Item A: the frames adapter (`ouo-frames/3`) behind the format seam, and the masking rules every
/// recorder shares (the mask registry, secure fields, mask wins).
@Suite struct ReplayFramesFormatTests {
    private let t0: EpochMillis = 1_760_000_000_000

    /// A 256 x 256 px image: a background and one square.
    private func image(square: CGRect? = nil, gray: CGFloat = 0.9) throws -> CGImage {
        let ctx = try #require(FrameComposer.makeContext(pixelWidth: 256, pixelHeight: 256))
        ctx.setFillColor(CGColor(gray: gray, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 256, height: 256))
        if let square {
            ctx.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
            ctx.fill(square)
        }
        return try #require(ctx.makeImage())
    }

    private func look(_ image: CGImage, rects: [CGRect] = [], reason: FrameReason = .timer) -> PixelLook {
        PixelLook(image: image, rects: rects, width: 256, height: 256, scale: 1, reason: reason)
    }

    private func object(_ event: ReplayEvent) throws -> [String: Any] {
        #expect(!event.json.contains(UInt8(ascii: "\n")))
        return try jsonObject(event.json)
    }

    @Test func FormatIdEncodingAndCompression() throws {
        let adapter = PixelFormatAdapter()
        #expect(adapter.formatId == "ouo-frames/3")
        #expect(adapter.encoding == "gzip")
        #expect(adapter.masked)
        let payload = Data("{\"t\":1}\n{\"t\":2}\n".utf8)
        #expect(try Gzip.decompress(try adapter.compress(payload)) == payload)
    }

    @Test func FirstLookIsAFrameThenPatchesThenNothing() throws {
        let adapter = PixelFormatAdapter()
        let first = try adapter.events(for: look(try image(), reason: .resume), at: t0)
        #expect(first.count == 1)
        #expect(first[0].keyframe)
        #expect(first[0].t == t0)
        let frame = try object(first[0])
        #expect(Set(frame.keys) == ["t", "type", "w", "h", "scale", "reason", "jpeg"])
        #expect(frame["type"] as? String == "frame")
        #expect(frame["t"] as? Int64 == t0)
        #expect(frame["w"] as? Int == 256)
        #expect(frame["h"] as? Int == 256)
        #expect(frame["scale"] as? Int == 1)
        #expect(frame["reason"] as? String == "resume")
        let base64 = try #require(frame["jpeg"] as? String)
        let jpeg = try #require(Data(base64Encoded: base64))
        #expect(Array(jpeg.prefix(2)) == [0xff, 0xd8])

        // The same screen again: nothing.
        #expect(try adapter.events(for: look(try image()), at: t0 + 1000).isEmpty)

        // One tile changed: a patch, not a keyframe.
        let second = try adapter.events(for: look(try image(square: CGRect(x: 8, y: 8, width: 16, height: 16))), at: t0 + 2000)
        #expect(second.count == 1)
        #expect(!second[0].keyframe)
        let patch = try object(second[0])
        #expect(Set(patch.keys) == ["t", "type", "reason", "patches"])
        #expect(patch["type"] as? String == "patch")
        let patches = try #require(patch["patches"] as? [[String: Any]])
        #expect(patches.count == 1)
        #expect(Set(patches[0].keys) == ["x", "y", "w", "h", "jpeg"])
        #expect(patches[0]["w"] as? Int == 64)
        #expect(patches[0]["h"] as? Int == 64)
    }

    @Test func AKeyframeOnRequestEvenWhenNothingChanged() throws {
        let adapter = PixelFormatAdapter()
        _ = try adapter.events(for: look(try image()), at: t0)
        #expect(try adapter.events(for: look(try image()), at: t0 + 1).isEmpty)
        adapter.requestKeyframe()
        let again = try adapter.events(for: look(try image()), at: t0 + 2)
        #expect(again.count == 1)
        #expect(again[0].keyframe)
        #expect(try object(again[0])["type"] as? String == "frame")
    }

    @Test func MaskingHappensBeforeAnythingIsEncoded() throws {
        // Two looks at the same screen, one with the red square masked: the frames differ, and the
        // masked one equals a frame of a screen where the square is black.
        let red = try image(square: CGRect(x: 64, y: 64, width: 64, height: 64))
        let rect = CGRect(x: 64, y: 128, width: 64, height: 64) // top-left origin, points
        let masked = try PixelFormatAdapter(jpegQuality: 1).events(for: look(red, rects: [rect]), at: t0)
        let plain = try PixelFormatAdapter(jpegQuality: 1).events(for: look(red), at: t0)
        #expect(masked[0].json != plain[0].json)
        let ctx = try #require(FrameComposer.makeContext(pixelWidth: 256, pixelHeight: 256))
        ctx.setFillColor(CGColor(gray: 0.9, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 256, height: 256))
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.fill(CGRect(x: 64, y: 64, width: 64, height: 64))
        let black = try PixelFormatAdapter(jpegQuality: 1).events(for: look(try #require(ctx.makeImage())), at: t0)
        #expect(masked[0].json == black[0].json)
    }

    @Test func ALookItCannotEncodeThrowsAndIsNotCommitted() throws {
        let adapter = PixelFormatAdapter()
        #expect(throws: ReplayFormatError.wrongLook) { try adapter.events(for: StubLook(content: "x"), at: t0) }
        for bad in [
            PixelLook(image: try image(), rects: [], width: 0, height: 256, scale: 1, reason: .timer),
            PixelLook(image: try image(), rects: [], width: 256, height: 256, scale: .nan, reason: .timer),
            PixelLook(image: try image(), rects: [], width: 256, height: 256, scale: -1, reason: .timer),
            PixelLook(image: try image(), rects: [], width: 1e9, height: 1e9, scale: 3, reason: .timer),
        ] {
            #expect(throws: ReplayFormatError.encodingFailed) { try adapter.events(for: bad, at: t0) }
        }
        // Still a keyframe next: the failures left no frame behind to diff against.
        #expect(try adapter.events(for: look(try image()), at: t0).first?.keyframe == true)
    }

    @Test func TouchEventIsOneJSONLine() throws {
        let adapter = PixelFormatAdapter()
        let event = try #require(adapter.touchEvent(Touch(ts: t0, x: 12.5, y: 300, phase: .moved)))
        #expect(!event.keyframe)
        #expect(String(decoding: event.json, as: UTF8.self) == "{\"t\":\(t0),\"type\":\"touch\",\"x\":12.50,\"y\":300,\"phase\":\"moved\"}")
        // Numbers that JSON cannot hold do not reach the payload.
        let odd = try #require(adapter.touchEvent(Touch(ts: t0, x: .nan, y: .infinity, phase: .began)))
        #expect(try jsonObject(odd.json)["x"] as? Int == 0)
    }

    @Test func FramesThroughTheStreamAreValidNDJSON() throws {
        let sink = RecordingSink()
        let stream = ReplayStream(sessionId: "s", scope: testScope, adapter: PixelFormatAdapter(), sink: sink)
        stream.look(look(try image()), at: t0)
        stream.touch(Touch(ts: t0 + 10, x: 1, y: 1, phase: .began))
        stream.look(look(try image(square: CGRect(x: 0, y: 0, width: 10, height: 10))), at: t0 + 1000)
        stream.end(reason: .stop)
        let chunk = try #require(try sink.chunks().first)
        #expect(chunk.string("ouo.replay.format") == "ouo-frames/3")
        #expect(chunk.string("ouo.replay.encoding") == "gzip")
        #expect(chunk.bool("ouo.replay.masked") == true)
        let body = try #require(chunk.body)
        #expect(chunk.string("ouo.replay.sha256") == ReplayEnvelope.sha256Hex(body))
        let types = try String(decoding: try Gzip.decompress(body), as: UTF8.self).split(separator: "\n").map { try jsonObject(Data($0.utf8))["type"] as? String }
        #expect(types == ["frame", "touch", "patch"])
    }

    @Test func JSONStringsNeverHoldARawLineBreak() {
        let s = ReplayJSON.string("a\nb\r\tc\u{2028}d\u{2029}e\u{0}\"\\é")
        #expect(!s.contains("\n") && !s.contains("\u{2028}") && !s.contains("\u{2029}"))
        #expect(s == "\"a\\nb\\r\\tc\\u2028d\\u2029e\\u0000\\\"\\\\é\"")
        #expect(ReplayJSON.number(1.005) == "1" || ReplayJSON.number(1.005) == "1.01")
        #expect(ReplayJSON.number(-0.5) == "-0.50")
        #expect(ReplayJSON.number(.infinity) == "0")
        #expect(ReplayJSON.number(1e300) == "9007199254740992")
    }

    // MARK: masking shared by every recorder

    private let window = CGRect(x: 0, y: 0, width: 400, height: 800)

    private func view(_ frame: CGRect, _ maskOverride: ViewNode.MaskOverride?, _ children: [ViewNode] = []) -> ViewNode {
        ViewNode(className: "UIView", frameInWindow: frame, children: children, maskOverride: maskOverride)
    }

    private func strict(_ rules: RedactionRules = RedactionRules()) -> RedactionPlanner {
        var rules = rules
        rules.strict = true
        return RedactionPlanner(rules: rules, mergeOverlapping: false)
    }

    @Test func ASecureFieldIsMaskedWhateverTheOptionsAndOverridesSay() throws {
        let field = CGRect(x: 10, y: 100, width: 200, height: 40)
        let secure = ViewNode(className: "UITextField", frameInWindow: field, secure: true)
        let nothingMasked = RedactionRules(maskText: false, maskInputs: false, maskImages: false, maskWebViews: false)
        // Every option off.
        #expect(strict(nothingMasked).rects(for: ViewNode(className: "UIView", frameInWindow: window, children: [secure]), window: window) == [field])
        // Unmasked itself, by identifier and by the registry.
        var own = secure
        own.accessibilityIdentifier = RedactionRules.unmaskIdentifier
        #expect(strict(nothingMasked).rects(for: own, window: window) == [field])
        own.accessibilityIdentifier = nil
        own.maskOverride = .unmask
        #expect(strict().rects(for: own, window: window) == [field])
        // Inside an unmasked container.
        let container = ViewNode(className: "UIView", frameInWindow: window, accessibilityIdentifier: RedactionRules.unmaskIdentifier, children: [
            ViewNode(className: "UILabel", frameInWindow: CGRect(x: 10, y: 10, width: 100, height: 20)),
            secure,
        ])
        #expect(strict().rects(for: container, window: window) == [field])
        // Inside SwiftUI's unmask area, which removes rectangles masked by class.
        let area = ViewNode(className: "UIView", frameInWindow: window, children: [
            ViewNode(className: "UIView", frameInWindow: window, accessibilityIdentifier: RedactionRules.unmaskAreaIdentifier),
            ViewNode(className: "UILabel", frameInWindow: CGRect(x: 10, y: 10, width: 100, height: 20)),
            secure,
        ])
        #expect(strict().rects(for: area, window: window) == [field])
        // A secure field that is moving drops the frame, like any masked view (PRV-8).
        var moving = secure
        moving.moving = true
        #expect(strict(nothingMasked).rects(for: moving, window: window) == nil)
    }

    @Test func MaskWinsInsideAnUnmaskedSubtree() throws {
        let label = CGRect(x: 10, y: 10, width: 100, height: 20)
        let inner = CGRect(x: 10, y: 50, width: 100, height: 20)
        let tree = view(window, .unmask, [
            ViewNode(className: "UILabel", frameInWindow: label),
            view(inner, .mask, [
                view(inner, .unmask),
            ]),
            ViewNode(className: "UIView", frameInWindow: CGRect(x: 10, y: 90, width: 100, height: 20), accessibilityIdentifier: RedactionRules.maskIdentifier),
        ])
        // The label shows (unmasked); both masks inside still mask.
        #expect(strict().rects(for: tree, window: window) == [inner, CGRect(x: 10, y: 90, width: 100, height: 20)])
        // A subtree cut off by the depth limit is masked even when unmasked.
        let cut = view(window, .unmask, [
            ViewNode(className: "UIView", frameInWindow: inner, truncated: true),
        ])
        #expect(strict().rects(for: cut, window: window) == [inner])
    }

    @Test func WithoutStrictTheNativeSDKsBehaviourIsUnchanged() throws {
        let field = CGRect(x: 10, y: 100, width: 200, height: 40)
        let tree = ViewNode(className: "UIView", frameInWindow: window, accessibilityIdentifier: RedactionRules.unmaskIdentifier, children: [
            ViewNode(className: "UITextField", frameInWindow: field, secure: true),
            ViewNode(className: "UIView", frameInWindow: field, accessibilityIdentifier: RedactionRules.maskIdentifier),
        ])
        // As shipped: `ouo-unmask` opts its whole subtree out.
        #expect(RedactionPlanner(rules: RedactionRules()).rects(for: tree, window: window) == [])
        let off = RedactionRules(maskText: true, maskInputs: false)
        #expect(RedactionPlanner(rules: off).rects(for: ViewNode(className: "UITextField", frameInWindow: field, secure: true), window: window) == [])
    }

    @Test func TheRegistryResolvesTagsAndIdentifiersTheSameWayForEveryRecorder() {
        let registry = ReplayMaskRegistry()
        registry.mask(reactTag: 7)
        registry.unmask(reactTag: 9)
        let snap = registry.snapshot()
        #expect(snap.override(reactTag: 7, accessibilityIdentifier: nil) == .mask)
        #expect(snap.override(reactTag: 9, accessibilityIdentifier: nil) == .unmask)
        #expect(snap.override(reactTag: 3, accessibilityIdentifier: nil) == nil)
        #expect(snap.override(reactTag: nil, accessibilityIdentifier: nil) == nil)
        // The native identifiers go through the same answer.
        #expect(snap.override(reactTag: nil, accessibilityIdentifier: "ouo-mask") == .mask)
        #expect(snap.override(reactTag: nil, accessibilityIdentifier: "ouo-unmask") == .unmask)
        #expect(snap.override(reactTag: nil, accessibilityIdentifier: "other") == nil)
        // Mask wins on one view, whichever way each was said.
        #expect(snap.override(reactTag: 9, accessibilityIdentifier: "ouo-mask") == .mask)
        #expect(snap.override(reactTag: 7, accessibilityIdentifier: "ouo-unmask") == .mask)
        // The last call for a tag decides.
        registry.unmask(reactTag: 7)
        registry.mask(reactTag: 9)
        #expect(registry.snapshot() == ReplayMaskRegistry.Snapshot(masked: [9], unmasked: [7]))
        // A walk keeps the snapshot it started with.
        #expect(snap.override(reactTag: 7, accessibilityIdentifier: nil) == .mask)
        registry.reset()
        #expect(registry.snapshot() == ReplayMaskRegistry.Snapshot())
    }

    @Test func TheRegistryIsBounded() {
        let registry = ReplayMaskRegistry()
        for tag in 0..<(ReplayMaskRegistry.limit + 50) {
            registry.mask(reactTag: tag)
            registry.unmask(reactTag: -tag - 1)
        }
        #expect(registry.snapshot().masked.count == ReplayMaskRegistry.limit)
        #expect(registry.snapshot().unmasked.count == ReplayMaskRegistry.limit)
        #expect(registry.refused == 100)
        // A tag already there is not refused.
        registry.mask(reactTag: 1)
        #expect(registry.refused == 100)
    }

    /// A mask refused at the limit must not leave its view unmasked: the registry fails closed.
    @Test func AFullRegistryStillMasks() {
        let r = ReplayMaskRegistry()
        r.unmask(reactTag: 500_000)
        for tag in 1...ReplayMaskRegistry.limit { r.mask(reactTag: tag) }
        #expect(!r.snapshot().saturated)
        r.mask(reactTag: 999_999)
        let snap = r.snapshot()
        #expect(snap.override(reactTag: 999_999, accessibilityIdentifier: nil) == .mask)
        // Saturated: every tagged view is masked, an unmask by tag is not honoured.
        #expect(snap.override(reactTag: 500_000, accessibilityIdentifier: nil) == .mask)
        #expect(snap.override(reactTag: 123_456_789, accessibilityIdentifier: nil) == .mask)
        // Memory stays bounded.
        #expect(snap.masked.count == ReplayMaskRegistry.limit)
        // A new JavaScript runtime starts over.
        r.reset()
        #expect(r.snapshot() == ReplayMaskRegistry.Snapshot())
        #expect(r.snapshot().override(reactTag: 999_999, accessibilityIdentifier: nil) == nil)
    }
}
