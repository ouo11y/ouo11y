// Rebuilds every frame a recorder sent and reads it with Vision text recognition (macOS).
//   swift frames.swift <run dir>        (reads <run dir>/chunks/*.json, writes <run dir>/frames/)
// frames chunks: full JPEGs with patches drawn over the frame before them (ADR-0014), as the
// player does. video chunks: every frame of the mp4 at i / frame_rate. Each frame is written as
// PNG and its recognised text, with confidence, goes to <run dir>/ocr.json: readable text in a
// replay that masks all text is a masking miss (confirmed by looking at the frame).
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

let dir = URL(fileURLWithPath: CommandLine.arguments[1])
let out = dir.appendingPathComponent("frames", isDirectory: true)
try? FileManager.default.removeItem(at: out)
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func image(_ data: Data) -> CGImage? {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

func writePNG(_ img: CGImage, _ url: URL) {
    guard let d = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(d, img, nil)
    CGImageDestinationFinalize(d)
}

func text(_ img: CGImage) -> [[String: Any]] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    try? VNImageRequestHandler(cgImage: img).perform([req])
    return (req.results ?? []).compactMap { o in
        guard let c = o.topCandidates(1).first else { return nil }
        let b = o.boundingBox
        return ["text": c.string, "confidence": Double(c.confidence), "box": [b.minX, b.minY, b.width, b.height]]
    }
}

var report: [[String: Any]] = []
func emit(_ img: CGImage, chunk: String, index: Int, ts: Int64) {
    let name = "\(chunk)-\(String(format: "%03d", index)).png"
    writePNG(img, out.appendingPathComponent(name))
    report.append(["file": name, "ts": ts, "width": img.width, "height": img.height, "text": text(img)])
}

let files = try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("chunks").path).filter { $0.hasSuffix(".json") }.sorted()
for f in files {
    let data = try Data(contentsOf: dir.appendingPathComponent("chunks").appendingPathComponent(f))
    guard let c = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
    let base = String(f.dropLast(5))
    if c["kind"] as? String == "video", let v = c["video"] as? [String: Any], let b64 = v["mp4"] as? String, let mp4 = Data(base64Encoded: b64) {
        let tmp = out.appendingPathComponent("\(base).mp4")
        try mp4.write(to: tmp)
        let asset = AVURLAsset(url: tmp)
        let gen = AVAssetImageGenerator(asset: asset)
        gen.requestedTimeToleranceBefore = .zero
        gen.requestedTimeToleranceAfter = .zero
        let rate = max(1, v["frame_rate"] as? Int ?? 1)
        let count = v["frame_count"] as? Int ?? 0
        let start = (c["started_at"] as? NSNumber)?.int64Value ?? 0
        for i in 0..<count {
            let t = CMTime(value: CMTimeValue(i), timescale: CMTimeScale(rate))
            if let img = try? gen.copyCGImage(at: t, actualTime: nil) {
                emit(img, chunk: base, index: i, ts: start + Int64(i * 1000 / rate))
            }
        }
    } else if let frames = c["frames"] as? [[String: Any]] {
        var canvas: CGContext?
        for (i, fr) in frames.enumerated() {
            let ts = (fr["ts"] as? NSNumber)?.int64Value ?? 0
            if let j = fr["jpeg"] as? String, let d = Data(base64Encoded: j), let img = image(d) {
                canvas = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0,
                                   space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
                canvas?.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
            } else if let patches = fr["patches"] as? [[String: Any]], let ctx = canvas {
                for p in patches {
                    guard let d = Data(base64Encoded: p["jpeg"] as? String ?? ""), let img = image(d),
                          let x = p["x"] as? Int, let y = p["y"] as? Int, let w = p["w"] as? Int, let h = p["h"] as? Int else { continue }
                    // CoreGraphics' origin is bottom-left; patch y counts from the top.
                    ctx.draw(img, in: CGRect(x: x, y: ctx.height - y - h, width: w, height: h))
                }
            }
            if let img = canvas?.makeImage() { emit(img, chunk: base, index: i, ts: ts) }
        }
    }
}
// sheet.jpg: every frame at a third of its size, 10 per row, in order, for review by eye.
let thumbs = report.compactMap { r -> CGImage? in
    guard let f = r["file"] as? String, let d = try? Data(contentsOf: out.appendingPathComponent(f)) else { return nil }
    return image(d)
}
if let first = thumbs.first {
    let tw = first.width / 3, th = first.height / 3, cols = 10, gap = 4
    let rows = (thumbs.count + cols - 1) / cols
    let W = cols * (tw + gap) + gap, H = rows * (th + gap) + gap
    if let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
        ctx.setFillColor(CGColor(gray: 0.55, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        ctx.interpolationQuality = .high
        for (i, t) in thumbs.enumerated() {
            let x = gap + (i % cols) * (tw + gap), y = H - (gap + (i / cols + 1) * (th + gap)) + gap
            ctx.draw(t, in: CGRect(x: x, y: y, width: tw, height: th))
        }
        if let img = ctx.makeImage(), let d = CGImageDestinationCreateWithURL(dir.appendingPathComponent("sheet.jpg") as CFURL, UTType.jpeg.identifier as CFString, 1, nil) {
            CGImageDestinationAddImage(d, img, [kCGImageDestinationLossyCompressionQuality: 0.6] as CFDictionary)
            CGImageDestinationFinalize(d)
        }
    }
}
let json = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
try json.write(to: dir.appendingPathComponent("ocr.json"))
print("\(report.count) frames, \(report.filter { !(($0["text"] as? [Any]) ?? []).isEmpty }.count) with recognised text")
