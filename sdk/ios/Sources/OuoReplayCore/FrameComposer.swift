import Foundation
#if canImport(CoreGraphics) && canImport(ImageIO)
import CoreGraphics
import ImageIO

/// The off-main half of a capture: paints the redaction rectangles over the raw snapshot, compares
/// its tiles with the last frame sent and encodes a full JPEG or one JPEG per changed rectangle.
/// CoreGraphics and ImageIO only (thread-safe, no UIKit), so the UIKit target runs it on its
/// capture queue and the tests run it on macOS.
public struct FrameComposer: Sendable {
    public var jpegQuality: Double

    public init(jpegQuality: Double) {
        self.jpegQuality = jpegQuality
    }

    public static let sRGB = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    /// Wide-color screens (every iPhone since the 7) composite in Display P3. Rendering the snapshot
    /// into the screen's own color space skips a per-pixel color conversion inside drawHierarchy
    /// (`vTransformTRCParametric`, most of its time on an sRGB target). The JPEG carries the profile.
    public static let displayP3 = CGColorSpace(name: CGColorSpace.displayP3) ?? sRGB
    /// 8 bits per channel, premultiplied BGRA in native byte order: Core Animation's own layout, so
    /// no premultiply/unpremultiply or channel swizzle either.
    public static let bitmapInfo = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue

    /// Bitmap context of `pixelWidth` x `pixelHeight`, origin bottom-left (CoreGraphics).
    public static func makeContext(pixelWidth: Int, pixelHeight: Int, colorSpace: CGColorSpace = sRGB) -> CGContext? {
        CGContext(
            data: nil,
            width: pixelWidth,
            height: pixelHeight,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        )
    }

    /// Pixels per point for a frame: the largest `screenScale / n` (n = 1, 2, 3, ...) that keeps the
    /// longest side within `maxLongestSide` pixels. An integer downscale from the screen's own
    /// resolution is much cheaper inside drawHierarchy than an arbitrary one (3 -> 1 instead of
    /// 3 -> 1.14 halved the main-thread render on the iOS 27 simulator), and stays sharp. An iPhone
    /// at 3x with a 402 x 874 pt screen and the default 1000 px gets 1.0: 402 x 874 px frames.
    public static func renderScale(longestSidePoints: Double, screenScale: Double, maxLongestSide: Double) -> Double {
        guard longestSidePoints > 0, screenScale > 0, maxLongestSide > 0 else { return 1 }
        let fit = maxLongestSide / longestSidePoints
        if screenScale <= fit { return screenScale }
        let n = (screenScale / fit).rounded(.up)
        return screenScale / n
    }

    /// `image` resized to `pixelWidth` x `pixelHeight` (the capture queue's half of a capture: the
    /// main thread renders 1:1 at the screen scale, as Sentry does, and the resample happens here).
    public static func downscale(_ image: CGImage, pixelWidth: Int, pixelHeight: Int) -> CGImage? {
        if image.width == pixelWidth, image.height == pixelHeight { return image }
        guard let ctx = makeContext(pixelWidth: pixelWidth, pixelHeight: pixelHeight, colorSpace: image.colorSpace ?? sRGB) else { return nil }
        ctx.interpolationQuality = .low
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: pixelWidth, height: pixelHeight))
        return ctx.makeImage()
    }

    /// The snapshot with every rectangle filled black. `rects` are in points with a top-left origin
    /// (window coordinates, as `RedactionPlanner` returns them); `scale` is pixels per point.
    public func redact(_ image: CGImage, rects: [CGRect], scale: CGFloat) -> CGImage? {
        if rects.isEmpty { return image }
        // Same color space as the snapshot, so drawing it is a copy, not a conversion.
        guard let ctx = Self.makeContext(pixelWidth: image.width, pixelHeight: image.height, colorSpace: image.colorSpace ?? Self.sRGB) else { return nil }
        let h = CGFloat(image.height)
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(image.width), height: h))
        // Window points (top-left origin) -> bitmap pixels (bottom-left origin).
        ctx.translateBy(x: 0, y: h)
        ctx.scaleBy(x: scale, y: -scale)
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.fill(rects)
        return ctx.makeImage()
    }

    /// What a redacted frame becomes on the wire (ADR-0014).
    public enum Encoded {
        /// Same tiles as the last frame sent.
        case unchanged
        case full(Data)
        case patches([(PixelRect, Data)])
    }

    /// Diffs `image` against the last frame sent and encodes what changed. `forceFull` asks for a
    /// full image if anything changed (the first frame of a chunk). Commits the frame to `differ`
    /// only once every JPEG encoded, so the next frame is never diffed against one not sent; nil
    /// when encoding failed.
    public func encode(_ image: CGImage, differ: TileDiffer, forceFull: Bool) -> Encoded? {
        guard let decision = Self.withPixels(of: image, { pixels, bytesPerRow in
            differ.diff(pixels: pixels, width: image.width, height: image.height, bytesPerRow: bytesPerRow, forceFull: forceFull)
        }) else { return nil }
        let out: Encoded
        switch decision {
        case .unchanged:
            return .unchanged
        case .full:
            guard let data = jpeg(image) else { return nil }
            out = .full(data)
        case .patches(let rects):
            var patches: [(PixelRect, Data)] = []
            for r in rects {
                // CGImage crops in pixels with a top-left origin, as patches are.
                guard let tile = image.cropping(to: CGRect(x: r.x, y: r.y, width: r.w, height: r.h)),
                      let data = jpeg(tile) else { return nil }
                patches.append((r, data))
            }
            out = .patches(patches)
        }
        differ.commit()
        return out
    }

    /// Runs `body` over the image's pixels, 4 bytes each, drawing it into an 8-bit BGRA bitmap first
    /// when it has another layout.
    static func withPixels<T>(of image: CGImage, _ body: (UnsafeRawBufferPointer, Int) -> T) -> T? {
        if image.bitsPerPixel == 32, image.bitsPerComponent == 8, let data = image.dataProvider?.data,
           CFDataGetLength(data) >= image.bytesPerRow * image.height, let base = CFDataGetBytePtr(data) {
            return body(UnsafeRawBufferPointer(start: base, count: CFDataGetLength(data)), image.bytesPerRow)
        }
        // sRGB, not the image's own space: a gray or extended-range space has no 8-bit BGRA context.
        guard let ctx = makeContext(pixelWidth: image.width, pixelHeight: image.height),
              let base = ctx.data else { return nil }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return body(UnsafeRawBufferPointer(start: base, count: ctx.bytesPerRow * image.height), ctx.bytesPerRow)
    }

    /// JPEG bytes through ImageIO (thread-safe, unlike `UIImage.jpegData` on older iOS).
    public func jpeg(_ image: CGImage) -> Data? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else { return nil }
        let props = [kCGImageDestinationLossyCompressionQuality: jpegQuality] as CFDictionary
        CGImageDestinationAddImage(dest, image, props)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }
}
#endif
