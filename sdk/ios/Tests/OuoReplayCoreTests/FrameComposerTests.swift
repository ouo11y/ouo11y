import CoreGraphics
import Foundation
import ImageIO
import Testing
@testable import OuoReplayCore

/// The redaction composite moved off the main thread (N6): these pin that the rectangles land on
/// the right pixels, in UIKit's top-left point coordinates at the render scale.
@Suite struct FrameComposerTests {
    /// A `w` x `h` point frame at `scale`, white, with the top half of the left column red so a
    /// vertical flip would show.
    func snapshot(w: Int, h: Int, scale: Int) -> CGImage {
        let ctx = FrameComposer.makeContext(pixelWidth: w * scale, pixelHeight: h * scale)!
        // Same transform the UIKit target applies before drawHierarchy: points, top-left origin.
        ctx.translateBy(x: 0, y: CGFloat(h * scale))
        ctx.scaleBy(x: CGFloat(scale), y: -CGFloat(scale))
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 5, height: h / 2))
        return ctx.makeImage()!
    }

    /// RGB of the pixel at (x, y) with a top-left origin.
    func pixel(_ image: CGImage, _ x: Int, _ y: Int) -> (UInt8, UInt8, UInt8) {
        let w = image.width, h = image.height
        var buf = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        // CGBitmapContext memory is top row first.
        let i = (y * w + x) * 4
        return (buf[i], buf[i + 1], buf[i + 2])
    }

    func isBlack(_ p: (UInt8, UInt8, UInt8)) -> Bool { p.0 < 16 && p.1 < 16 && p.2 < 16 }
    func isWhite(_ p: (UInt8, UInt8, UInt8)) -> Bool { p.0 > 239 && p.1 > 239 && p.2 > 239 }

    @Test func RectanglesLandOnTheirPixelsAtTheRenderScale() {
        let raw = snapshot(w: 50, h: 100, scale: 2)
        let composer = FrameComposer(jpegQuality: 0.5)
        let masked = composer.redact(raw, rects: [CGRect(x: 10, y: 10, width: 20, height: 30)], scale: 2)!
        #expect(masked.width == 100 && masked.height == 200)
        // Inside: points (10..30, 10..40) -> pixels (20..60, 20..80), top-left origin.
        #expect(isBlack(pixel(masked, 21, 21)))
        #expect(isBlack(pixel(masked, 59, 79)))
        #expect(isBlack(pixel(masked, 40, 50)))
        // Just outside each edge.
        #expect(isWhite(pixel(masked, 18, 50)))
        #expect(isWhite(pixel(masked, 62, 50)))
        #expect(isWhite(pixel(masked, 40, 18)))
        #expect(isWhite(pixel(masked, 40, 82)), "a vertical flip would black out y 120..180 instead")
        #expect(isBlack(pixel(masked, 40, 150)) == false)
        // The source content is kept upright: red top-left column.
        let red = pixel(masked, 2, 10)
        #expect(red.0 > 200 && red.1 < 50)
        #expect(isWhite(pixel(masked, 2, 190)))
    }

    @Test func FractionalScaleCoversTheRectangle() {
        // 402x874 pt at 1.144 px/pt: the scale `maxLongestSide: 1000` gives on an iPhone 18 Pro.
        let scale = 1000.0 / 874.0
        let ctx = FrameComposer.makeContext(pixelWidth: Int((402 * scale).rounded(.up)), pixelHeight: 1000)!
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: ctx.width, height: ctx.height))
        let raw = ctx.makeImage()!
        let rect = CGRect(x: 100, y: 700, width: 200, height: 40)
        let masked = FrameComposer(jpegQuality: 0.5).redact(raw, rects: [rect], scale: CGFloat(scale))!
        for (x, y) in [(rect.minX + 1, rect.minY + 1), (rect.maxX - 1, rect.maxY - 1), (rect.midX, rect.midY)] {
            #expect(isBlack(pixel(masked, Int(x * scale), Int(y * scale))))
        }
        #expect(isWhite(pixel(masked, Int(rect.midX * scale), Int((rect.minY - 3) * scale))))
    }

    @Test func NoRectanglesReturnsTheSnapshotUnchanged() {
        let raw = snapshot(w: 10, h: 10, scale: 1)
        #expect(FrameComposer(jpegQuality: 0.5).redact(raw, rects: [], scale: 1) === raw)
    }

    @Test func JPEGRoundTripKeepsTheMask() {
        let raw = snapshot(w: 50, h: 100, scale: 2)
        let composer = FrameComposer(jpegQuality: 0.5)
        let masked = composer.redact(raw, rects: [CGRect(x: 10, y: 10, width: 20, height: 30)], scale: 2)!
        let jpeg = composer.jpeg(masked)!
        #expect(jpeg.starts(with: [0xFF, 0xD8]), "JPEG SOI marker")
        let src = CGImageSourceCreateWithData(jpeg as CFData, nil)!
        let decoded = CGImageSourceCreateImageAtIndex(src, 0, nil)!
        #expect(decoded.width == 100 && decoded.height == 200)
        #expect(isBlack(pixel(decoded, 40, 50)))
        #expect(isWhite(pixel(decoded, 40, 150)))
    }

    @Test func ThumbnailIsStableAndSeesTheMask() {
        let raw = snapshot(w: 50, h: 100, scale: 2)
        let a = FrameComposer.thumbnail(of: raw)!
        #expect(a.count == 256)
        #expect(FrameComposer.thumbnail(of: snapshot(w: 50, h: 100, scale: 2)) == a, "same content, same bytes: dedupe works")
        let masked = FrameComposer(jpegQuality: 0.5).redact(raw, rects: [CGRect(x: 0, y: 50, width: 50, height: 50)], scale: 2)!
        #expect(FrameComposer.thumbnail(of: masked) != a)
    }
}
