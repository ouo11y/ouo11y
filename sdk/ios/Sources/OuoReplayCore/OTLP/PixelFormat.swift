import Foundation
#if canImport(CoreGraphics) && canImport(ImageIO)
import CoreGraphics
import ImageIO

/// One look of the pixel format: the raw (unredacted) snapshot, the rectangles the redaction plan
/// wants painted (window points) and the size the frame is encoded at. The raw image never leaves
/// the adapter.
public struct PixelLook: ReplayLook {
    public var image: CGImage
    public var rects: [CGRect]
    /// The window in points.
    public var width: Double
    public var height: Double
    /// Pixels per point of the encoded frame.
    public var scale: Double
    public var reason: FrameReason

    public init(image: CGImage, rects: [CGRect], width: Double, height: Double, scale: Double, reason: FrameReason) {
        self.image = image
        self.rects = rects
        self.width = width
        self.height = height
        self.scale = scale
        self.reason = reason
    }
}

/// The pixel format, `ouo-frames/3`: what the recorder captured before (masked JPEG full frames
/// and tile patches, ADR-0014) as newline-delimited JSON events instead of one JSON document:
///
/// - `{"t":ms,"type":"frame","w":px,"h":px,"scale":n,"reason":"timer|touch|navigation|resume|feedback","jpeg":"<base64>"}`:
///   a full image, a keyframe. `w` and `h` are the image's pixels, `scale` its pixels per point.
/// - `{"t":ms,"type":"patch","reason":"..","patches":[{"x":px,"y":px,"w":px,"h":px,"jpeg":"<base64>"}]}`:
///   rectangles drawn over the frame before it.
/// - the shared `touch` event.
///
/// Masking: the rectangles are painted black on the downscaled bitmap before anything is encoded;
/// when that fails the frame is dropped (PRV-8).
public final class PixelFormatAdapter: ReplayFormatAdapter {
    public static let format = "ouo-frames/3"

    public let formatId = PixelFormatAdapter.format
    public let masked: Bool
    private let composer: FrameComposer
    private let differ = TileDiffer()

    public init(jpegQuality: Double = 0.5, masked: Bool = true) {
        composer = FrameComposer(jpegQuality: jpegQuality)
        self.masked = masked
    }

    /// The differ forgets the last frame sent, so the next one is a full image even when unchanged.
    public func requestKeyframe() {
        differ.reset()
    }

    public func events(for look: ReplayLook, at t: EpochMillis) throws -> [ReplayEvent] {
        guard let look = look as? PixelLook else { throw ReplayFormatError.wrongLook }
        guard look.width > 0, look.height > 0, look.scale.isFinite, look.scale > 0,
              look.width * look.scale < 32_768, look.height * look.scale < 32_768 else {
            throw ReplayFormatError.encodingFailed
        }
        let pw = Int((look.width * look.scale).rounded(.up))
        let ph = Int((look.height * look.scale).rounded(.up))
        guard let small = FrameComposer.downscale(look.image, pixelWidth: pw, pixelHeight: ph) else {
            throw ReplayFormatError.encodingFailed
        }
        guard let redacted = composer.redact(small, rects: look.rects, scale: CGFloat(look.scale)) else {
            throw ReplayFormatError.maskingFailed
        }
        guard let encoded = composer.encode(redacted, differ: differ, forceFull: false) else {
            throw ReplayFormatError.encodingFailed
        }
        switch encoded {
        case .unchanged:
            return []
        case .full(let jpeg):
            let json = "{\"t\":\(t),\"type\":\"frame\",\"w\":\(pw),\"h\":\(ph),\"scale\":\(ReplayJSON.number(look.scale)),\"reason\":\"\(look.reason.rawValue)\",\"jpeg\":\"\(jpeg.base64EncodedString())\"}"
            return [ReplayEvent(t: t, keyframe: true, json: Data(json.utf8))]
        case .patches(let patches):
            let items = patches.map { rect, jpeg in
                "{\"x\":\(rect.x),\"y\":\(rect.y),\"w\":\(rect.w),\"h\":\(rect.h),\"jpeg\":\"\(jpeg.base64EncodedString())\"}"
            }
            let json = "{\"t\":\(t),\"type\":\"patch\",\"reason\":\"\(look.reason.rawValue)\",\"patches\":[\(items.joined(separator: ","))]}"
            return [ReplayEvent(t: t, keyframe: false, json: Data(json.utf8))]
        }
    }
}
#endif
