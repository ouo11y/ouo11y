require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# The one Objective-C helper of the video recorder core (sdk/ios/Sources/OuoReplaySentryCoreObjC,
# from sentry-cocoa 9.33.0, MIT): catches a Core Animation NSException while the core reads layers.
# Vendored into ios/OuoReplaySentryCoreObjC by scripts/sync-ios.mjs. See OuoReplayCore.podspec.
Pod::Spec.new do |s|
  s.name           = 'OuoReplaySentryCoreObjC'
  s.version        = package['version']
  s.summary        = 'ouo session replay for iOS: Objective-C helper of the video recorder core'
  s.description    = 'Objective-C target of the video recorder core, adapted from sentry-cocoa 9.33.0. Vendored from sdk/ios by the SDK build.'
  s.license        = package['license']
  s.author         = 'ouo'
  s.homepage       = 'https://github.com/ouo11y/ouo11y'
  s.platforms      = { :ios => '15.0' }
  s.source         = { git: 'https://github.com/ouo11y/ouo11y.git' }
  s.static_framework = true

  s.source_files = 'OuoReplaySentryCoreObjC/**/*.{m,h}'
  s.public_header_files = 'OuoReplaySentryCoreObjC/include/*.h'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
