require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# sentry-cocoa's session-replay recorder core (MIT, see NOTICE and THIRD_PARTY_NOTICES) and its
# ouo driver (sdk/ios/Sources/OuoReplaySentryCore): what `replay.mode: "pixel/video"` records
# with, masked by ouo's plan. Vendored into ios/OuoReplaySentryCore by scripts/sync-ios.mjs. See
# OuoReplayCore.podspec.
Pod::Spec.new do |s|
  s.name           = 'OuoReplaySentryCore'
  s.version        = package['version']
  s.summary        = 'ouo session replay for iOS: H.264 video segments (sentry-cocoa recorder core)'
  s.description    = 'Video recorder core of the OuoReplay package, adapted from sentry-cocoa 9.33.0. Vendored from sdk/ios by the SDK build.'
  s.license        = package['license']
  s.author         = 'ouo'
  s.homepage       = 'https://github.com/ouo11y/ouo11y'
  s.platforms      = { :ios => '15.0' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/ouo11y/ouo11y.git' }
  s.static_framework = true
  s.frameworks     = 'UIKit', 'AVFoundation', 'CoreMedia', 'CoreVideo', 'PDFKit', 'WebKit'

  s.dependency 'OuoReplaySentryCoreObjC'

  s.source_files = 'OuoReplaySentryCore/**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
