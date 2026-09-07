# Fastlane evaluates lanes from ios/fastlane, unlike workflow shell steps.
# Anchor the sandbox to this file so a valid CI cache is not reinstalled.
module LilypadPodsSandbox
  IOS_ROOT = File.expand_path('..', __dir__).freeze

  def self.current?(ios_root = IOS_ROOT)
    manifest = File.join(ios_root, 'Pods', 'Manifest.lock')
    lockfile = File.join(ios_root, 'Podfile.lock')
    File.file?(manifest) && File.file?(lockfile) &&
      File.binread(manifest) == File.binread(lockfile)
  end
end
