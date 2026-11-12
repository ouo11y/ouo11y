// Copied from getsentry/sentry-cocoa 9.33.0, Sources/Swift/Core/Tools/ViewCapture/SentryViewRenderer.swift.
// Copyright (c) 2015 Sentry. MIT License, see sdk/ios/THIRD_PARTY_NOTICES.
// Do not edit: re-vendor with sdk/ios/scripts/sentry-core-sync.sh; ouo code lives outside Upstream/.

// swiftlint:disable missing_docs
#if canImport(UIKit) && !SENTRY_NO_UI_FRAMEWORK
#if os(iOS) || os(tvOS) || os(visionOS)

import UIKit

@objc @_spi(Private) public protocol SentryViewRenderer {
    func render(view: UIView) -> UIImage
}

#endif // os(iOS) || os(tvOS)
#endif // canImport(UIKit) && !SENTRY_NO_UI_FRAMEWORK
// swiftlint:enable missing_docs
