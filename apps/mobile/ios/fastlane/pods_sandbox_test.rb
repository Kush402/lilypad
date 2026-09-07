require 'tmpdir'
require 'fileutils'
require_relative 'pods_sandbox'

raise 'sandbox root must be ios, not fastlane' unless
  LilypadPodsSandbox::IOS_ROOT == File.expand_path('..', __dir__)

Dir.mktmpdir('lilypad-pods-test') do |root|
  ios = File.join(root, 'ios')
  FileUtils.mkdir_p(File.join(ios, 'fastlane'))
  FileUtils.mkdir_p(File.join(ios, 'Pods'))
  lockfile = File.join(ios, 'Podfile.lock')
  manifest = File.join(ios, 'Pods', 'Manifest.lock')
  File.write(lockfile, "PODS: locked\n")
  Dir.chdir(File.join(ios, 'fastlane')) do
    raise 'missing manifest accepted' if LilypadPodsSandbox.current?(ios)
    File.write(manifest, "PODS: locked\n")
    raise 'valid cache missed from Fastlane directory' unless LilypadPodsSandbox.current?(ios)
    File.write(manifest, "PODS: stale\n")
    raise 'stale cache accepted' if LilypadPodsSandbox.current?(ios)
    File.delete(lockfile)
    raise 'missing lockfile accepted' if LilypadPodsSandbox.current?(ios)
  end
end
puts 'CocoaPods sandbox checks passed'
