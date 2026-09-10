//! Provider resolution, off the session's event path (L-271).
//!
//! Resolving a provider means reading the macOS keychain, and reading the
//! keychain means `security(1)`, which can sit for as long as a person leaves
//! an authorization dialog on screen — or forever, on a locked keychain nobody
//! is looking at. That call used to happen inline in the controller's command
//! handler. While it waited, the controller handled nothing else: not the
//! heartbeat that keeps the session alive, not input, and not Stop. The one
//! control a person reaches for when something looks wrong was behind the
//! thing that was wrong.
//!
//! So the keychain is never touched on the caller's thread. A refresh runs on
//! the blocking pool under a deadline and publishes a typed outcome; callers
//! read the last published answer, which is always immediate. The outcomes are
//! deliberately distinct — "nothing is set up" and "the keychain did not
//! answer" need different words in front of a person, and collapsing them into
//! `Option::None` is how the second one became invisible.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::{store::AgentSettings, ProviderChoice};

/// How long a resolution is trusted before it is refreshed. Short, because the
/// person may have just added a key in another window; long enough that a
/// burst of commands does not mean a burst of keychain reads.
const FRESH_FOR: Duration = Duration::from_secs(20);

/// How long the keychain gets to answer before the attempt is abandoned.
/// Abandoning is safe: the task is on the blocking pool and its result is
/// simply discarded, and the next refresh tries again.
const KEYCHAIN_DEADLINE: Duration = Duration::from_secs(5);

/// What the last completed resolution found.
#[derive(Debug, Clone)]
pub enum Readiness {
    /// No resolution has completed yet.
    Unknown,
    Ready(Box<ProviderChoice>),
    /// Settings name no provider, or name one with no usable credential.
    NotConfigured,
    /// The secret store could not be consulted — locked, denied, or too slow.
    Unavailable(String),
}

impl Readiness {
    pub fn is_ready(&self) -> bool {
        matches!(self, Readiness::Ready(_))
    }
}

struct Cached {
    readiness: Readiness,
    /// Non-secret settings the cached answer belongs to. When these change the
    /// answer is about a different destination and must not be reused (L-262).
    fingerprint: AgentSettings,
    at: Option<Instant>,
    in_flight: bool,
}

/// Shared, cheap to clone, safe to read from the session event path.
#[derive(Clone)]
pub struct ProviderResolver {
    inner: Arc<Mutex<Cached>>,
}

impl Default for ProviderResolver {
    fn default() -> Self {
        ProviderResolver {
            inner: Arc::new(Mutex::new(Cached {
                readiness: Readiness::Unknown,
                fingerprint: AgentSettings::default(),
                at: None,
                in_flight: false,
            })),
        }
    }
}

impl ProviderResolver {
    pub fn new() -> Self {
        Self::default()
    }

    /// The last published answer. Never blocks, never touches the keychain.
    ///
    /// Reading the settings file is a small local read and is done here so a
    /// changed destination invalidates immediately rather than after the TTL.
    pub fn peek(&self) -> Readiness {
        let settings = super::store::load_settings();
        let mut cached = self.inner.lock().unwrap();
        let stale = cached.fingerprint != settings
            || cached.at.is_none_or(|at| at.elapsed() > FRESH_FOR);
        if cached.fingerprint != settings {
            cached.readiness = Readiness::Unknown;
            cached.fingerprint = settings;
            cached.at = None;
        }
        let readiness = cached.readiness.clone();
        let should_start = stale && !cached.in_flight;
        if should_start {
            cached.in_flight = true;
        }
        drop(cached);
        if should_start {
            self.spawn_refresh();
        }
        readiness
    }

    /// Start a resolution now if one is not already running. Call this when a
    /// session opens, so the answer is usually there before it is needed.
    pub fn warm(&self) {
        let _ = self.peek();
    }

    fn spawn_refresh(&self) {
        let inner = Arc::clone(&self.inner);
        // `spawn` needs a runtime; outside one (unit tests constructing a
        // resolver directly) there is nothing to refresh onto and the cached
        // answer stays `Unknown`, which is the honest value.
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            inner.lock().unwrap().in_flight = false;
            return;
        };
        handle.spawn(async move {
            let resolved = tokio::time::timeout(
                KEYCHAIN_DEADLINE,
                tokio::task::spawn_blocking(ProviderChoice::resolve),
            )
            .await;
            let readiness = match resolved {
                Ok(Ok(Some(choice))) => Readiness::Ready(Box::new(choice)),
                Ok(Ok(None)) => Readiness::NotConfigured,
                Ok(Err(join)) => Readiness::Unavailable(format!(
                    "checking the saved AI settings failed: {join}"
                )),
                Err(_) => Readiness::Unavailable(
                    "The macOS keychain did not answer. If a permission box is waiting on the \
                     Mac, allow it, then try again."
                        .to_string(),
                ),
            };
            let mut cached = inner.lock().unwrap();
            cached.readiness = readiness;
            cached.at = Some(Instant::now());
            cached.in_flight = false;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_first_look_is_unknown_and_never_blocks() {
        // The property under test is the one L-271 broke: asking costs nothing
        // on the caller's thread, whatever the keychain is doing.
        let resolver = ProviderResolver::new();
        let start = Instant::now();
        let first = resolver.peek();
        assert!(
            matches!(first, Readiness::Unknown),
            "a resolution cannot already have completed"
        );
        assert!(
            start.elapsed() < Duration::from_millis(50),
            "peek blocked for {:?}",
            start.elapsed()
        );
    }

    #[tokio::test]
    async fn a_refresh_eventually_publishes_an_answer() {
        let resolver = ProviderResolver::new();
        resolver.warm();
        // Whatever this machine's settings say, a completed resolution must
        // stop being `Unknown` — including on a Mac with nothing configured,
        // where the answer is `NotConfigured` rather than silence.
        for _ in 0..100 {
            if !matches!(resolver.peek(), Readiness::Unknown) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("no resolution was published within 5s");
    }

    #[test]
    fn outside_a_runtime_the_answer_stays_unknown_rather_than_blocking() {
        let resolver = ProviderResolver::new();
        assert!(matches!(resolver.peek(), Readiness::Unknown));
        assert!(!resolver.inner.lock().unwrap().in_flight);
    }
}
