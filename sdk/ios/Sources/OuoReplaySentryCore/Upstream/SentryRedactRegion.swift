// Copied from getsentry/sentry-cocoa 9.33.0, Sources/Swift/Core/Tools/ViewCapture/SentryRedactRegion.swift.
// Copyright (c) 2015 Sentry. MIT License, see sdk/ios/THIRD_PARTY_NOTICES.
// Do not edit: re-vendor with sdk/ios/scripts/sentry-core-sync.sh; ouo code lives outside Upstream/.

#if canImport(UIKit) && !SENTRY_NO_UI_FRAMEWORK
#if os(iOS) || os(tvOS) || os(visionOS)
import Foundation
import ObjectiveC.NSObjCRuntime
import UIKit

struct SentryRedactRegion: Equatable {
    let size: CGSize
    let transform: CGAffineTransform
    let type: SentryRedactRegionType
    let color: UIColor?
    let name: String

    init(size: CGSize, transform: CGAffineTransform, type: SentryRedactRegionType, color: UIColor? = nil, name: String) {
        self.size = size
        self.transform = transform
        self.type = type
        self.color = color
        self.name = name
    }

    func canReplace(as other: SentryRedactRegion) -> Bool {
        size == other.size && transform == other.transform && type == other.type
    }
}
#endif
#endif
