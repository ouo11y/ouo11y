// Copied from getsentry/sentry-cocoa 9.33.0, Sources/Swift/Core/Tools/ViewCapture/SentryMaskRenderer.swift.
// Copyright (c) 2015 Sentry. MIT License, see sdk/ios/THIRD_PARTY_NOTICES.
// Do not edit: re-vendor with sdk/ios/scripts/sentry-core-sync.sh; ouo code lives outside Upstream/.

#if canImport(UIKit) && !SENTRY_NO_UI_FRAMEWORK
#if os(iOS) || os(tvOS) || os(visionOS)

import UIKit

protocol SentryMaskRenderer {
    func maskScreenshot(screenshot image: UIImage, size: CGSize, masking: [SentryRedactRegion], scale: CGFloat) -> UIImage
}

protocol SentryMaskRendererContext {
    var cgContext: CGContext { get }
    var currentImage: UIImage { get }
}

#endif // os(iOS) || os(tvOS)
#endif // canImport(UIKit) && !SENTRY_NO_UI_FRAMEWORK
