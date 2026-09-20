//! Provider resolution, off the session's event path and bounded (L-271, L-278).
//!
//! Resolving means reading the macOS keychain, and reading the keychain means
//! `security(1)`, which can sit for as long as a person leaves an authorization
//! dialog on screen — or forever, on a locked keychain nobody is looking at.
//! That call used to happen inline in the controller's command handler. While
//! it waited, the controller handled nothing else: not the heartbeat that keeps
//! the session alive, not input, and not Stop. The one control a person reaches
//! for when something looks wrong was behind the thing that was wrong.
//!
//! ### What the first version of this file got wrong
//!
//! It moved the work to `spawn_blocking` under a `tokio::time::timeout`, and
//! called that bounded. It is not. Timing out a join **abandons** the task; the
//! `security` process is still there, still holding whatever it was holding,
//! and the next refresh starts another one. A permanently blocked secret store
//! would accumulate one stuck process and one stuck pool thread per refresh
//! until the blocking pool was full — at which point every other
//! `spawn_blocking` in the process, including the sandbox's, stops too. A
//! deadline that abandons work is a deadline on *waiting*, not on the work.
//!
//! It also published unconditionally. A resolution of provider A could finish
//! after the settings changed to B and install `Ready(A)` with a fresh
//! timestamp, so the next twenty seconds of requests used A while the phone had
//! been told B (L-278).
//!
//! So: exactly **one** worker thread for the whole process, which does its own
//! subprocess reaping, and a published answer that carries the generation it
//! was resolved for and is discarded if that generation is no longer current.
//!
//! ### The generation has to come from the read, not from the request
//!
//! The second version of this file took the epoch at `peek()` time and passed
//! it down with the job. That still admitted the defect it was meant to close:
//! `save_settings` bumped the epoch *before* writing the file, so a worker
//! starting in that gap read the OLD provider under the NEW epoch and published
//! it as current. The generation is now captured by `store::load_committed()`
//! in the same critical section as the file read, and the write bumps it only
//! after the new contents are committed — so a published generation always
//! describes the bytes the answer was built from.

use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::effective::EffectiveConfig;
use super::{anthropic, jev, openai_compat, ProviderChoice};
use crate::agent::protocol::{AgentDestination, InstantDestination};

/// How long a resolution is trusted before it is refreshed. Short, because the
/// person may have just added a key in another window; long enough that a burst
/// of commands does not mean a burst of keychain reads.
const FRESH_FOR: Duration = Duration::from_secs(20);

// The secret store's own deadline lives in `store::SECRET_STORE_DEADLINE`,
// applied per `security(1)` invocation by killing and reaping the child. It is
// deliberately not enforced here: a timeout at this level could only abandon
// the work, which is what the first version of this file did wrong.

/// What the last completed resolution found.
#[derive(Debug, Clone)]
pub enum Readiness {
    /// No resolution has completed yet.
    Unknown,
    Ready(Box<Resolved>),
    /// Settings name no provider, or name one with no usable credential.
    NotConfigured,
    /// The secret store could not be consulted — locked, denied, or too slow.
    Unavailable(String),
}

/// Who runs a task on this Mac (ADR-0020).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    /// The AI provider the person configured, with instant actions in front
    /// of it when a TypeSafe key is set.
    Model,
    /// Lilypad's own loop: one System One model carries the whole task, and
    /// no language model is asked anything.
    Lilypad,
}

/// A usable way to run a task, plus the exact configuration it came from.
#[derive(Debug, Clone)]
pub struct Resolved {
    /// The language model, when one runs the task. `None` under
    /// [`Engine::Lilypad`], where there is no language model at all.
    pub choice: Option<ProviderChoice>,
    pub config: EffectiveConfig,
    /// Instant actions in front of the model (ADR-0019). Always `None` under
    /// [`Engine::Lilypad`], where every step is already the System One model.
    pub instant: Option<jev::InstantConfig>,
    pub engine: Engine,
    /// The System One client's configuration, under [`Engine::Lilypad`].
    pub jev: Option<jev::InstantConfig>,
}

impl Resolved {
    /// What the phone is told: the model's destination, and the instant
    /// step's beside it when that is on.
    pub fn destination(&self) -> AgentDestination {
        let mut destination = self.config.destination();
        if self.engine == Engine::Lilypad {
            // The System One model is the destination, not a step in front of
            // one: `config` already describes it.
            return destination;
        }
        destination.instant = self.instant.as_ref().map(|i| {
            let origin = i.origin();
            Box::new(InstantDestination {
                provider_name: jev::PROVIDER_NAME.to_string(),
                consent_revision: self.config.instant_revision(&origin, &i.model),
                origin,
                model: i.model.clone(),
            })
        });
        destination
    }

    /// What runs a task here, in words for the log — the engine's own file
    /// never names a vendor.
    pub fn how(&self) -> String {
        match self.engine {
            Engine::Model => self.config.provider_name.clone(),
            Engine::Lilypad => format!("{} (one step at a time)", self.config.provider_name),
        }
    }

    /// Which disclosure a command's echoed revision agreed to:
    /// `Some(false)` the model's destination alone, `Some(true)` that and
    /// instant actions, `None` neither — a command for a configuration that
    /// is no longer in force (L-265).
    pub fn agreed(&self, revision: Option<&str>) -> Option<bool> {
        let revision = revision?;
        if revision == self.config.consent_revision {
            return Some(false);
        }
        if self.engine == Engine::Lilypad {
            // One destination, one revision: there is nothing else to agree
            // to, so a different revision is a configuration that moved.
            return None;
        }
        let with_instant = self.destination().instant?.consent_revision;
        (revision == with_instant).then_some(true)
    }
}

/// How this Mac reaches Lilypad's own account (ADR-0020): the control plane's
/// base URL, and a way to get a device token for it.
///
/// Registered once at startup by `lib.rs`, which is where `DesktopAuth` is
/// built. A `OnceLock` rather than a parameter because the resolver runs on
/// its own worker thread with no Tauri state and no app handle — and because
/// `agent/llm` has no business knowing what a `DesktopAuth` is. What it needs
/// is a function that returns a bearer.
static HOSTED: std::sync::OnceLock<(String, jev::BearerSource)> = std::sync::OnceLock::new();

/// Tell the resolver how to reach Lilypad's own account. Idempotent; a second
/// call is ignored, because two answers to "where is the control plane" is a
/// wiring bug and the first one is the one already in use.
pub fn register_hosted(base_url: String, bearer: jev::BearerSource) {
    let _ = HOSTED.set((base_url, bearer));
}

/// The hosted System One configuration, when this build has been wired for
/// one. `None` means the tier cannot run here — which the engine choice says
/// out loud rather than failing at the first step of a task.
pub fn hosted_jev() -> Option<jev::InstantConfig> {
    let (base_url, bearer) = HOSTED.get()?;
    Some(jev::InstantConfig::hosted(base_url.clone(), bearer.clone()))
}

/// The instant-actions key: the developer override, else the keychain. A
/// keychain that will not answer means no instant actions, never no Ask.
fn resolve_instant() -> Option<jev::InstantConfig> {
    if let Some(config) = jev::InstantConfig::from_env() {
        return Some(config);
    }
    match super::store::credential_for(jev::KEY_KIND, None) {
        Ok(key) => key.map(jev::InstantConfig::new),
        Err(e) => {
            log::warn!(target: "lilypad::agent", "instant actions unavailable: {e}");
            None
        }
    }
}

impl Readiness {
    pub fn is_ready(&self) -> bool {
        matches!(self, Readiness::Ready(_))
    }
}

/// Bumped whenever something invalidates the cached answer: a settings write, a
/// disconnect, a key replacement. A resolution that started before the bump may
/// not publish after it.
static EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// Tell every resolver that what it knows is out of date.
///
/// Called on any write that could change where requests go or which credential
/// is used — including a key rotation, which no settings-file comparison would
/// notice (L-278).
pub fn invalidate() {
    EPOCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

/// The current committed generation. Read under the settings lock by
/// `store::load_committed`, so an answer and its generation agree.
pub fn epoch() -> u64 {
    EPOCH.load(std::sync::atomic::Ordering::SeqCst)
}

/// The generation is one process-wide counter, as it is in production. Tests
/// that assert on it have to take turns, wherever they live.
#[cfg(test)]
pub(crate) fn epoch_test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

struct Cached {
    readiness: Readiness,
    /// The epoch the cached answer was resolved under.
    epoch: u64,
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
                epoch: 0,
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

    /// The last published answer. Never blocks, never touches the keychain, and
    /// never touches the filesystem.
    ///
    /// Reading the settings file here was the remaining synchronous I/O on the
    /// session path; it now happens on the worker, and staleness is decided by
    /// the epoch counter instead.
    pub fn peek(&self) -> Readiness {
        let now_epoch = epoch();
        let mut cached = self.inner.lock().unwrap();
        if cached.epoch != now_epoch {
            // Something changed. What we know describes a configuration that is
            // no longer in force, so it is not an answer about the current one.
            cached.readiness = Readiness::Unknown;
            cached.at = None;
        }
        let stale = cached.at.is_none_or(|at| at.elapsed() > FRESH_FOR);
        let readiness = cached.readiness.clone();
        let should_start = stale && !cached.in_flight;
        if should_start {
            cached.in_flight = true;
        }
        drop(cached);
        if should_start {
            self.request_refresh();
        }
        readiness
    }

    /// Start a resolution now if one is not already running. Call this when a
    /// session opens, so the answer is usually there before it is needed.
    pub fn warm(&self) {
        let _ = self.peek();
    }

    fn request_refresh(&self) {
        let inner = Arc::clone(&self.inner);
        let job = Job {
            reply: Box::new(move |readiness, resolved_epoch| {
                let mut cached = inner.lock().unwrap();
                cached.in_flight = false;
                // L-278: publish only if this answer is still about the
                // configuration that is current. Otherwise drop it; `peek` will
                // ask again.
                if resolved_epoch == epoch() {
                    cached.readiness = readiness;
                    cached.epoch = resolved_epoch;
                    cached.at = Some(Instant::now());
                }
            }),
        };
        if let Err(rejected) = worker().try_send(job) {
            // The queue is one deep on purpose: a second pending resolution
            // would answer the same question. Mark the attempt finished so the
            // next `peek` can try again rather than believing one is running.
            let job = match rejected {
                TrySendError::Full(job) | TrySendError::Disconnected(job) => job,
            };
            (job.reply)(
                Readiness::Unavailable(
                    "Lilypad is still checking the saved AI settings. Try again in a moment."
                        .to_string(),
                ),
                0, // never current, so this is not cached as an answer
            );
            let mut cached = self.inner.lock().unwrap();
            cached.in_flight = false;
        }
    }
}

type Reply = Box<dyn FnOnce(Readiness, u64) + Send>;

struct Job {
    reply: Reply,
}

/// The single resolver worker for the whole process.
///
/// One thread, one queue slot. However many sessions, controllers or settings
/// screens ask, there is never more than one `security(1)` child alive, so a
/// secret store that never answers costs one blocked thread rather than a
/// growing pile of them.
fn worker() -> &'static SyncSender<Job> {
    static WORKER: OnceLock<SyncSender<Job>> = OnceLock::new();
    WORKER.get_or_init(|| {
        let (tx, rx) = sync_channel::<Job>(1);
        std::thread::Builder::new()
            .name("lilypad-provider-resolver".into())
            .spawn(move || {
                while let Ok(job) = rx.recv() {
                    let (readiness, committed) = resolve_once();
                    (job.reply)(readiness, committed);
                }
            })
            .expect("spawn provider resolver worker");
        tx
    })
}

/// Resolve on the worker thread, with the keychain call bounded by killing it.
///
/// Returns the answer and the committed generation it describes. Both come
/// from one `load_committed()` read, so nothing here can attribute an answer to
/// a generation it did not come from (L-278).
fn resolve_once() -> (Readiness, u64) {
    let (settings, committed) = super::store::load_committed();
    // The deadline lives inside the keychain calls themselves, where it can
    // kill the process it is a deadline for — see `store::wait_bounded`.
    // Lilypad's own loop needs no language model, so it resolves on its own
    // terms (ADR-0020): a System One key, and the destination that names it.
    let engine = super::store::engine_of(&settings);
    if super::store::engine_is_system_one(engine) {
        // Two ways to run the same loop, and the difference is the whole of
        // ADR-0020: `lilypad` is Lilypad's own account, reached through the
        // control plane on this device's token, with no System One key on
        // this Mac at all; `typesafe` is the person's own key, posted
        // straight to TypeSafe, free, with no backend in the path.
        let config = if engine == super::store::ENGINE_LILYPAD {
            hosted_jev().and_then(|jev| {
                EffectiveConfig::for_hosted_jev(committed, jev.base_url.clone())
                    .map(|config| (config, jev))
            })
        } else {
            resolve_instant().and_then(|jev| {
                EffectiveConfig::for_jev(
                    committed,
                    if jev::InstantConfig::from_env().is_some() {
                        super::effective::ConfigSource::Environment
                    } else {
                        super::effective::ConfigSource::Settings
                    },
                    jev.base_url.clone(),
                    jev.own_key().unwrap_or_default(),
                    jev::PROVIDER_NAME,
                )
                .map(|config| (config, jev))
            })
        };
        let readiness = match config {
            Some((config, jev)) => Readiness::Ready(Box::new(Resolved {
                choice: None,
                config,
                instant: None,
                engine: Engine::Lilypad,
                jev: Some(jev),
            })),
            None => Readiness::NotConfigured,
        };
        return (readiness, committed);
    }
    let readiness = match EffectiveConfig::resolve_from(&settings, committed) {
        Err(unavailable) => Readiness::Unavailable(unavailable.0),
        Ok(None) => Readiness::NotConfigured,
        Ok(Some((config, key))) => match build_choice(&settings, &config, key) {
            Some(choice) => Readiness::Ready(Box::new(Resolved {
                choice: Some(choice),
                config,
                instant: resolve_instant(),
                engine: Engine::Model,
                jev: None,
            })),
            None => Readiness::NotConfigured,
        },
    };
    (readiness, committed)
}

fn build_choice(
    settings: &super::store::AgentSettings,
    config: &EffectiveConfig,
    key: String,
) -> Option<ProviderChoice> {
    let vision = super::store::effective_vision(settings);
    // A blank model means the preset's own default, decided per provider
    // (L-292) — never the dialect's. Falling back to the dialect default sent
    // `gpt-4o-mini` to Gemini and every other OpenAI-compatible endpoint whose
    // model field was left empty. No default at all is a configuration that
    // cannot run, and says so rather than guessing.
    let model = match config.model.clone() {
        Some(model) => model,
        None => super::presets::default_model_for(
            settings.profile_id.as_deref(),
            config.dialect,
            settings.base_url.as_deref(),
        )?
        .to_string(),
    };
    match config.dialect {
        "anthropic" => {
            let mut c = anthropic::AnthropicConfig::new(key, model);
            c.base_url = config.base_url.clone();
            c.vision = vision;
            Some(ProviderChoice::Anthropic(c))
        }
        "openai_compat" => {
            let mut c = openai_compat::OpenAiCompatConfig::new(
                if key.is_empty() { "none".into() } else { key },
                model,
            );
            c.base_url = config.base_url.clone();
            c.vision = vision;
            c.grid = openai_compat::parse_grid(settings.grid.as_deref());
            Some(ProviderChoice::OpenAiCompat(c))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_first_look_is_unknown_and_never_blocks() {
        // The property L-271 broke: asking costs nothing on the caller's
        // thread, whatever the keychain is doing.
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

    // Takes a turn for the same reason the two tests below do. This one
    // asserts that an answer *is* published, and `peek` reports `Unknown` for
    // any answer whose generation is no longer current — so any test that
    // writes settings while this one polls (every write bumps the epoch)
    // discards the answer this test is waiting for. Measured: with a thread
    // calling `invalidate()` every 5ms, this test never sees a published
    // answer at all. That is the L-278 rule working, not a resolver defect,
    // and the fix is to take the turn rather than to poll for longer.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_refresh_eventually_publishes_an_answer() {
        let _turn = epoch_test_lock();
        let resolver = ProviderResolver::new();
        resolver.warm();
        for _ in 0..200 {
            if !matches!(resolver.peek(), Readiness::Unknown) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("no resolution was published within 10s");
    }

    // The epoch is process-wide, so this test holds the turn lock across its
    // own polling sleeps; that is the point of the lock, not a mistake.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn invalidating_discards_what_was_known() {
        let _turn = epoch_test_lock();
        let resolver = ProviderResolver::new();
        resolver.warm();
        for _ in 0..200 {
            if !matches!(resolver.peek(), Readiness::Unknown) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        invalidate();
        // L-278: an answer resolved under the previous epoch is not an answer
        // about the current one, however recent it is.
        assert!(matches!(resolver.peek(), Readiness::Unknown));
    }

    #[test]
    fn a_stale_generation_is_discarded_rather_than_published() {
        let _turn = epoch_test_lock();
        // The exact shape of L-278: a resolution of A completes after the
        // configuration has moved on to B.
        let resolver = ProviderResolver::new();
        let stale_epoch = epoch();
        invalidate(); // the world moved on while "A" was in flight
        {
            let mut cached = resolver.inner.lock().unwrap();
            cached.in_flight = true;
        }
        // Deliver A's answer under the epoch it started in.
        let inner = Arc::clone(&resolver.inner);
        let reply: Reply = Box::new(move |readiness, resolved_epoch| {
            let mut cached = inner.lock().unwrap();
            cached.in_flight = false;
            if resolved_epoch == epoch() {
                cached.readiness = readiness;
                cached.epoch = resolved_epoch;
                cached.at = Some(Instant::now());
            }
        });
        reply(
            Readiness::Unavailable("stale answer about A".into()),
            stale_epoch,
        );
        let cached = resolver.inner.lock().unwrap();
        assert!(
            matches!(cached.readiness, Readiness::Unknown),
            "a resolution from a previous epoch was published"
        );
        assert!(cached.at.is_none());
    }

    /// ADR-0019: instant actions are a second destination. A command agrees
    /// to the model's destination alone, or to both — and a phone that only
    /// ever showed the first can never switch the second on.
    #[test]
    fn a_command_agrees_to_the_model_alone_or_to_both_and_nothing_else() {
        let config = EffectiveConfig::draft(
            "openai_compat",
            None,
            "https://api.openai.com/v1".into(),
            Some("m".into()),
            Some("k".into()),
        )
        .unwrap();
        let choice = ProviderChoice::OpenAiCompat(openai_compat::OpenAiCompatConfig::new("k", "m"));
        let base = config.consent_revision.clone();
        let without = Resolved {
            choice: Some(choice),
            config,
            instant: None,
            engine: Engine::Model,
            jev: None,
        };
        assert!(without.destination().instant.is_none());
        assert_eq!(without.agreed(Some(&base)), Some(false));
        assert_eq!(without.agreed(Some("something else")), None);
        assert_eq!(without.agreed(None), None);

        let with = Resolved {
            instant: Some(jev::InstantConfig::new("ts_key")),
            ..without.clone()
        };
        let shown = with.destination().instant.expect("disclosed");
        assert_eq!(shown.origin, "https://api.typesafe.ai");
        assert_eq!(shown.provider_name, jev::PROVIDER_NAME);
        assert_ne!(shown.consent_revision, base);
        assert_eq!(with.agreed(Some(&shown.consent_revision)), Some(true));
        assert_eq!(
            with.agreed(Some(&base)),
            Some(false),
            "a phone that showed only the model's destination"
        );
        // The revision for both is not accepted once instant actions are off.
        assert_eq!(without.agreed(Some(&shown.consent_revision)), None);
        // Rotating the key is not a new destination.
        let rotated = Resolved {
            instant: Some(jev::InstantConfig::new("ts_other")),
            ..without
        };
        assert_eq!(
            rotated.destination().instant.unwrap().consent_revision,
            shown.consent_revision
        );
        // On the wire: camelCase, and absent when off.
        let wire = serde_json::to_value(with.destination()).unwrap();
        assert_eq!(wire["instant"]["origin"], "https://api.typesafe.ai");
        assert!(wire["instant"]["consentRevision"].is_string());
        let wire = serde_json::to_value(
            Resolved {
                instant: None,
                ..with
            }
            .destination(),
        )
        .unwrap();
        assert!(wire.get("instant").is_none());
    }

    /// L-292, again: the resolver kept a dialect-wide fallback after
    /// `ProviderChoice::from_settings` lost it, so a Gemini preset with an
    /// empty model field ran every task against `gpt-4o-mini`.
    #[test]
    fn a_blank_model_takes_the_presets_default_or_does_not_run() {
        use super::super::store::AgentSettings;
        let settings = |profile: &str, base: &str| AgentSettings {
            provider_kind: Some("openai_compat".into()),
            profile_id: Some(profile.into()),
            base_url: Some(base.into()),
            model: None,
            ..Default::default()
        };
        let config = |s: &AgentSettings| {
            EffectiveConfig::draft(
                "openai_compat",
                s.profile_id.clone(),
                s.base_url.clone().unwrap(),
                None,
                Some("k".into()),
            )
            .unwrap()
        };
        let gemini = settings(
            "gemini",
            "https://generativelanguage.googleapis.com/v1beta/openai",
        );
        match build_choice(&gemini, &config(&gemini), "k".into()) {
            None => {}
            Some(ProviderChoice::OpenAiCompat(c)) => {
                assert_ne!(
                    c.model,
                    openai_compat::DEFAULT_MODEL,
                    "another vendor's default"
                )
            }
            Some(other) => panic!("{other:?}"),
        }
        let openai = settings("openai", "https://api.openai.com/v1");
        match build_choice(&openai, &config(&openai), "k".into()) {
            Some(ProviderChoice::OpenAiCompat(c)) => {
                assert_eq!(c.model, openai_compat::DEFAULT_MODEL)
            }
            other => panic!("{other:?}"),
        }
    }
}
