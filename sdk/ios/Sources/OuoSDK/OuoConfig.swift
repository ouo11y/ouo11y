import Foundation
import OuoReplay

/// What `Ouo.start` needs. The four values of the initializer are required; every property has the
/// default the mobile SDK spec gives. Swift and Objective-C (`OuoConfig`).
@objc(OuoConfig)
@objcMembers
public final class OuoConfig: NSObject {
    /// Collector OTLP/HTTP base URL (`https://otel.example.com`, `http://localhost:4318`): logs go to
    /// `/v1/logs`, spans to `/v1/traces` (ADR-0007).
    public let endpoint: URL
    /// The project credential, sent as `Authorization: Basic base64(projectId:projectToken)`.
    public let projectId: String
    public let projectToken: String
    /// `service.name`, for example `mobile-store`.
    public let serviceName: String
    /// `service.version`, the version dimension of health percentages. Default: `CFBundleShortVersionString`.
    public var serviceVersion: String
    /// `deployment.environment.name`. Default `production`.
    public var environment: String = "production"
    /// Base URL of the collector's replay receiver. Default: `endpoint` with port 4318 replaced by
    /// 4319 (the local stack), else `endpoint` itself (a proxy that routes `/v1/replay/*`).
    public var replayEndpoint: URL?

    /// Fraction of sessions whose records are sent, 0 to 1, decided once per session from its id
    /// (the rule of `@ouo11y/react-native`). Default 1.
    public var sessionSampleRate: Double = 1
    /// Background longer than this ends the session on foreground (C1). Default 30 s.
    public var backgroundTimeout: TimeInterval = 30
    public var inactivityTimeout: TimeInterval = 30 * 60
    public var maxSessionDuration: TimeInterval = 4 * 60 * 60

    /// URL prefixes that receive `traceparent` and `baggage` (with `session.id`) on requests (C5).
    /// Other requests still get a client span. Matched at a path boundary.
    public var propagateTo: [String] = []
    /// URL prefixes never traced. The ingest URLs are never traced either.
    public var ignoreUrls: [String] = []
    /// `http.request` events for answered requests below 500 (the session timeline). Default true.
    public var requestEvents = true
    /// `app.lifecycle` events (`foreground`, `inactive`, `background`). Default true.
    public var lifecycleEvents = true
    /// Screens (C7) from UIKit: every view controller of the app that appears on its own or in a
    /// navigation, tab bar, split or page controller is a screen, named after its class (or
    /// `OuoScreenNaming`). SwiftUI views use `.ouoScreen("Name")`. Default true.
    public var screens = true
    /// `ui.tap` (C6) for every touch: tap, long press or swipe, on the screen it started on. Default true.
    public var taps = true
    /// Labels on taps (test ids, controls' accessibility labels). False: the target is the view
    /// type, without a path; taps the app passes to `trackTap` keep their target. Default true.
    public var tapLabels = true

    /// Crashes (signals, uncaught NSExceptions), foreground terminations and app hangs (C2, C3).
    /// Default true.
    public var crashes = true
    /// App start, screen display (TTID, TTFD) and frames (C4). Default true.
    public var vitals = true

    /// Fraction of (sampled) sessions recorded by session replay (C8), 0 to 1. Default 0: off.
    public var replaySampleRate: Double = 0
    /// `session`, `navigation` or `auto` (navigation below 3.5 GiB of RAM). Default `auto`.
    @nonobjc public var replayMode: ReplayMode = .auto
    /// Masking (mobile-replay.md capture rule 4): every group masked unless turned off.
    public var replayMaskText = true
    public var replayMaskInputs = true
    public var replayMaskImages = true
    public var replayMaskWebViews = true

    /// Extra resource attributes on every record (prefix your own keys with `ouo.`). The SDK's own win.
    public var resourceAttributes: [String: Any] = [:]
    /// Log SDK decisions with the `[ouo]` prefix.
    public var debug = false

    public init(endpoint: URL, projectId: String, projectToken: String, serviceName: String) {
        self.endpoint = endpoint
        self.projectId = projectId.trimmingCharacters(in: .whitespacesAndNewlines)
        self.projectToken = projectToken.trimmingCharacters(in: .whitespacesAndNewlines)
        self.serviceName = serviceName
        self.serviceVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        super.init()
    }

    /// Why `Ouo.start` refuses this config, nil when it is usable.
    var problem: String? {
        guard let scheme = endpoint.scheme?.lowercased(), scheme == "http" || scheme == "https", endpoint.host != nil else {
            return "endpoint must be an http(s) URL, got \(endpoint.absoluteString)"
        }
        if projectId.isEmpty || projectToken.isEmpty { return "projectId and projectToken are required (ADR-0007); the collector answers 401 without them" }
        if projectId.contains(":") { return "projectId must not contain \":\" (it is the user name of the Basic credential)" }
        if serviceName.isEmpty { return "serviceName is required" }
        return nil
    }

    /// `replayEndpoint`, or `endpoint` with port 4318 replaced by 4319.
    var resolvedReplayEndpoint: URL {
        if let r = replayEndpoint { return r }
        guard endpoint.port == 4318, var c = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return endpoint }
        c.port = 4319
        return c.url ?? endpoint
    }
}

/// The config as `start` saw it: an immutable copy, so an app changing `OuoConfig` afterwards does
/// not race with the network, timer and watchdog threads that read it.
struct Settings {
    let endpoint: URL
    let replayEndpoint: URL
    let projectId: String
    let projectToken: String
    let serviceName: String
    let serviceVersion: String
    let environment: String
    let sessionSampleRate: Double
    let timeouts: SessionManager.Timeouts
    let propagateTo: [String]
    let ignoreUrls: [String]
    let requestEvents: Bool
    let lifecycleEvents: Bool
    let screens: Bool
    let taps: Bool
    let tapLabels: Bool
    let crashes: Bool
    let vitals: Bool
    let replaySampleRate: Double
    let replayMode: ReplayMode
    let replayMask: (text: Bool, inputs: Bool, images: Bool, webViews: Bool)
    let resourceAttributes: Attributes
    let debug: Bool

    init(_ c: OuoConfig) {
        endpoint = c.endpoint
        replayEndpoint = c.resolvedReplayEndpoint
        projectId = c.projectId
        projectToken = c.projectToken
        serviceName = c.serviceName
        serviceVersion = c.serviceVersion
        environment = c.environment
        sessionSampleRate = c.sessionSampleRate
        timeouts = SessionManager.Timeouts(inactivity: c.inactivityTimeout * 1000, maxDuration: c.maxSessionDuration * 1000, background: c.backgroundTimeout * 1000)
        propagateTo = c.propagateTo
        ignoreUrls = c.ignoreUrls
        requestEvents = c.requestEvents
        lifecycleEvents = c.lifecycleEvents
        screens = c.screens
        taps = c.taps
        tapLabels = c.tapLabels
        crashes = c.crashes
        vitals = c.vitals
        replaySampleRate = c.replaySampleRate
        replayMode = c.replayMode
        replayMask = (c.replayMaskText, c.replayMaskInputs, c.replayMaskImages, c.replayMaskWebViews)
        resourceAttributes = Attributes(app: c.resourceAttributes)
        debug = c.debug
    }
}
