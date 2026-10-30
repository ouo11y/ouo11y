import Foundation

/// A rectangle in frame pixels, origin top-left (a schema 2 patch, `docs/specs/mobile-replay.md`).
public struct PixelRect: Equatable, Sendable {
    public var x: Int
    public var y: Int
    public var w: Int
    public var h: Int

    public init(x: Int, y: Int, w: Int, h: Int) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }

    public var area: Int { w * h }
}

/// Decides whether a frame is unchanged, a full image or a list of patches (ADR-0014), by hashing
/// every 64 px tile of the redacted frame and comparing with the last frame *sent*. Changed tiles
/// are merged into rectangles that do not overlap: runs of changed tiles per tile row, and runs
/// with the same columns in consecutive rows become one rectangle. More than `maxPatches`
/// rectangles become their bounding box. When the rectangles cover more than half the frame, a
/// full image is cheaper and goes instead. Not thread-safe: the capture queue owns it.
public final class TileDiffer {
    public enum Decision: Equatable, Sendable {
        /// No tile changed: send nothing.
        case unchanged
        case full
        case patches([PixelRect])
    }

    public static let tileSize = 64
    public let maxPatches: Int
    public let maxChangedFraction: Double

    private struct Hashes: Equatable {
        var width: Int
        var height: Int
        var tiles: [UInt64]
    }

    /// The last frame sent, and the one `diff` looked at until `commit()`.
    private var sent: Hashes?
    private var pending: Hashes?

    public init(maxPatches: Int = 8, maxChangedFraction: Double = 0.5) {
        self.maxPatches = maxPatches
        self.maxChangedFraction = maxChangedFraction
    }

    /// `pixels` holds `height` rows of `bytesPerRow` bytes, 4 bytes per pixel. `forceFull` asks for
    /// a full image whenever the frame changed (the first frame of a chunk, a screen change). After
    /// `reset()` or a size change the frame is a full image even when unchanged.
    public func diff(pixels: UnsafeRawBufferPointer, width: Int, height: Int, bytesPerRow: Int, forceFull: Bool) -> Decision {
        let hashes = Self.hash(pixels: pixels, width: width, height: height, bytesPerRow: bytesPerRow)
        pending = hashes
        guard let sent, sent.width == width, sent.height == height else { return .full }
        let ts = Self.tileSize
        let cols = (width + ts - 1) / ts
        let rows = (height + ts - 1) / ts
        var changed = [Bool](repeating: false, count: hashes.tiles.count)
        var any = false
        for i in changed.indices where hashes.tiles[i] != sent.tiles[i] {
            changed[i] = true
            any = true
        }
        if !any { return .unchanged }
        if forceFull { return .full }
        var rects = Self.merge(changed, cols: cols, rows: rows)
        if rects.count > maxPatches {
            rects = [Self.boundingBox(rects)]
        }
        // In tiles: clamp to the frame's pixels.
        let clamped = rects.map { r -> PixelRect in
            let x = r.x * ts, y = r.y * ts
            return PixelRect(x: x, y: y, w: min((r.x + r.w) * ts, width) - x, h: min((r.y + r.h) * ts, height) - y)
        }
        let area = clamped.reduce(0) { $0 + $1.area }
        if Double(area) > maxChangedFraction * Double(width * height) { return .full }
        return .patches(clamped)
    }

    /// The frame `diff` looked at last was sent: later frames are compared with it.
    public func commit() {
        if let pending { sent = pending }
        pending = nil
    }

    /// Forgets the last frame sent, so the next frame is a full image (resume, screen change).
    public func reset() {
        sent = nil
        pending = nil
    }

    /// 64-bit FNV-1a over 8-byte words of each tile's rows (4-byte words for an odd-width tail).
    private static func hash(pixels: UnsafeRawBufferPointer, width: Int, height: Int, bytesPerRow: Int) -> Hashes {
        let ts = tileSize
        let cols = (width + ts - 1) / ts
        let rows = (height + ts - 1) / ts
        var tiles = [UInt64](repeating: 0xcbf2_9ce4_8422_2325, count: cols * rows)
        let prime: UInt64 = 0x0000_0100_0000_01b3
        tiles.withUnsafeMutableBufferPointer { out in
            for y in 0..<height {
                let row = y * bytesPerRow
                let base = (y / ts) * cols
                for c in 0..<cols {
                    var h = out[base + c]
                    var at = row + c * ts * 4
                    let end = row + min((c + 1) * ts, width) * 4
                    while at + 8 <= end {
                        h = (h ^ pixels.loadUnaligned(fromByteOffset: at, as: UInt64.self)) &* prime
                        at += 8
                    }
                    if at < end {
                        h = (h ^ UInt64(pixels.loadUnaligned(fromByteOffset: at, as: UInt32.self))) &* prime
                    }
                    out[base + c] = h
                }
            }
        }
        return Hashes(width: width, height: height, tiles: tiles)
    }

    /// Changed tiles as non-overlapping rectangles, in tile units.
    static func merge(_ changed: [Bool], cols: Int, rows: Int) -> [PixelRect] {
        var done: [PixelRect] = []
        // Rectangles still growing, keyed by their column span in the previous row.
        var open: [PixelRect] = []
        for r in 0..<rows {
            var runs: [(Int, Int)] = []
            var c = 0
            while c < cols {
                guard changed[r * cols + c] else { c += 1; continue }
                let start = c
                while c < cols, changed[r * cols + c] { c += 1 }
                runs.append((start, c - start))
            }
            var next: [PixelRect] = []
            for (x, w) in runs {
                if let i = open.firstIndex(where: { $0.x == x && $0.w == w }) {
                    var rect = open.remove(at: i)
                    rect.h += 1
                    next.append(rect)
                } else {
                    next.append(PixelRect(x: x, y: r, w: w, h: 1))
                }
            }
            done += open
            open = next
        }
        return (done + open).sorted { ($0.y, $0.x) < ($1.y, $1.x) }
    }

    static func boundingBox(_ rects: [PixelRect]) -> PixelRect {
        let x0 = rects.map(\.x).min() ?? 0, y0 = rects.map(\.y).min() ?? 0
        let x1 = rects.map { $0.x + $0.w }.max() ?? 0, y1 = rects.map { $0.y + $0.h }.max() ?? 0
        return PixelRect(x: x0, y: y0, w: x1 - x0, h: y1 - y0)
    }
}
