#if canImport(UIKit)
import UIKit
import OuoReplayCore

/// Captures the key window in two halves. `snapshot(window:)` runs on the main thread and does only
/// what UIKit requires there: walk the view tree into value types and `drawHierarchy` into an 8-bit
/// sRGB bitmap. `compose(_:)` runs on the recorder's capture queue: redaction planning, painting
/// the rectangles, the dedupe thumbnail and JPEG encoding (CoreGraphics + ImageIO, thread-safe).
/// The unredacted bitmap never leaves the capture queue; only the composed JPEG is uploaded.
final class ScreenCapturer {
    /// Main-thread result: the raw (unredacted) frame and everything needed to redact it later.
    struct Snapshot {
        let image: CGImage
        let tree: ViewNode
        let bounds: CGRect
        let scale: CGFloat
    }

    struct Capture {
        let jpeg: Data
        let viewport: Viewport
        let redactedRects: Int
    }

    private let planner: RedactionPlanner
    private let composer: FrameComposer
    /// Last diagnostic set, so the debug log reports changes only (capture queue).
    private var lastUnmatched: [String] = []
    private let maxLongestSide: CGFloat
    private let logger: ReplayLogger

    init(rules: RedactionRules, jpegQuality: Double, maxLongestSide: Double, logger: ReplayLogger) {
        self.planner = RedactionPlanner(rules: rules, mergeOverlapping: true)
        self.composer = FrameComposer(jpegQuality: jpegQuality)
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

    /// Main thread only (`drawHierarchy` and the view walk require it).
    func snapshot(window: UIWindow) -> Snapshot? {
        let bounds = window.bounds
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        let tree = ViewTreeBuilder.node(for: window)
        let scale = renderScale(for: bounds, screenScale: window.screen.scale)
        let pw = Int((bounds.width * scale).rounded(.up))
        let ph = Int((bounds.height * scale).rounded(.up))
        // Rendered once, directly at the final size, 8 bits per channel: UIGraphicsImageRenderer
        // would pick the extended-range 16-bit format on wide-color phones (twice the bytes).
        guard let ctx = FrameComposer.makeContext(pixelWidth: pw, pixelHeight: ph) else { return nil }
        ctx.translateBy(x: 0, y: CGFloat(ph))
        ctx.scaleBy(x: scale, y: -scale)
        UIGraphicsPushContext(ctx)
        // `afterScreenUpdates: false` reads the last committed frame without forcing a layout pass.
        let drawn = window.drawHierarchy(in: bounds, afterScreenUpdates: false)
        if !drawn {
            // Fallback for windows that refuse drawHierarchy (rare): render the layer.
            window.layer.render(in: ctx)
        }
        UIGraphicsPopContext()
        guard let image = ctx.makeImage() else { return nil }
        return Snapshot(image: image, tree: tree, bounds: bounds, scale: scale)
    }

    /// Any thread (the capture queue): redaction, thumbnail for dedupe, JPEG. Returns nil when the
    /// frame equals the previous kept one (`deduper`) or encoding fails.
    func compose(_ s: Snapshot, deduper: FrameDeduper) -> Capture? {
        let rects = planner.rects(for: s.tree, window: s.bounds)
        if logger.enabled {
            let unmatched = planner.unmatchedContentClasses(in: s.tree)
            if !unmatched.isEmpty, unmatched != lastUnmatched {
                lastUnmatched = unmatched
                logger.log("redaction: unmatched content-like classes \(unmatched)")
            }
        }
        guard let masked = composer.redact(s.image, rects: rects, scale: s.scale) else { return nil }
        // Dedupe on the redacted frame (what would be uploaded), before paying for the JPEG.
        guard deduper.shouldKeep(FrameComposer.thumbnail(of: masked) ?? Data()) else { return nil }
        guard let jpeg = composer.jpeg(masked) else { return nil }
        return Capture(
            jpeg: jpeg,
            viewport: Viewport(width: Double(s.bounds.width), height: Double(s.bounds.height), scale: Double(s.scale)),
            redactedRects: rects.count
        )
    }
}
#endif
