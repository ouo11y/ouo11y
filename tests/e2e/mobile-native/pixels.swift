// The pixel check of C8.2: composites a frames replay (rum-api's /replay/frames) up to a time, as the
// player does (a full image, then patches), and prints the mean brightness (0 black to 1 white) of
// each rectangle, given in window points. run.sh compiles it once.
// Usage: pixels <frames.json> <until epoch ms> <x,y,w,h> [<x,y,w,h> ...]
import CoreGraphics
import Foundation
import ImageIO

let a = CommandLine.arguments
let d = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: a[1]))) as! [String: Any]
let until = Int64(a[2])!
let viewport = d["viewport"] as! [String: Any]
let frames = (d["frames"] as! [[String: Any]]).filter { (Int64("\($0["ts"]!)") ?? 0) <= until }
func image(_ b64: String) -> CGImage {
    CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithData(Data(base64Encoded: b64)! as CFData, nil)!, 0, nil)!
}
guard let first = frames.firstIndex(where: { $0["jpeg"] != nil }) else { print("[]"); exit(0) }
let base = image(frames[first]["jpeg"] as! String)
let W = base.width, H = base.height
let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
for f in frames[first...] {
    if let j = f["jpeg"] as? String { ctx.draw(image(j), in: CGRect(x: 0, y: 0, width: W, height: H)); continue }
    for p in f["patches"] as? [[String: Any]] ?? [] {
        let x = p["x"] as! Int, y = p["y"] as! Int, w = p["w"] as! Int, h = p["h"] as! Int
        ctx.draw(image(p["jpeg"] as! String), in: CGRect(x: x, y: H - y - h, width: w, height: h))
    }
}
let px = ctx.data!.assumingMemoryBound(to: UInt8.self)
let scale = Double(W) / (viewport["width"] as! Double)
var out: [Double] = []
for r in a[3...] {
    let v = r.split(separator: ",").map { Double($0)! * scale }
    // 2 px inside the edges: JPEG blurs the border of a filled rectangle.
    let x0 = max(0, Int(v[0]) + 2), y0 = max(0, Int(v[1]) + 2), x1 = min(W, Int(v[0] + v[2]) - 2), y1 = min(H, Int(v[1] + v[3]) - 2)
    var sum = 0.0, n = 0.0
    if x1 > x0 && y1 > y0 {
        for y in y0..<y1 { for x in x0..<x1 {
            let i = (y * W + x) * 4
            sum += (Double(px[i]) + Double(px[i + 1]) + Double(px[i + 2])) / (3 * 255)
            n += 1
        } }
    }
    out.append(n > 0 ? sum / n : -1)
}
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
