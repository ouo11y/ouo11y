require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# UIKit capture target of the OuoReplay package (sdk/ios/Sources/OuoReplay), vendored into
# ios/OuoReplay by scripts/sync-ios.mjs. See OuoReplayCore.podspec.
Pod::Spec.new do |s|
  s.name           = 'OuoReplay'
  s.version        = package['version']
  s.summary        = 'ouo session replay for iOS: screenshot capture with view-hierarchy masking'
  s.description    = 'UIKit capture target of the OuoReplay package. Vendored from sdk/ios by the SDK build.'
  s.license        = package['license']
  s.author         = 'ouo'
  s.homepage       = 'https://github.com/ouo11y/ouo11y'
  s.platforms      = { :ios => '15.0' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/ouo11y/ouo11y.git' }
  s.static_framework = true
  s.frameworks     = 'UIKit'

  s.dependency 'OuoReplayCore'
  s.dependency 'OuoReplayObjC'
  s.dependency 'OuoReplaySentryCore'

  s.source_files = 'OuoReplay/**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
