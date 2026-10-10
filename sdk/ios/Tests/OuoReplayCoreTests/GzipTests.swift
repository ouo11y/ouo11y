import Foundation
import Testing
@testable import OuoReplayCore

@Suite struct GzipTests {
    @Test func RoundTripAndMagicBytes() throws {
        let text = String(repeating: "ouo replay frame chunk ", count: 500)
        let input = Data(text.utf8)
        let gz = try Gzip.compress(input)
        #expect(gz[0] == 0x1f)
        #expect(gz[1] == 0x8b)
        #expect(gz[2] == 0x08, "deflate method")
        #expect(gz.count < input.count / 10)
        // ISIZE trailer (little endian) is the uncompressed length mod 2^32.
        let isize = gz.suffix(4).reversed().reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        #expect(isize == UInt32(input.count))
        #expect(try Gzip.decompress(gz) == input)
    }

    @Test func EmptyInput() throws {
        let gz = try Gzip.compress(Data())
        #expect(try Gzip.decompress(gz) == Data())
    }

    @Test func LargeInputSpansOutputBuffers() throws {
        var bytes = [UInt8](repeating: 0, count: 600_000)
        for i in 0..<bytes.count { bytes[i] = UInt8(truncatingIfNeeded: i &* 31 ^ (i >> 7)) }
        let input = Data(bytes)
        let gz = try Gzip.compress(input, level: 1)
        #expect(try Gzip.decompress(gz) == input)
    }

    @Test func DecompressRejectsGarbage() {
        #expect(throws: (any Error).self) { try Gzip.decompress(Data([0x00, 0x01, 0x02, 0x03])) }
    }

    #if os(macOS)
    /// The real proof: the system `gunzip` accepts what we produce.
    @Test func GunzipAcceptsOutput() throws {
        let chunk = try FrameChunk.decode(try fixtureData("chunk"))
        let json = try chunk.encodedJSON()
        let gz = try Gzip.compress(json)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ouo-gzip-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("chunk.json.gz")
        try gz.write(to: file)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/gunzip")
        process.arguments = ["-c", file.path]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        try process.run()
        let out = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0, "gunzip must exit 0")
        #expect(out == json)
        #expect(try FrameChunk.decode(out) == chunk)
    }
    #endif
}
