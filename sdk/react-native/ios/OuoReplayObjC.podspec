require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# The one Objective-C function of the OuoReplay package (sdk/ios/Sources/OuoReplayObjC): it
# contains an NSException raised by a UIKit call made while the replay recorder walks or renders
# the host's views, which Swift cannot catch. Vendored into ios/OuoReplayObjC by
# scripts/sync-ios.mjs. See OuoReplayCore.podspec.
Pod::Spec.new do |s|
  s.name           = 'OuoReplayObjC'
  s.version        = package['version']
  s.summary        = 'ouo session replay for iOS: Objective-C exception containment'
  s.description    = 'Objective-C target of the OuoReplay package. Vendored from sdk/ios by the SDK build.'
  s.license        = package['license']
  s.author         = 'ouo'
  s.homepage       = 'https://github.com/ouo11y/ouo11y'
  s.platforms      = { :ios => '15.0' }
  s.source         = { git: 'https://github.com/ouo11y/ouo11y.git' }
  s.static_framework = true

  s.source_files = 'OuoReplayObjC/**/*.{m,h}'
  s.public_header_files = 'OuoReplayObjC/include/*.h'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
