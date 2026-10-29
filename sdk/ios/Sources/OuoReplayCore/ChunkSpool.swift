import Foundation

/// The open chunk on disk, so a crash, a watchdog kill or a force quit mid-chunk loses nothing:
/// the next launch sends what was captured (`recover()`), ending at its last frame or touch.
///
/// One append-only JSON Lines file: the chunk header first, then one line per frame and one per
/// batch of touches. A line cut short by the crash fails to decode and is skipped. Written on the
/// capture queue; the file is removed when the chunk is cut and handed to the uploader.
public final class ChunkSpool {
    struct Header: Codable {
        var sessionId: String
        var seq: Int
        var startedAt: Int64
        var viewport: Viewport
        var platform: String
        var masked: Bool
    }

    private struct Line: Codable {
        var header: Header?
        var frame: Frame?
        var touches: [Touch]?
        var viewport: Viewport?
    }

    public let url: URL
    private var handle: FileHandle?

    /// Default file: `Library/Application Support/ouo/replay/open-chunk.jsonl`.
    public static var defaultURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("ouo/replay/open-chunk.jsonl")
    }

    public init(url: URL = ChunkSpool.defaultURL) {
        self.url = url
    }

    /// Starts a new chunk file (replacing any previous one).
    func begin(_ header: Header) {
        close()
        let fm = FileManager.default
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard fm.createFile(atPath: url.path, contents: nil),
              let h = try? FileHandle(forWritingTo: url) else { return }
        handle = h
        write(Line(header: header))
    }

    func append(_ frame: Frame, viewport: Viewport) {
        write(Line(frame: frame, viewport: viewport))
    }

    func append(_ touches: [Touch]) {
        guard !touches.isEmpty else { return }
        write(Line(touches: touches))
    }

    /// The chunk was cut and handed over: the file is no longer needed.
    func clear() {
        close()
        try? FileManager.default.removeItem(at: url)
    }

    /// The chunk the previous process left open, if it holds anything, and removes the file.
    /// Call before the first frame of this process.
    public func recover() -> FrameChunk? {
        close()
        defer { try? FileManager.default.removeItem(at: url) }
        guard let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        var header: Header?
        var viewport: Viewport?
        var frames: [Frame] = []
        var touches: [Touch] = []
        for raw in data.split(separator: UInt8(ascii: "\n")) {
            guard let line = try? decoder.decode(Line.self, from: Data(raw)) else { continue }
            if let h = line.header { header = h }
            if let f = line.frame { frames.append(f) }
            if let v = line.viewport { viewport = v }
            touches += line.touches ?? []
        }
        guard let header, !(frames.isEmpty && touches.isEmpty) else { return nil }
        let last = max(frames.map(\.ts).max() ?? 0, touches.map(\.ts).max() ?? 0)
        return FrameChunk(
            sessionId: header.sessionId,
            seq: header.seq,
            startedAt: header.startedAt,
            endedAt: max(last, header.startedAt),
            viewport: viewport ?? header.viewport,
            platform: header.platform,
            frames: frames,
            touches: touches,
            masked: header.masked
        )
    }

    private func write(_ line: Line) {
        guard let handle, var data = try? JSONEncoder().encode(line) else { return }
        data.append(UInt8(ascii: "\n"))
        do {
            try handle.write(contentsOf: data)
        } catch {
            // Disk full or file gone: stop spooling this chunk, the in-memory one still goes out.
            close()
        }
    }

    private func close() {
        try? handle?.close()
        handle = nil
    }
}
