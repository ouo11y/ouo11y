import Foundation
#if canImport(CoreGraphics) && canImport(ImageIO)
import CoreGraphics
import ImageIO

/// The off-main half of a capture: paints the redaction rectangles over the raw snapshot, makes
/// the 16x16 dedupe thumbnail and encodes JPEG. CoreGraphics and ImageIO only (thread-safe, no
/// UIKit), so the UIKit target runs it on its capture queue and the tests run it on macOS.
public struct FrameComposer: Sendable {
    public var jpegQuality: Double

    public init(jpegQuality: Double) {
        self.jpegQuality = jpegQuality
    }

    /// 8-bit sRGB, native byte order: what the snapshot is rendered into and composed in.
    public static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    public static let bitmapInfo = CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue

    /// Bitmap context of `pixelWidth` x `pixelHeight`, origin bottom-left (CoreGraphics).
    public static func makeContext(pixelWidth: Int, pixelHeight: Int) -> CGContext? {
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

    /// The snapshot with every rectangle filled black. `rects` are in points with a top-left origin
    /// (window coordinates, as `RedactionPlanner` returns them); `scale` is pixels per point.
    public func redact(_ image: CGImage, rects: [CGRect], scale: CGFloat) -> CGImage? {
        if rects.isEmpty { return image }
        guard let ctx = Self.makeContext(pixelWidth: image.width, pixelHeight: image.height) else { return nil }
        let h = CGFloat(image.height)
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(image.width), height: h))
        // Window points (top-left origin) -> bitmap pixels (bottom-left origin).
        ctx.translateBy(x: 0, y: h)
        ctx.scaleBy(x: scale, y: -scale)
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.fill(rects)
        return ctx.makeImage()
    }

    /// 16x16 8-bit grayscale rendering: small, and insensitive to JPEG noise (the dedupe input).
    public static func thumbnail(of image: CGImage, side: Int = 16) -> Data? {
        guard let ctx = CGContext(
            data: nil,
            width: side,
            height: side,
            bitsPerComponent: 8,
            bytesPerRow: side,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        ctx.interpolationQuality = .low
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        guard let data = ctx.data else { return nil }
        return Data(bytes: data, count: side * side)
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
