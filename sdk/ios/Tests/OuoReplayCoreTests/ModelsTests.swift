import Foundation
import Testing
@testable import OuoReplayCore

@Suite struct ModelsTests {
    @Test func ChunkJSONMatchesSpecFixtureKeys() throws {
        let fixture = try fixtureData("chunk")
        let decoded = try FrameChunk.decode(fixture)
        #expect(decoded.kind == "frames")
        #expect(decoded.schemaVersion == 1)
        #expect(decoded.sessionId == "0f9a4e2c-7d3b-4c1e-9a6f-2b8d5e1c3a70")
        #expect(decoded.frames.count == 2)
        #expect(decoded.frames[1].reason == .touch)
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
                "platform", "frames", "frames[].ts", "frames[].jpeg", "frames[].reason",
                "touches", "touches[].ts", "touches[].x", "touches[].y", "touches[].phase", "masked",
            ]
        )
        // Round trip is lossless.
        #expect(try FrameChunk.decode(try decoded.encodedJSON()) == decoded)
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
        #expect(obj["schema_version"] as? Int == 1)
        #expect(obj["seq"] as? Int == 3)
        #expect(obj["platform"] as? String == "ios")
        #expect(obj["masked"] as? Bool == false)
        let frames = try #require(obj["frames"] as? [[String: Any]])
        #expect(frames[0]["reason"] as? String == "resume")
        #expect(frames[0]["jpeg"] as? String == Data([0xff, 0xd8, 0xff, 0xd9]).base64EncodedString())
        let touches = try #require(obj["touches"] as? [[String: Any]])
        #expect(touches[0]["phase"] as? String == "began")
        #expect(touches[0]["x"] as? Double == 1.5)
    }
}
