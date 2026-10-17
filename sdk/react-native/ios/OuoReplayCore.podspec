require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# Pure-Swift core of the OuoReplay package (sdk/ios/Sources/OuoReplayCore). The sources are
# copied into ios/OuoReplayCore by `npm run -w sdk/react-native build` (scripts/sync-ios.mjs):
# CocoaPods only globs files under the podspec's own directory, so a Swift package outside the
# npm package cannot be referenced directly. Run the build before `pod install`.
Pod::Spec.new do |s|
  s.name           = 'OuoReplayCore'
  s.version        = package['version']
  s.summary        = 'ouo session replay for iOS: chunking, redaction geometry, gzip, upload'
  s.description    = 'Pure Swift core of the OuoReplay package. Vendored from sdk/ios by the SDK build.'
  s.license        = package['license']
  s.author         = 'ouo'
  s.homepage       = 'https://github.com/ouo11y/ouo11y'
  s.platforms      = { :ios => '15.0' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/ouo11y/ouo11y.git' }
  s.static_framework = true
  s.libraries      = 'z'

  s.source_files = 'OuoReplayCore/**/*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
