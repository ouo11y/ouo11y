require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# Swift API of the native crash capture (sdk/ios/Sources/OuoCrash): install, NSException handler,
# pending report, foreground terminations and app hangs. Vendored into ios/OuoCrash by
# scripts/sync-ios.mjs. See OuoReplayCore.podspec.
Pod::Spec.new do |s|
  s.name           = 'OuoCrash'
  s.version        = package['version']
  s.summary        = 'ouo native crash capture for iOS'
  s.description    = 'Swift target of the OuoCrash package. Vendored from sdk/ios by the SDK build.'
  s.license        = package['license']
  s.author         = 'ouo'
  s.homepage       = 'https://github.com/ouo11y/ouo11y'
  s.platforms      = { :ios => '15.0' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/ouo11y/ouo11y.git' }
  s.static_framework = true
  s.frameworks     = 'Network'

  s.dependency 'OuoCrashCore'
  # The app hang watchdog runs on OuoVitals' display link frames (W4).
  s.dependency 'OuoVitals'

  s.source_files = 'OuoCrash/**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
