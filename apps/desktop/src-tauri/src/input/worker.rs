//! `InputWorker` — dedicated OS thread hosting the [`InputDispatcher`], kept
//! off the async runtime since CGEvent/SendInput calls are blocking syscalls.
//! Revocation also invalidates queued input; dispatcher gates alone cannot
//! revoke events already waiting ahead of a queued `SetEnabled(false)`.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;

use super::{
    create_input_backend, decode_input_batch, InputBackend, InputDispatcher, InputMetrics,
    PermissionStatus, Scope,
};

enum Msg {
    Bytes { generation: u64, bytes: Vec<u8> },
    SetEnabled(bool),
    ResetPeer,
    SetScopes(HashSet<Scope>),
    SetTargetDisplay(Option<u32>),
    Shutdown,
}

/// Queue depth: generous enough to absorb a burst of coalesced pointer_move
/// batches without ever meaningfully throttling real user input.
const QUEUE_CAPACITY: usize = 256;

pub struct InputWorker {
    tx: SyncSender<Msg>,
    handle: Option<JoinHandle<()>>,
    metrics: Arc<InputMetrics>,
    /// Odd = enabled, even = revoked. A new grant never revives old input.
    authority: Arc<AtomicU64>,
}

impl InputWorker {
    pub fn spawn() -> Self {
        Self::spawn_with_backend(create_input_backend)
    }

    fn spawn_with_backend(
        factory: impl FnOnce() -> Box<dyn InputBackend> + Send + 'static,
    ) -> Self {
        let metrics = Arc::new(InputMetrics::default());
        let (tx, rx) = sync_channel::<Msg>(QUEUE_CAPACITY);
        let worker_metrics = Arc::clone(&metrics);
        let authority = Arc::new(AtomicU64::new(0));
        let worker_authority = Arc::clone(&authority);

        let handle = std::thread::Builder::new()
            .name("lilypad-input".into())
            .spawn(move || {
                let mut backend = factory();
                // Must initialize before use: the macOS backend refuses to
                // create a CGEventSource (and therefore drops every event)
                // until initialize() has run. Permission is a separate gate.
                if let Err(e) = backend.initialize() {
                    log::error!(
                        target: "lilypad::input",
                        "input backend failed to initialize — injection disabled this session: {e}"
                    );
                }
                let mut dispatcher = InputDispatcher::new(backend, Arc::clone(&worker_metrics));

                match dispatcher.permission_status() {
                    PermissionStatus::NotGranted => log::warn!(
                        target: "lilypad::input",
                        "input injection permission not granted — events will be dropped until granted \
                         (macOS: System Settings ▸ Privacy & Security ▸ Accessibility)"
                    ),
                    PermissionStatus::Granted => {
                        log::info!(target: "lilypad::input", "input backend ready, permission granted")
                    }
                    PermissionStatus::NotApplicable => {}
                }

                while let Ok(msg) = rx.recv() {
                    match msg {
                        Msg::Bytes { generation, bytes } => {
                            worker_metrics.queue_depth.fetch_sub(1, Ordering::Relaxed);
                            match decode_input_batch(&bytes) {
                                Ok(batch) => {
                                    for event in batch.events {
                                        // Revocation takes effect without waiting for
                                        // SetEnabled to reach the front of this queue.
                                        if generation % 2 == 0 || worker_authority.load(Ordering::Acquire) != generation {
                                            worker_metrics.events_dropped_gated.fetch_add(1, Ordering::Relaxed);
                                            continue;
                                        }
                                        dispatcher.process_event(event);
                                    }
                                }
                                Err(e) => {
                                    worker_metrics.events_dropped_invalid.fetch_add(1, Ordering::Relaxed);
                                    log::warn!(target: "lilypad::input", "invalid input frame: {e}");
                                }
                            }
                        }
                        Msg::SetEnabled(enabled) => dispatcher.set_enabled(enabled),
                        Msg::ResetPeer => dispatcher.reset_peer(),
                        Msg::SetScopes(scopes) => dispatcher.set_scopes(scopes),
                        Msg::SetTargetDisplay(id) => dispatcher.set_target_display(id),
                        Msg::Shutdown => break,
                    }
                }
                dispatcher.shutdown();
                log::info!(target: "lilypad::input", "input worker stopped: {:?}", worker_metrics.snapshot());
            })
            .expect("failed to spawn lilypad-input thread");

        Self {
            tx,
            handle: Some(handle),
            metrics,
            authority,
        }
    }

    /// Feed one raw DataChannel frame (phone → desktop input batch). Drops
    /// the frame (counted, logged) if the worker is backed up.
    pub fn handle_message(&self, bytes: Vec<u8>) {
        let generation = self.authority.load(Ordering::Acquire);
        self.metrics.queue_depth.fetch_add(1, Ordering::Relaxed);
        match self.tx.try_send(Msg::Bytes { generation, bytes }) {
            Ok(()) => {}
            Err(_) => {
                self.metrics.queue_depth.fetch_sub(1, Ordering::Relaxed);
                self.metrics
                    .events_dropped_invalid
                    .fetch_add(1, Ordering::Relaxed);
                log::warn!(target: "lilypad::input", "input queue full — dropping frame");
            }
        }
    }

    /// Gate injection on/off (Connected + DataChannel-open on, everything
    /// else off). Safe to call repeatedly with the same value.
    pub fn set_enabled(&self, enabled: bool) {
        let _ = self
            .authority
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |generation| {
                ((generation % 2 == 1) != enabled).then(|| generation.wrapping_add(1))
            });
        let _ = self.tx.send(Msg::SetEnabled(enabled));
    }

    pub fn reset_peer(&self) {
        // Invalidate old queued bytes immediately; reset the dispatcher before
        // any enable/new-peer frame subsequently enters this ordered queue.
        self.set_enabled(false);
        let _ = self.tx.send(Msg::ResetPeer);
    }

    /// Update the granted-scope set for the current session (from
    /// `session-start`'s `grantedScopes`) — independent of `set_enabled`, so
    /// a session that is connected with an open DataChannel but was only
    /// granted `view` still has every control-plane event rejected at
    /// `InputDispatcher::process_batch`.
    pub fn set_scopes(&self, scopes: HashSet<Scope>) {
        let _ = self.tx.send(Msg::SetScopes(scopes));
    }

    /// Follow the session's display switch, so taps keep landing on the screen
    /// the phone is actually looking at.
    pub fn set_target_display(&self, display_id: Option<u32>) {
        let _ = self.tx.send(Msg::SetTargetDisplay(display_id));
    }

    pub fn metrics(&self) -> Arc<InputMetrics> {
        Arc::clone(&self.metrics)
    }
}

impl Drop for InputWorker {
    fn drop(&mut self) {
        self.set_enabled(false);
        let _ = self.tx.send(Msg::Shutdown);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{KeyAction, Modifier, MouseAction, ScrollAction};
    use super::*;
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::time::Duration;

    struct BlockingBackend {
        injected: Sender<String>,
        resume: Receiver<()>,
    }

    impl InputBackend for BlockingBackend {
        fn initialize(&mut self) -> anyhow::Result<()> {
            Ok(())
        }
        fn permission_status(&self) -> PermissionStatus {
            PermissionStatus::Granted
        }
        fn primary_modifier(&self) -> Modifier {
            Modifier::Ctrl
        }
        fn inject_mouse(&mut self, _: MouseAction) -> anyhow::Result<()> {
            Ok(())
        }
        fn inject_keyboard(&mut self, _: KeyAction) -> anyhow::Result<()> {
            Ok(())
        }
        fn inject_scroll(&mut self, _: ScrollAction) -> anyhow::Result<()> {
            Ok(())
        }
        fn inject_text(&mut self, text: &str) -> anyhow::Result<()> {
            self.injected.send(text.into())?;
            if text == "in-flight" {
                self.resume.recv_timeout(Duration::from_secs(5))?;
            }
            Ok(())
        }
        fn set_clipboard(&mut self, _: &str) -> anyhow::Result<()> {
            Ok(())
        }
        fn shutdown(&mut self) -> anyhow::Result<()> {
            Ok(())
        }
    }

    fn input(texts: &[&str]) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "kind": "input_batch",
            "events": texts.iter().map(|text| serde_json::json!({
                "kind": "text_input", "text": text, "ts": 1
            })).collect::<Vec<_>>()
        }))
        .unwrap()
    }

    #[test]
    fn peer_replacement_discards_queued_input_and_accepts_the_new_sequence() {
        let (injected_tx, injected_rx) = channel();
        let (resume_tx, resume_rx) = channel();
        let worker = InputWorker::spawn_with_backend(move || {
            Box::new(BlockingBackend {
                injected: injected_tx,
                resume: resume_rx,
            })
        });
        let input = |text: &str, seq: u64| {
            serde_json::to_vec(&serde_json::json!({
            "kind": "input_batch", "events": [{"kind": "text_input", "text": text, "ts": 1, "seq": seq}]
        })).unwrap()
        };
        worker.set_scopes(HashSet::from([Scope::Control]));
        worker.set_enabled(true);
        worker.handle_message(input("in-flight", 100));
        assert_eq!(
            injected_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            "in-flight"
        );
        worker.handle_message(input("stale", 101));
        worker.reset_peer();
        worker.set_enabled(true);
        worker.handle_message(input("new-peer", 1));
        resume_tx.send(()).unwrap();
        assert_eq!(
            injected_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            "new-peer"
        );
        drop(worker);
        assert!(injected_rx.try_recv().is_err());
    }

    #[test]
    fn revocation_discards_old_batches_and_remaining_events_even_after_reenable() {
        let (injected_tx, injected_rx) = channel();
        let (resume_tx, resume_rx) = channel();
        let worker = InputWorker::spawn_with_backend(move || {
            Box::new(BlockingBackend {
                injected: injected_tx,
                resume: resume_rx,
            })
        });
        worker.set_scopes(HashSet::from([Scope::Control]));
        worker.set_enabled(true);
        worker.handle_message(input(&["in-flight", "stale-in-batch"]));
        assert_eq!(
            injected_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            "in-flight"
        );
        worker.handle_message(input(&["stale-queued-batch"]));
        worker.set_enabled(false);
        worker.set_enabled(true);
        worker.handle_message(input(&["new-controller"]));
        resume_tx.send(()).unwrap();
        // An OS call already in progress cannot be undone. Nothing else from
        // the revoked controller may run, including after a quick reconnect.
        assert_eq!(
            injected_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            "new-controller"
        );
        drop(worker);
        assert!(injected_rx.try_recv().is_err());
    }
}
