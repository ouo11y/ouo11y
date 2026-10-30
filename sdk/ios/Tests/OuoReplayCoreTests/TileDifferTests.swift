import Foundation
import Testing
@testable import OuoReplayCore

/// Tile hashing, rectangle merging and the full-image rules of ADR-0014, on raw pixel buffers.
@Suite struct TileDifferTests {
    /// A `w` x `h` frame, 4 bytes per pixel, rows padded to `bytesPerRow`, every pixel 0x11.
    struct Pixels {
        let w: Int, h: Int, bytesPerRow: Int
        var bytes: [UInt8]
        init(w: Int, h: Int, padding: Int = 8) {
            self.w = w
            self.h = h
            bytesPerRow = w * 4 + padding
            bytes = [UInt8](repeating: 0x11, count: bytesPerRow * h)
        }

        /// Changes the pixel at (x, y), top-left origin.
        mutating func poke(_ x: Int, _ y: Int, _ v: UInt8 = 0x99) {
            bytes[y * bytesPerRow + x * 4 + 1] = v
        }

        func diff(_ d: TileDiffer, forceFull: Bool = false) -> TileDiffer.Decision {
            bytes.withUnsafeBytes { d.diff(pixels: $0, width: w, height: h, bytesPerRow: bytesPerRow, forceFull: forceFull) }
        }
    }

    /// Diffs and commits, as the composer does once the JPEGs encoded.
    func sent(_ p: Pixels, _ d: TileDiffer, forceFull: Bool = false) -> TileDiffer.Decision {
        let r = p.diff(d, forceFull: forceFull)
        d.commit()
        return r
    }

    @Test func FirstFrameIsFullThenUnchanged() {
        let d = TileDiffer()
        var p = Pixels(w: 402, h: 874)
        #expect(sent(p, d) == .full)
        #expect(sent(p, d) == .unchanged)
        #expect(sent(p, d, forceFull: true) == .unchanged, "forceFull never sends an unchanged frame")
        // Padding bytes past the row's pixels are not part of the frame.
        p.bytes[p.w * 4] = 0x55
        #expect(sent(p, d) == .unchanged)
    }

    @Test func ChangedTilesBecomePatchesClampedToTheFrame() {
        let d = TileDiffer()
        var p = Pixels(w: 402, h: 874)
        _ = sent(p, d)
        p.poke(0, 0)
        p.poke(401, 873) // last column is 18 px, last row 42 px
        #expect(sent(p, d) == .patches([PixelRect(x: 0, y: 0, w: 64, h: 64), PixelRect(x: 384, y: 832, w: 18, h: 42)]))
    }

    @Test func RunsMergeAcrossRowsWithoutOverlap() {
        // Tiles (tile units): rows 0-1 columns 1-2 form one rectangle; row 1 column 4 its own;
        // row 2 columns 1-3 a different span, so a new rectangle.
        let cols = 6, rows = 3
        var changed = [Bool](repeating: false, count: cols * rows)
        for (c, r) in [(1, 0), (2, 0), (1, 1), (2, 1), (4, 1), (1, 2), (2, 2), (3, 2)] { changed[r * cols + c] = true }
        #expect(TileDiffer.merge(changed, cols: cols, rows: rows) == [
            PixelRect(x: 1, y: 0, w: 2, h: 2),
            PixelRect(x: 4, y: 1, w: 1, h: 1),
            PixelRect(x: 1, y: 2, w: 3, h: 1),
        ])
    }

    @Test func ManyRectanglesBecomeTheirBoundingBox() {
        let d = TileDiffer(maxPatches: 2)
        var p = Pixels(w: 640, h: 640)
        _ = sent(p, d)
        for c in [0, 2, 4] { p.poke(c * 64, 0) }
        #expect(sent(p, d) == .patches([PixelRect(x: 0, y: 0, w: 320, h: 64)]))
    }

    @Test func MoreThanHalfTheFrameIsAFullImage() {
        let d = TileDiffer()
        var p = Pixels(w: 128, h: 128)
        _ = sent(p, d)
        p.poke(0, 0)
        p.poke(64, 0)
        #expect(sent(p, d) == .patches([PixelRect(x: 0, y: 0, w: 128, h: 64)]), "exactly half is still patches")
        p.poke(0, 64, 0x42)
        p.poke(0, 0, 0x43)
        p.poke(64, 0, 0x44)
        #expect(sent(p, d) == .full)
    }

    @Test func ForceFullResetAndSizeChange() {
        let d = TileDiffer()
        var p = Pixels(w: 200, h: 200)
        _ = sent(p, d)
        p.poke(1, 1)
        #expect(sent(p, d, forceFull: true) == .full)
        d.reset()
        #expect(sent(p, d) == .full, "after reset even an unchanged frame is a full image")
        #expect(sent(Pixels(w: 200, h: 100), d) == .full, "a new size is a full image")
    }

    /// Diffs are against the last frame *sent*: a frame that was looked at but not committed
    /// (encoding failed) does not become the reference.
    @Test func OnlyCommittedFramesAreTheReference() {
        let d = TileDiffer()
        var p = Pixels(w: 200, h: 200)
        _ = sent(p, d)
        p.poke(100, 100)
        #expect(p.diff(d) == .patches([PixelRect(x: 64, y: 64, w: 64, h: 64)]))
        // Not committed: the same frame again is still a change.
        #expect(p.diff(d) == .patches([PixelRect(x: 64, y: 64, w: 64, h: 64)]))
        d.commit()
        #expect(p.diff(d) == .unchanged)
    }
}
