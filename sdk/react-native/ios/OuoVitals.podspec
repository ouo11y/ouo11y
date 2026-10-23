require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# Swift API of the mobile vitals (sdk/ios/Sources/OuoVitals): app start and CADisplayLink frame
# counters. Vendored into ios/OuoVitals by scripts/sync-ios.mjs. See OuoReplayCore.podspec.
Pod::Spec.new do |s|
  s.name           = 'OuoVitals'
  s.version        = package['version']
  s.summary        = 'ouo mobile vitals for iOS: app start and frame counters'
  s.description    = 'Swift target of the OuoVitals package. Vendored from sdk/ios by the SDK build.'
  s.license        = package['license']
  s.author         = 'ouo'
  s.homepage       = 'https://github.com/ouo11y/ouo11y'
  s.platforms      = { :ios => '15.0' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/ouo11y/ouo11y.git' }
  s.static_framework = true
  s.frameworks     = 'UIKit', 'QuartzCore'

  s.dependency 'OuoVitalsCore'

  s.source_files = 'OuoVitals/**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
