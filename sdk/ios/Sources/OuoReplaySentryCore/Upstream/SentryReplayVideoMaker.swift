// Copied from getsentry/sentry-cocoa 9.33.0, Sources/Swift/Integrations/SessionReplay/SentryReplayVideoMaker.swift.
// Copyright (c) 2015 Sentry. MIT License, see sdk/ios/THIRD_PARTY_NOTICES.
// Do not edit: re-vendor with sdk/ios/scripts/sentry-core-sync.sh; ouo code lives outside Upstream/.

// swiftlint:disable missing_docs
#if canImport(UIKit) && !SENTRY_NO_UI_FRAMEWORK
import Foundation
import UIKit

@objc
@_spi(Private) public protocol SentryReplayVideoMaker: NSObjectProtocol {
    func addFrameAsync(timestamp: Date, maskedViewImage: UIImage, forScreen: String?)
    func releaseFramesUntil(_ date: Date)
    func createVideoInBackgroundWith(beginning: Date, end: Date, completion: @escaping ([SentryVideoInfo]) -> Void)
    func createVideoWith(beginning: Date, end: Date) -> [SentryVideoInfo]
}

extension SentryReplayVideoMaker {
    func addFrameAsync(timestamp: Date, maskedViewImage: UIImage) {
        self.addFrameAsync(timestamp: timestamp, maskedViewImage: maskedViewImage, forScreen: nil)
    }
}

#endif
// swiftlint:enable missing_docs
