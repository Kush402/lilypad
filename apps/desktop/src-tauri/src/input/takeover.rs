//! Noticing a person at the Mac while Ask is working.
//!
//! Touching the phone already stops a run (the phone's input is its own
//! takeover signal). A person sitting at the Mac has no phone in the loop:
//! they grab the mouse or start typing, and Ask has to get out of the way —
//! immediately, not after its current batch. So while a run is active a
//! listener watches the system's input stream and stops the run on the first
//! mouse press, key press, scroll or real pointer movement that neither Ask
//! nor the phone produced.
//!
//! Ask's own events are recognisable two ways, because being wrong here stops
//! every run on its first click: each one carries [`AGENT_EVENT_TAG`] in
//! `kCGEventSourceUserData`, and the input thread marks the window during
//! which it is injecting. Modifier-only changes are ignored outright — the
//! system synthesizes those from Ask's own shortcuts.
//!
//! If macOS will not create the listener, the run relies on the pointer-drift
//! check the computer tier makes before every gesture.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{AGENT_EVENT_TAG, PHONE_EVENT_TAG};

/// When Ask last injected anything, in epoch milliseconds — maintained by the
/// input thread.
pub static AGENT_ACTIVE_UNTIL_MS: AtomicU64 = AtomicU64::new(0);

/// How long after one of Ask's gestures its events may still be arriving.
pub const AGENT_GRACE_MS: u64 = 200;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Mark Ask as injecting until a moment from now.
pub fn mark_agent_active() {
    AGENT_ACTIVE_UNTIL_MS.store(now_ms() + AGENT_GRACE_MS, Ordering::SeqCst);
}

/// Pointer movement smaller than this, in points, is jitter.
const MOVE_POINTS: f64 = 6.0;

/// The kinds of event the listener sees.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seen {
    Press,
    Key,
    Scroll,
    Move { dx: i64, dy: i64 },
    ModifiersOnly,
    Other,
}

/// Is this event a person at the Mac? Pure, so the rule is table-tested.
pub fn is_person(kind: Seen, tag: i64, agent_active: bool) -> bool {
    if tag == AGENT_EVENT_TAG || tag == PHONE_EVENT_TAG || agent_active {
        return false;
    }
    match kind {
        Seen::Press | Seen::Key | Seen::Scroll => true,
        Seen::Move { dx, dy } => ((dx * dx + dy * dy) as f64).sqrt() >= MOVE_POINTS,
        Seen::ModifiersOnly | Seen::Other => false,
    }
}

/// A running listener. Dropping it stops listening.
pub struct Takeover {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Takeover {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Takeover {
    /// Start listening; `on_person` runs (once) the first time someone uses
    /// the Mac. `None` when the listener could not be created.
    #[cfg(target_os = "macos")]
    pub fn watch(on_person: impl Fn() + Send + Sync + 'static) -> Option<Takeover> {
        use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop};
        use core_graphics::event::{
            CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
            CallbackResult, EventField,
        };

        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<bool>();
        let thread_stop = Arc::clone(&stop);
        let fired = Arc::new(AtomicBool::new(false));
        let on_person = Arc::new(on_person);
        let thread = std::thread::Builder::new()
            .name("lilypad-takeover".into())
            .spawn(move || {
                let last: Arc<std::sync::Mutex<Option<(f64, f64)>>> = Default::default();
                let callback_last = Arc::clone(&last);
                let callback_fired = Arc::clone(&fired);
                let callback_person = Arc::clone(&on_person);
                let tap = CGEventTap::new(
                    CGEventTapLocation::Session,
                    CGEventTapPlacement::TailAppendEventTap,
                    // A listen-only tap needs Input Monitoring for keys; a
                    // pass-through tap needs only the Accessibility grant
                    // Lilypad already holds. It never changes an event.
                    CGEventTapOptions::Default,
                    vec![
                        CGEventType::LeftMouseDown,
                        CGEventType::RightMouseDown,
                        CGEventType::OtherMouseDown,
                        CGEventType::KeyDown,
                        CGEventType::ScrollWheel,
                        CGEventType::MouseMoved,
                        CGEventType::FlagsChanged,
                    ],
                    move |_proxy, kind, event| {
                        let at = event.location();
                        let tag = event.get_integer_value_field(EventField::EVENT_SOURCE_USER_DATA);
                        let seen = match kind {
                            CGEventType::LeftMouseDown
                            | CGEventType::RightMouseDown
                            | CGEventType::OtherMouseDown => Seen::Press,
                            CGEventType::KeyDown => Seen::Key,
                            CGEventType::ScrollWheel => Seen::Scroll,
                            CGEventType::FlagsChanged => Seen::ModifiersOnly,
                            CGEventType::MouseMoved => {
                                let mut last = callback_last.lock().unwrap();
                                let seen = match *last {
                                    Some((x, y)) => Seen::Move {
                                        dx: (at.x - x) as i64,
                                        dy: (at.y - y) as i64,
                                    },
                                    None => Seen::Other,
                                };
                                *last = Some((at.x, at.y));
                                seen
                            }
                            _ => Seen::Other,
                        };
                        // Any event Ask or the phone made moves the baseline,
                        // so the next real move is measured from there.
                        if matches!(seen, Seen::Other | Seen::Move { .. }) || tag != 0 {
                            *callback_last.lock().unwrap() = Some((at.x, at.y));
                        }
                        let active = AGENT_ACTIVE_UNTIL_MS.load(Ordering::SeqCst) > now_ms();
                        if is_person(seen, tag, active)
                            && !callback_fired.swap(true, Ordering::SeqCst)
                        {
                            callback_person();
                        }
                        CallbackResult::Keep
                    },
                );
                let Ok(tap) = tap else {
                    let _ = ready_tx.send(false);
                    return;
                };
                let Ok(source) = tap.mach_port().create_runloop_source(0) else {
                    let _ = ready_tx.send(false);
                    return;
                };
                let run_loop = CFRunLoop::get_current();
                run_loop.add_source(&source, unsafe { kCFRunLoopDefaultMode });
                tap.enable();
                let _ = ready_tx.send(true);
                while !thread_stop.load(Ordering::SeqCst) {
                    CFRunLoop::run_in_mode(
                        unsafe { kCFRunLoopDefaultMode },
                        std::time::Duration::from_millis(200),
                        true,
                    );
                }
                drop(tap);
            })
            .ok()?;
        match ready_rx.recv_timeout(std::time::Duration::from_secs(2)) {
            Ok(true) => Some(Takeover {
                stop,
                thread: Some(thread),
            }),
            _ => {
                stop.store(true, Ordering::SeqCst);
                let _ = thread.join();
                log::warn!(
                    target: "lilypad::agent",
                    "could not listen for input at the Mac; relying on the pointer check"
                );
                None
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn watch(_on_person: impl Fn() + Send + Sync + 'static) -> Option<Takeover> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_person_is_a_press_a_key_a_scroll_or_a_real_move() {
        for kind in [
            Seen::Press,
            Seen::Key,
            Seen::Scroll,
            Seen::Move { dx: 10, dy: 0 },
        ] {
            assert!(is_person(kind, 0, false), "{kind:?}");
        }
        assert!(!is_person(Seen::Move { dx: 2, dy: 2 }, 0, false), "jitter");
        assert!(!is_person(Seen::ModifiersOnly, 0, false));
        assert!(!is_person(Seen::Other, 0, false));
    }

    #[test]
    fn ask_and_the_phone_are_never_a_person() {
        for kind in [
            Seen::Press,
            Seen::Key,
            Seen::Scroll,
            Seen::Move { dx: 50, dy: 50 },
        ] {
            assert!(!is_person(kind, AGENT_EVENT_TAG, false));
            assert!(!is_person(kind, PHONE_EVENT_TAG, false));
            // Untagged, but while Ask is injecting: its own events.
            assert!(!is_person(kind, 0, true));
        }
    }

    #[test]
    fn the_active_window_expires() {
        AGENT_ACTIVE_UNTIL_MS.store(0, Ordering::SeqCst);
        assert!(AGENT_ACTIVE_UNTIL_MS.load(Ordering::SeqCst) <= now_ms());
        mark_agent_active();
        assert!(AGENT_ACTIVE_UNTIL_MS.load(Ordering::SeqCst) > now_ms());
    }
}
