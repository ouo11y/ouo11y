# Demo-only native module of examples/ouo-mobile: what the OS does to an app (a blocked main thread,
# an out-of-memory kill), so the Chaos screen and the journey can show what the SDK reports.
Pod::Spec.new do |s|
  s.name           = 'OuoChaos'
  s.version        = '1.0.0'
  s.summary        = 'ouo-mobile demo: main-thread hangs and out-of-memory kills on demand'
  s.license        = 'Apache-2.0'
  s.author         = 'ouo'
  s.homepage       = 'https://github.com/ouo11y/ouo11y'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/ouo11y/ouo11y.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
end
