import Foundation
import Testing
@testable import OuoReplayCore

@Suite struct ModelsTests {
    @Test func ChunkJSONMatchesSpecFixtureKeys() throws {
        let fixture = try fixtureData("chunk")
        let decoded = try FrameChunk.decode(fixture)
        #expect(decoded.kind == "frames")
        #expect(decoded.schemaVersion == 2)
        #expect(decoded.mode == "session")
        #expect(decoded.sessionId == "0f9a4e2c-7d3b-4c1e-9a6f-2b8d5e1c3a70")
        #expect(decoded.frames.count == 2)
        #expect(decoded.frames[1].reason == .touch)
        #expect(decoded.frames[0].isFull && decoded.frames[0].patches == nil)
        #expect(!decoded.frames[1].isFull)
        #expect(decoded.frames[1].patches?.first.map { [$0.x, $0.y, $0.w, $0.h] } == [0, 128, 196, 64])
        #expect(decoded.touches.map(\.phase) == [.began, .moved, .ended])
        #expect(decoded.viewport == Viewport(width: 393, height: 852, scale: 0.5))
        #expect(decoded.masked)

        // Re-encoding yields exactly the fixture's key set, snake_case included.
        let reencoded = try jsonObject(try decoded.encodedJSON())
        let expected = try jsonObject(fixture)
        #expect(keyPaths(reencoded) == keyPaths(expected))
        #expect(
            keyPaths(reencoded) == [
                "kind", "schema_version", "session_id", "seq", "started_at", "ended_at",
                "viewport", "viewport.width", "viewport.height", "viewport.scale",
                "platform", "mode", "frames", "frames[].ts", "frames[].jpeg", "frames[].reason",
                "touches", "touches[].ts", "touches[].x", "touches[].y", "touches[].phase", "masked",
            ]
        )
        // Round trip is lossless.
        #expect(try FrameChunk.decode(try decoded.encodedJSON()) == decoded)
    }

    /// A patch frame encodes `patches` and no `jpeg` key (readers tell full from patch frames by it).
    @Test func PatchFrameEncodesPatchesOnly() throws {
        let frame = Frame(ts: 5, patches: [Patch(PixelRect(x: 64, y: 0, w: 18, h: 64), jpegData: Data([0xff, 0xd8]))], reason: .timer)
        let obj = try jsonObject(try JSONEncoder().encode(frame))
        #expect(obj["jpeg"] == nil)
        let patches = try #require(obj["patches"] as? [[String: Any]])
        #expect(patches[0]["x"] as? Int == 64 && patches[0]["w"] as? Int == 18 && patches[0]["h"] as? Int == 64)
        #expect(patches[0]["jpeg"] as? String == "/9g=")
        #expect(frame.imageBytes == 4)
    }

    @Test func EncodedValuesAreSpecTypes() throws {
        let chunk = FrameChunk(
            sessionId: "s", seq: 3, startedAt: 1, endedAt: 2,
            viewport: Viewport(width: 10, height: 20, scale: 1.5),
            frames: [makeFrame(ts: 1, reason: .resume)],
            touches: [Touch(ts: 1, x: 1.5, y: 2, phase: .began)],
            masked: false
        )
        let obj = try jsonObject(try chunk.encodedJSON())
        #expect(obj["kind"] as? String == "frames")
        #expect(obj["schema_version"] as? Int == 2)
        #expect(obj["mode"] as? String == "session")
        #expect(obj["seq"] as? Int == 3)
        #expect(obj["platform"] as? String == "ios")
        #expect(obj["masked"] as? Bool == false)
        let frames = try #require(obj["frames"] as? [[String: Any]])
        #expect(frames[0]["reason"] as? String == "resume")
        #expect(frames[0]["jpeg"] as? String == Data([0xff, 0xd8, 0xff, 0xd9]).base64EncodedString())
        #expect(frames[0]["patches"] == nil, "a full frame carries no patches key")
        let touches = try #require(obj["touches"] as? [[String: Any]])
        #expect(touches[0]["phase"] as? String == "began")
        #expect(touches[0]["x"] as? Double == 1.5)
    }
}
