# Generates build/OpenURL.xcodeproj (one UI test bundle, OpenURLUITests.swift); same approach as
# examples/sentry-mobile/scripts/perf/make-driver.rb.
require "fileutils"
require "xcodeproj"
dir = __dir__
out = File.join(dir, "build", "OpenURL.xcodeproj")
FileUtils.rm_rf(out)
FileUtils.mkdir_p(File.dirname(out))
project = Xcodeproj::Project.new(out)
target = project.new_target(:ui_test_bundle, "OpenURL", :ios, "17.0")
group = project.new_group("OpenURL", dir)
target.add_file_references([group.new_reference(File.join(dir, "OpenURLUITests.swift"))])
target.build_configurations.each do |c|
  c.build_settings["PRODUCT_BUNDLE_IDENTIFIER"] = "dev.ouo.openurl"
  c.build_settings["GENERATE_INFOPLIST_FILE"] = "YES"
  c.build_settings["SWIFT_VERSION"] = "5.0"
  c.build_settings["CODE_SIGN_IDENTITY"] = "-"
  c.build_settings["CODE_SIGN_STYLE"] = "Manual"
  c.build_settings["TARGETED_DEVICE_FAMILY"] = "1"
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_test_target(target)
scheme.save_as(out, "OpenURL", true)
puts out
