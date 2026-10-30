import Foundation
import Testing
@testable import OuoCrash
import OuoCrashCore
import OuoVitals

/// The `hang` report (spec C3.1): the main thread's stack read from another thread, in the crash
/// report's frames and images, so dSYM symbolication reads it like a crash.
@Suite struct HangReportTests {
    @Test func theMainThreadStackIsReadFromAnotherThread() throws {
        var frames: [UInt] = []
        let done = DispatchSemaphore(value: 0)
        Thread.detachNewThread {
            var buf = [UInt](repeating: 0, count: 128)
            let n = Int(ouo_crash_main_thread_backtrace(&buf, Int32(buf.count)))
            frames = Array(buf.prefix(n))
            done.signal()
        }
        done.wait()
        // The main thread waits somewhere in the test runner: pc, and its callers up to `start`.
        #expect(frames.count >= 2, "\(frames)")
        var info = ouo_crash_image_info()
        #expect(ouo_crash_image_for(frames[0], &info), "pc is in a loaded image")
        #expect(info.has_uuid)
    }

    @Test func theReportCarriesDurationKindFramesAndImages() throws {
        // An address inside this test binary, as a frame of the "main thread".
        let here = UInt(bitPattern: unsafeBitCast(HangReportTests.marker as @convention(c) () -> Void, to: UnsafeRawPointer.self))
        let raw = OuoCrash.hangReport(Hang(start: 10, end: 13.0125, fullyBlocking: true), startMs: 1_760_000_000_000.4, frames: [here, here + 4, 0x10])
        let r = try #require(try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
        #expect(r["mechanism"] as? String == "hang")
        #expect((r["timestamp_ms"] as? NSNumber)?.doubleValue == 1_760_000_000_000)
        #expect((r["thread"] as? [String: Any])?["main"] as? Bool == true)
        let hang = try #require(r["hang"] as? [String: Any])
        #expect((hang["duration_ms"] as? NSNumber)?.doubleValue == 3012.5)
        #expect(hang["fully_blocking"] as? Bool == true)
        let frames = try #require(r["frames"] as? [[String: Any]])
        #expect(frames.count == 3)
        #expect(frames[0]["instruction_addr"] as? String == "0x" + String(here, radix: 16))
        #expect(frames[2]["image_addr"] == nil, "an address outside every image has no image")
        let images = try #require(r["images"] as? [[String: Any]])
        #expect(images.count == 1, "one entry per image a frame points into")
        #expect(images[0]["image_addr"] as? String == frames[0]["image_addr"] as? String)
        #expect((images[0]["debug_id"] as? String)?.count == 36)
        #expect((images[0]["code_file"] as? String)?.isEmpty == false)
    }

    static let marker: @convention(c) () -> Void = {}
}
