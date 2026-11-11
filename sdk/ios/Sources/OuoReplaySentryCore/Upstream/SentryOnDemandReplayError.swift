// Copied from getsentry/sentry-cocoa 9.33.0, Sources/Swift/Integrations/SessionReplay/SentryOnDemandReplayError.swift.
// Copyright (c) 2015 Sentry. MIT License, see sdk/ios/THIRD_PARTY_NOTICES.
// Do not edit: re-vendor with sdk/ios/scripts/sentry-core-sync.sh; ouo code lives outside Upstream/.

enum SentryOnDemandReplayError: Error {
    case cantReadVideoSize
    case cantCreatePixelBuffer
    case cantReadImage
    case errorRenderingVideo
    case cantReadVideoStartTime
    case indexOutOfBounds
}
