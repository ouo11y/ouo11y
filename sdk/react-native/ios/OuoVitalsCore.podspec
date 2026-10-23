require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# C half of the mobile vitals (sdk/ios/Sources/OuoVitalsCore): process start and image load time.
# Vendored into ios/OuoVitalsCore by scripts/sync-ios.mjs. See OuoReplayCore.podspec.
Pod::Spec.new do |s|
  s.name           = 'OuoVitalsCore'
  s.version        = package['version']
  s.summary        = 'ouo mobile vitals for iOS: process start and image load time'
  s.description    = 'C target of the OuoVitals package. Vendored from sdk/ios by the SDK build.'
  s.license        = package['license']
  s.author         = 'ouo'
  s.homepage       = 'https://github.com/ouo11y/ouo11y'
  s.platforms      = { :ios => '15.0' }
  s.source         = { git: 'https://github.com/ouo11y/ouo11y.git' }
  s.static_framework = true

  s.source_files = 'OuoVitalsCore/**/*.{c,h}'
  s.public_header_files = 'OuoVitalsCore/include/*.h'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
