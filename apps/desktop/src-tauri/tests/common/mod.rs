//! Shared hooks for integration tests.

#[ctor::ctor]
fn init_rustls_crypto_provider() {
    lilypad_desktop_lib::lan::ensure_crypto_provider();
}
