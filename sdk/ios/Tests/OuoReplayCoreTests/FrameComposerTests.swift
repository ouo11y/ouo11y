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
    func snapshot(w: Int, h: Int, scale: Int, colorSpace: CGColorSpace = FrameComposer.sRGB) -> CGImage {
        let ctx = FrameComposer.makeContext(pixelWidth: w * scale, pixelHeight: h * scale, colorSpace: colorSpace)!
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

    @Test func DisplayP3SnapshotIsRedactedInItsOwnColorSpace() {
        // Wide-color screens render the snapshot in Display P3 (no conversion in drawHierarchy).
        let raw = snapshot(w: 50, h: 100, scale: 2, colorSpace: FrameComposer.displayP3)
        let masked = FrameComposer(jpegQuality: 0.5).redact(raw, rects: [CGRect(x: 10, y: 10, width: 20, height: 30)], scale: 2)!
        #expect(masked.colorSpace?.name == CGColorSpace.displayP3)
        #expect(isBlack(pixel(masked, 40, 50)))
        #expect(isWhite(pixel(masked, 40, 150)))
        let jpeg = FrameComposer(jpegQuality: 0.5).jpeg(masked)!
        let decoded = CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithData(jpeg as CFData, nil)!, 0, nil)!
        #expect(decoded.colorSpace?.name == CGColorSpace.displayP3, "the JPEG embeds the P3 profile, so viewers show the right colors")
        #expect(isBlack(pixel(decoded, 40, 50)))
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

    @Test func RenderScaleIsAnIntegerDivisorOfTheScreenScaleThatFits() {
        // iPhone 16 Pro Max (440 x 956 pt @3x), iPhone 18 Pro sim (402 x 874 @3x): 1.0.
        #expect(FrameComposer.renderScale(longestSidePoints: 956, screenScale: 3, maxLongestSide: 1000) == 1)
        #expect(FrameComposer.renderScale(longestSidePoints: 874, screenScale: 3, maxLongestSide: 1000) == 1)
        // A 2x phone (375 x 667 pt) also lands on 1.0; a 2x iPad (1366 pt) gets 2/3 (911 px).
        #expect(FrameComposer.renderScale(longestSidePoints: 667, screenScale: 2, maxLongestSide: 1000) == 1)
        #expect(FrameComposer.renderScale(longestSidePoints: 1366, screenScale: 2, maxLongestSide: 1000) == 2.0 / 3.0)
        // Fits at the native scale: unchanged.
        #expect(FrameComposer.renderScale(longestSidePoints: 300, screenScale: 3, maxLongestSide: 1000) == 3)
        // A larger cap lets 3x screens keep 1.5x.
        #expect(FrameComposer.renderScale(longestSidePoints: 874, screenScale: 3, maxLongestSide: 1400) == 1.5)
        for longest in stride(from: 300.0, through: 1400, by: 37) {
            for screen in [1.0, 2.0, 3.0] {
                let s = FrameComposer.renderScale(longestSidePoints: longest, screenScale: screen, maxLongestSide: 1000)
                #expect(longest * s <= 1000 + 1e-9, "spec: longest side at most 1000 px")
                #expect((screen / s).rounded() == screen / s || s == screen, "integer downscale")
            }
        }
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

    /// A 402 x 300 px screen (the last tile column is 18 px wide), gray with a red square at
    /// (`squareX`, `squareY`) in pixels, top-left origin.
    func screen(squareX: Int = 10, squareY: Int = 10, side: Int = 20) -> CGImage {
        let ctx = FrameComposer.makeContext(pixelWidth: 402, pixelHeight: 300)!
        ctx.setFillColor(CGColor(red: 0.9, green: 0.9, blue: 0.9, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 402, height: 300))
        ctx.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(x: squareX, y: 300 - squareY - side, width: side, height: side))
        return ctx.makeImage()!
    }

    func decode(_ jpeg: Data) -> CGImage {
        CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithData(jpeg as CFData, nil)!, 0, nil)!
    }

    /// ADR-0014 end to end on the composer: full, unchanged (zero bytes), patches of the changed
    /// tiles with their own JPEG cropped from the right pixels, full when forced.
    @Test func EncodesFullUnchangedAndPatches() throws {
        let composer = FrameComposer(jpegQuality: 0.5)
        let differ = TileDiffer()
        guard case .full(let first) = composer.encode(screen(), differ: differ, forceFull: false) else {
            Issue.record("the first frame is a full image"); return
        }
        #expect(decode(first).width == 402 && decode(first).height == 300)
        guard case .unchanged = composer.encode(screen(), differ: differ, forceFull: true) else {
            Issue.record("a static screen sends nothing, even at a chunk start"); return
        }
        // The square moves from tile (0, 0) to the 18 px wide last column, row 2.
        guard case .patches(let patches) = composer.encode(screen(squareX: 390, squareY: 140, side: 10), differ: differ, forceFull: false) else {
            Issue.record("a small change is sent as patches"); return
        }
        #expect(patches.map(\.0) == [PixelRect(x: 0, y: 0, w: 64, h: 64), PixelRect(x: 384, y: 128, w: 18, h: 64)])
        let tile = decode(patches[1].1)
        #expect(tile.width == 18 && tile.height == 64)
        // The square sits at (6, 12) inside that tile: red; the rest is the gray background.
        let red = pixel(tile, 10, 16)
        #expect(red.0 > 200 && red.1 < 60 && red.2 < 60)
        #expect(pixel(decode(patches[0].1), 20, 20).1 > 200, "the old square is gone from tile (0, 0)")
        guard case .full = composer.encode(screen(squareX: 100, squareY: 100), differ: differ, forceFull: true) else {
            Issue.record("forceFull sends a changed frame as a full image"); return
        }
    }
}
