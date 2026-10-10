#if canImport(UIKit)
import UIKit
import OuoReplayCore

/// Snapshots the key window, paints the redaction rectangles, downsamples for dedupe and encodes
/// JPEG. Main thread only (`drawHierarchy` requires it).
final class ScreenCapturer {
    struct Capture {
        let jpeg: Data
        let viewport: Viewport
        /// 16x16 grayscale bytes, the dedupe input.
        let thumbnail: Data
        let redactedRects: Int
    }

    private let planner: RedactionPlanner
    /// Last diagnostic set, so the debug log reports changes only (main thread).
    nonisolated(unsafe) private static var lastUnmatched: [String] = []
    private let jpegQuality: CGFloat
    private let maxLongestSide: CGFloat
    private let logger: ReplayLogger

    init(rules: RedactionRules, jpegQuality: Double, maxLongestSide: Double, logger: ReplayLogger) {
        self.planner = RedactionPlanner(rules: rules, mergeOverlapping: true)
        self.jpegQuality = CGFloat(jpegQuality)
        self.maxLongestSide = CGFloat(maxLongestSide)
        self.logger = logger
    }

    static func keyWindow() -> UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        for scene in scenes where scene.activationState == .foregroundActive {
            if let key = scene.windows.first(where: { $0.isKeyWindow }) { return key }
        }
        for scene in scenes {
            if let key = scene.windows.first(where: { $0.isKeyWindow }) { return key }
        }
        return scenes.first?.windows.first
    }

    /// Pixels per point for the frame: the screen scale, lowered until the longest side fits.
    func renderScale(for bounds: CGRect, screenScale: CGFloat) -> CGFloat {
        let longest = max(bounds.width, bounds.height)
        guard longest > 0 else { return 1 }
        return min(screenScale, maxLongestSide / longest)
    }

    func capture(window: UIWindow) -> Capture? {
        let bounds = window.bounds
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        let tree = ViewTreeBuilder.node(for: window)
        let rects = planner.rects(for: tree, window: bounds)
        if logger.enabled {
            let unmatched = planner.unmatchedContentClasses(in: tree)
            if !unmatched.isEmpty, unmatched != Self.lastUnmatched {
                Self.lastUnmatched = unmatched
                logger.log("redaction: unmatched content-like classes \(unmatched)")
            }
        }
        let scale = renderScale(for: bounds, screenScale: window.screen.scale)

        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(bounds: bounds, format: format)
        let image = renderer.image { ctx in
            // `afterScreenUpdates: false` reads the last committed frame without forcing a layout pass.
            let drawn = window.drawHierarchy(in: bounds, afterScreenUpdates: false)
            if !drawn {
                // Fallback for windows that refuse drawHierarchy (rare): render the layer.
                window.layer.render(in: ctx.cgContext)
            }
            UIColor.black.setFill()
            for rect in rects {
                ctx.fill(rect)
            }
        }
        guard let jpeg = image.jpegData(compressionQuality: jpegQuality) else { return nil }
        let thumb = ScreenCapturer.thumbnail(of: image) ?? Data()
        return Capture(
            jpeg: jpeg,
            viewport: Viewport(width: Double(bounds.width), height: Double(bounds.height), scale: Double(scale)),
            thumbnail: thumb,
            redactedRects: rects.count
        )
    }

    /// 16x16 8-bit grayscale rendering of the image: small, and insensitive to JPEG noise.
    static func thumbnail(of image: UIImage, side: Int = 16) -> Data? {
        guard let cg = image.cgImage else { return nil }
        let colorSpace = CGColorSpaceCreateDeviceGray()
        guard let ctx = CGContext(
            data: nil,
            width: side,
            height: side,
            bitsPerComponent: 8,
            bytesPerRow: side,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        ctx.interpolationQuality = .low
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: side, height: side))
        guard let data = ctx.data else { return nil }
        return Data(bytes: data, count: side * side)
    }
}
#endif
