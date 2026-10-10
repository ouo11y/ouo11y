import Foundation
import zlib

/// Minimal gzip (RFC 1952) encoder and decoder on top of the system zlib. `deflateInit2` with
/// `windowBits = 15 + 16` makes zlib write the gzip header and CRC32/ISIZE trailer itself, so the
/// output is exactly what `gunzip` and Go's `compress/gzip` accept. (`NSData.compressed(using:
/// .zlib)` yields a raw deflate stream without header or trailer, which `gunzip` rejects.)
public enum Gzip {
    public enum Error: Swift.Error, Equatable {
        case deflate(Int32)
        case inflate(Int32)
    }

    public static func compress(_ input: Data, level: Int32 = Z_DEFAULT_COMPRESSION) throws -> Data {
        var stream = z_stream()
        var status = deflateInit2_(&stream, level, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
        guard status == Z_OK else { throw Error.deflate(status) }
        defer { deflateEnd(&stream) }

        var output = Data()
        let chunkSize = 64 * 1024
        var buffer = [UInt8](repeating: 0, count: chunkSize)
        var source = [UInt8](input)
        let total = source.count

        try source.withUnsafeMutableBufferPointer { src in
            stream.next_in = src.baseAddress
            stream.avail_in = UInt32(total)
            repeat {
                try buffer.withUnsafeMutableBufferPointer { dst in
                    stream.next_out = dst.baseAddress
                    stream.avail_out = UInt32(chunkSize)
                    status = deflate(&stream, Z_FINISH)
                    guard status == Z_OK || status == Z_STREAM_END || status == Z_BUF_ERROR else {
                        throw Error.deflate(status)
                    }
                    let produced = chunkSize - Int(stream.avail_out)
                    output.append(dst.baseAddress!, count: produced)
                }
            } while status != Z_STREAM_END
        }
        return output
    }

    /// Decodes gzip (or zlib-wrapped) data; used by tests and by hosts that want to inspect chunks.
    public static func decompress(_ input: Data) throws -> Data {
        var stream = z_stream()
        var status = inflateInit2_(&stream, 15 + 32, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
        guard status == Z_OK else { throw Error.inflate(status) }
        defer { inflateEnd(&stream) }

        var output = Data()
        let chunkSize = 64 * 1024
        var buffer = [UInt8](repeating: 0, count: chunkSize)
        var source = [UInt8](input)
        let total = source.count

        try source.withUnsafeMutableBufferPointer { src in
            stream.next_in = src.baseAddress
            stream.avail_in = UInt32(total)
            repeat {
                try buffer.withUnsafeMutableBufferPointer { dst in
                    stream.next_out = dst.baseAddress
                    stream.avail_out = UInt32(chunkSize)
                    status = inflate(&stream, Z_NO_FLUSH)
                    guard status == Z_OK || status == Z_STREAM_END || status == Z_BUF_ERROR else {
                        throw Error.inflate(status)
                    }
                    let produced = chunkSize - Int(stream.avail_out)
                    output.append(dst.baseAddress!, count: produced)
                }
            } while status != Z_STREAM_END && stream.avail_in > 0 || (status == Z_OK && stream.avail_out == 0)
        }
        return output
    }
}
