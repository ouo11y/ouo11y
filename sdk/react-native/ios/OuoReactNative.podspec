require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# Expo native module exposing OuoReplay to @ouo/react-native (expo-module.config.json).
Pod::Spec.new do |s|
  s.name           = 'OuoReactNative'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = 'ouo'
  s.homepage       = 'https://github.com/ZiadMansourM/ouo'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/ZiadMansourM/ouo.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'OuoReplay'

  s.source_files = '*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
