require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# Async-signal-safe C half of the native crash capture (sdk/ios/Sources/OuoCrashCore), vendored into
# ios/OuoCrashCore by scripts/sync-ios.mjs. See OuoReplayCore.podspec.
Pod::Spec.new do |s|
  s.name           = 'OuoCrashCore'
  s.version        = package['version']
  s.summary        = 'ouo native crash capture for iOS: signal handlers and the on-disk crash report'
  s.description    = 'C target of the OuoCrash package. Vendored from sdk/ios by the SDK build.'
  s.license        = package['license']
  s.author         = 'ouo'
  s.homepage       = 'https://github.com/ouo11y/ouo11y'
  s.platforms      = { :ios => '15.0' }
  s.source         = { git: 'https://github.com/ouo11y/ouo11y.git' }
  s.static_framework = true

  s.source_files = 'OuoCrashCore/**/*.{c,h}'
  s.public_header_files = 'OuoCrashCore/include/*.h'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
