#if canImport(UIKit)
import UIKit
import OuoReplayCore

/// Captures the key window in two halves. `snapshot(window:)` runs on the main thread and does only
/// what UIKit requires there: `drawHierarchy` 1:1 at the screen's scale into an 8-bit bitmap in the
/// screen's color space (no resample, no color conversion: Sentry's V2 renderer), after `plan` gave
/// the rectangles to mask (nil when masking fails closed, so an unsafe frame costs no render).
/// `compose` runs on the recorder's capture queue: downscale, painting the rectangles, the tile
/// diff against the last frame sent and JPEG encoding of a full image or the changed rectangles
/// (CoreGraphics + ImageIO, thread-safe). The unredacted bitmap never leaves the capture queue;
/// only JPEGs are uploaded.
final class ScreenCapturer {
    /// Main-thread result: the raw (unredacted) frame and everything needed to redact it later.
    struct Snapshot {
        let image: CGImage
        let tree: ViewNode
        /// What to paint black, window points.
        let rects: [CGRect]
        let bounds: CGRect
        /// Pixels per point of the frame to encode (the image itself is at the screen scale).
        let scale: CGFloat
    }

    enum Outcome {
        case frame(Frame)
        /// Same pixels as the last frame sent.
        case unchanged
        case failed
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

    /// Pixels per point of the encoded frame: the screen scale divided by the smallest integer that
    /// makes the longest side fit (`FrameComposer.renderScale`).
    func renderScale(for bounds: CGRect, screenScale: CGFloat) -> CGFloat {
        CGFloat(FrameComposer.renderScale(
            longestSidePoints: Double(max(bounds.width, bounds.height)),
            screenScale: Double(screenScale),
            maxLongestSide: Double(maxLongestSide)
        ))
    }

    /// The rectangles to mask, nil when the frame must be dropped (a masked view is moving).
    func plan(_ tree: ViewNode, bounds: CGRect) -> [CGRect]? {
        planner.rects(for: tree, window: bounds)
    }

    /// Main thread only (`drawHierarchy` requires it). `tree` and `rects` are from the same pass.
    func snapshot(window: UIWindow, tree: ViewNode, rects: [CGRect]) -> Snapshot? {
        let bounds = window.bounds
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        let screenScale = window.screen.scale
        let pw = Int((bounds.width * screenScale).rounded(.up))
        let ph = Int((bounds.height * screenScale).rounded(.up))
        // 8 bits per channel in the screen's own color space: UIGraphicsImageRenderer picks a 16-bit
        // half-float format on wide-color screens, and an sRGB target makes drawHierarchy convert
        // every pixel from Display P3. At the screen scale the render server's surface is copied,
        // not resampled (N51: resampling inside drawHierarchy doubled our main-thread time).
        let space = window.traitCollection.displayGamut == .P3 ? FrameComposer.displayP3 : FrameComposer.sRGB
        guard let ctx = FrameComposer.makeContext(pixelWidth: pw, pixelHeight: ph, colorSpace: space) else { return nil }
        ctx.translateBy(x: 0, y: CGFloat(ph))
        ctx.scaleBy(x: screenScale, y: -screenScale)
        UIGraphicsPushContext(ctx)
        // `afterScreenUpdates: false` reads the last committed frame without forcing a layout pass.
        let drawn = window.drawHierarchy(in: bounds, afterScreenUpdates: false)
        if !drawn {
            // Fallback for windows that refuse drawHierarchy (rare): render the layer.
            window.layer.render(in: ctx)
        }
        UIGraphicsPopContext()
        guard let image = ctx.makeImage() else { return nil }
        return Snapshot(image: image, tree: tree, rects: rects, bounds: bounds, scale: renderScale(for: bounds, screenScale: screenScale))
    }

    /// The viewport of the frame `s` becomes: points and the pixels per point of the frame.
    static func viewport(of s: Snapshot) -> Viewport {
        Viewport(width: Double(s.bounds.width), height: Double(s.bounds.height), scale: Double(s.scale))
    }

    /// Any thread (the capture queue): downscale, redact, then a full image or the changed
    /// rectangles against the last frame sent (`differ`); `forceFull` for the first frame of a chunk.
    func compose(_ s: Snapshot, differ: TileDiffer, forceFull: Bool, ts: EpochMillis, reason: FrameReason) -> Outcome {
        if logger.enabled {
            let unmatched = planner.unmatchedContentClasses(in: s.tree)
            if !unmatched.isEmpty, unmatched != lastUnmatched {
                lastUnmatched = unmatched
                logger.log("redaction: unmatched content-like classes \(unmatched)")
            }
        }
        let pw = Int((s.bounds.width * s.scale).rounded(.up))
        let ph = Int((s.bounds.height * s.scale).rounded(.up))
        guard let small = FrameComposer.downscale(s.image, pixelWidth: pw, pixelHeight: ph),
              let masked = composer.redact(small, rects: s.rects, scale: s.scale),
              let encoded = composer.encode(masked, differ: differ, forceFull: forceFull) else { return .failed }
        switch encoded {
        case .unchanged:
            return .unchanged
        case .full(let jpeg):
            return .frame(Frame(ts: ts, jpegData: jpeg, reason: reason))
        case .patches(let patches):
            return .frame(Frame(ts: ts, patches: patches.map { Patch($0.0, jpegData: $0.1) }, reason: reason))
        }
    }
}
#endif
