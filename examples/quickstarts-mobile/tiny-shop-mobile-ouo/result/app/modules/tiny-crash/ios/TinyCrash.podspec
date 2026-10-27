# Pod for the app's own TinyCrash module (modules/tiny-crash), autolinked by Expo.
Pod::Spec.new do |s|
  s.name           = 'TinyCrash'
  s.version        = '1.0.0'
  s.summary        = 'Crashes the app on purpose, to test native crash reporting'
  s.author         = 'Tiny Shop'
  s.homepage       = 'https://github.com/ouo11y/ouo11y'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
end
