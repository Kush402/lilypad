// Intentionally empty, and load-bearing.
//
// Four pods link as prebuilt STATIC SWIFT libraries — AppCheckCore and
// GTMAppAuth (via Sign in with Google), PromisesSwift, and VisionCamera (the
// QR scanner). Each of them references `__swift_FORCE_LOAD_$_swiftCompatibility56`,
// a symbol that lives in `libswiftCompatibility56.a` inside the toolchain.
//
// Xcode links the Swift runtime and its back-deployment shims into an app
// target only when that target itself compiles Swift. This app is entirely
// Objective-C (`AppDelegate.mm`, `main.m`), so it never did, and the archive
// failed at the very last step:
//
//     Undefined symbols for architecture arm64
//       "__swift_FORCE_LOAD_$_swiftCompatibility56", referenced from:
//         ... in libAppCheckCore.a, libGTMAppAuth.a, libPromisesSwift.a,
//             libVisionCamera.a
//     ld: symbol(s) not found for architecture arm64
//
// `SWIFT_VERSION = 5.0` was already set on both configurations; a version
// alone does not invoke the Swift driver. One Swift file in the target does,
// which is all this is. Deleting it breaks the iOS build at link time and
// nowhere earlier — no test, no compile error, just a failed archive.
