//! `InputWorker` — dedicated OS thread hosting the [`InputDispatcher`], kept
//! off the async runtime since CGEvent/SendInput calls are blocking syscalls.
//! This is the thin, deliberately-untested glue; all real logic lives in
//! [`super::dispatcher::InputDispatcher`], which is unit-tested directly.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;

use super::{
    create_input_backend, decode_input_batch, InputDispatcher, InputMetrics, PermissionStatus,
    Scope,
};

enum Msg {
    Bytes(Vec<u8>),
    SetEnabled(bool),
    SetScopes(HashSet<Scope>),
    Shutdown,
}

/// Queue depth: generous enough to absorb a burst of coalesced pointer_move
/// batches without ever meaningfully throttling real user input.
const QUEUE_CAPACITY: usize = 256;

pub struct InputWorker {
    tx: SyncSender<Msg>,
    handle: Option<JoinHandle<()>>,
    metrics: Arc<InputMetrics>,
}

impl InputWorker {
    pub fn spawn() -> Self {
        let metrics = Arc::new(InputMetrics::default());
        let (tx, rx) = sync_channel::<Msg>(QUEUE_CAPACITY);
        let worker_metrics = Arc::clone(&metrics);

        let handle = std::thread::Builder::new()
            .name("lilypad-input".into())
            .spawn(move || {
                let mut backend = create_input_backend();
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
                        Msg::Bytes(bytes) => {
                            worker_metrics.queue_depth.fetch_sub(1, Ordering::Relaxed);
                            match decode_input_batch(&bytes) {
                                Ok(batch) => dispatcher.process_batch(batch),
                                Err(e) => {
                                    worker_metrics.events_dropped_invalid.fetch_add(1, Ordering::Relaxed);
                                    log::warn!(target: "lilypad::input", "invalid input frame: {e}");
                                }
                            }
                        }
                        Msg::SetEnabled(enabled) => dispatcher.set_enabled(enabled),
                        Msg::SetScopes(scopes) => dispatcher.set_scopes(scopes),
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
        }
    }

    /// Feed one raw DataChannel frame (phone → desktop input batch). Drops
    /// the frame (counted, logged) if the worker is backed up.
    pub fn handle_message(&self, bytes: Vec<u8>) {
        match self.tx.try_send(Msg::Bytes(bytes)) {
            Ok(()) => {
                self.metrics.queue_depth.fetch_add(1, Ordering::Relaxed);
            }
            Err(_) => {
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
        let _ = self.tx.send(Msg::SetEnabled(enabled));
    }

    /// Update the granted-scope set for the current session (from
    /// `session-start`'s `grantedScopes`) — independent of `set_enabled`, so
    /// a session that is connected with an open DataChannel but was only
    /// granted `view` still has every control-plane event rejected at
    /// `InputDispatcher::process_batch`.
    pub fn set_scopes(&self, scopes: HashSet<Scope>) {
        let _ = self.tx.send(Msg::SetScopes(scopes));
    }

    pub fn metrics(&self) -> Arc<InputMetrics> {
        Arc::clone(&self.metrics)
    }
}

impl Drop for InputWorker {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Shutdown);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}
