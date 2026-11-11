// Copied from getsentry/sentry-cocoa 9.33.0, Sources/Swift/Core/Tools/ViewCapture/SentryViewScreenshotProvider.swift.
// Copyright (c) 2015 Sentry. MIT License, see sdk/ios/THIRD_PARTY_NOTICES.
// Do not edit: re-vendor with sdk/ios/scripts/sentry-core-sync.sh; ouo code lives outside Upstream/.

// swiftlint:disable missing_docs
#if canImport(UIKit) && !SENTRY_NO_UI_FRAMEWORK
#if os(iOS) || os(tvOS) || os(visionOS)
import Foundation
import UIKit

@_spi(Private) public typealias ScreenshotCallback = (_ maskedViewImage: UIImage) -> Void

/// Reports the masked screenshot and timing data for each capture phase.
@_spi(Private) public typealias TimedScreenshotCallback = (_ maskedViewImage: UIImage, _ metadata: SentryViewPhotographerScreenshotMetadata) -> Void

@objc
@_spi(Private) public protocol SentryViewScreenshotProvider: NSObjectProtocol {
    func image(view: UIView, onComplete: @escaping ScreenshotCallback)
}

/// Optional screenshot provider that can report capture timing metadata for pacing decisions.
///
/// Custom hybrid providers may keep implementing only ``SentryViewScreenshotProvider``. Session Replay
/// then falls back to wall-clock timing around the full provider callback.
@_spi(Private) public protocol SentryTimedViewScreenshotProvider: SentryViewScreenshotProvider {
    func timedImage(view: UIView, onComplete: @escaping TimedScreenshotCallback)
}
#endif
#endif
// swiftlint:enable missing_docs
