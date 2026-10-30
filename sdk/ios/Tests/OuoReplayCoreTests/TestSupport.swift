import Foundation
import Testing
@testable import OuoReplayCore

/// Deterministic clock for the chunk builder.
final class FakeClock {
    var now: EpochMillis
    init(_ start: EpochMillis = 1_760_000_000_000) { now = start }
    func advance(ms: Int64) { now += ms }
}

func fixtureData(_ name: String) throws -> Data {
    guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures") else {
        throw NSError(domain: "fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "missing fixture \(name)"])
    }
    return try Data(contentsOf: url)
}

func jsonObject(_ data: Data) throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

/// Recursively collects "path.to.key" for every key in a JSON object, arrays contribute their first element.
func keyPaths(_ value: Any, prefix: String = "") -> Set<String> {
    var out = Set<String>()
    if let dict = value as? [String: Any] {
        for (k, v) in dict {
            let path = prefix.isEmpty ? k : "\(prefix).\(k)"
            out.insert(path)
            out.formUnion(keyPaths(v, prefix: path))
        }
    } else if let arr = value as? [Any], let first = arr.first {
        out.formUnion(keyPaths(first, prefix: prefix + "[]"))
    }
    return out
}

func makeFrame(ts: EpochMillis, reason: FrameReason = .timer, bytes: UInt8 = 0xff) -> Frame {
    Frame(ts: ts, jpegData: Data([0xff, 0xd8, bytes, 0xd9]), reason: reason)
}

/// Captures requests instead of sending them; answers with the scripted statuses in order.
final class FakeTransport: ChunkTransport {
    struct Sent { let request: URLRequest; let body: Data }
    private let lock = NSLock()
    private(set) var sent: [Sent] = []
    var responses: [Result<ChunkResponse, Error>] = []
    var onSend: (() -> Void)?

    func send(_ request: URLRequest, completion: @escaping (Result<ChunkResponse, Error>) -> Void) {
        lock.lock()
        sent.append(Sent(request: request, body: request.httpBody ?? Data()))
        let result = responses.isEmpty ? Result<ChunkResponse, Error>.success(202) : responses.removeFirst()
        lock.unlock()
        onSend?()
        DispatchQueue.global().async { completion(result) }
    }

    var count: Int { lock.lock(); defer { lock.unlock() }; return sent.count }
}

struct TransportError: Error {}
