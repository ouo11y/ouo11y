// ouo seam for sentry-cocoa's SentryLogC.h, which the vendored SentryObjCExceptionHelper.m imports.
// The swallowed exception is reported by the Swift caller (SentrySDKLog in Seams.swift), so the
// Objective-C side logs nothing.
#define SENTRY_LOG_WARN(...) do { } while (0)
