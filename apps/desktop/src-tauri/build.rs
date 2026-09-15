fn main() {
    // Swift bridge dependencies emit this from their own build scripts, but a
    // dependency's rustc-link-arg does not reach Lilypad's final binaries or
    // test harnesses. ScreenCaptureKit links Swift Concurrency as @rpath, so the
    // final artifact must carry the system Swift runtime search path itself.
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

    tauri_build::build()
}
