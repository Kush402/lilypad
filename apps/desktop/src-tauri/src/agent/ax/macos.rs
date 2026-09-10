//! macOS Accessibility FFI — the thin, effectful adapter that turns the live
//! focused-app AX tree into the pure [`AxNode`](super::tree::AxNode) snapshot
//! the model reads, and performs `AXPress` on a chosen element.
//!
//! Everything reasoned-about (serialization, id lookup) lives in
//! `super::tree`; this file is only the `AXUIElement` walk + press. It reuses
//! the same `ApplicationServices` framework link the input backend already
//! uses for `AXIsProcessTrusted`.
//!
//! Handles are stored as raw retained `AXUIElementRef`s (not the crate's
//! `CFType`, which is `!Send`) so a snapshot can live in the agent runner's
//! `Send` future; retain/release is managed by hand via `CFRetain`/`CFRelease`.

use std::ffi::c_void;

use anyhow::{anyhow, bail, Result};
use core_foundation::base::{CFTypeID, CFTypeRef, TCFType};
use core_foundation::string::{CFString, CFStringRef};

use super::tree::{self, AxNode, MAX_DEPTH, MAX_NODES};

/// Longest label or value copied out of one element (L-270).
///
/// The cap used to be applied when the tree was serialized, which is after
/// every string has already been copied out of the app. A document whose
/// AXValue is its whole text is one allocation of that size, and there is no
/// bound on how many such elements a tree has. Clip at the copy, so the
/// memory is never held in the first place.
const MAX_STRING_BYTES: usize = 512;

/// Longest child array retained from one element (L-270).
///
/// `AXChildren` on a table with a hundred thousand rows returns a hundred
/// thousand retained references before the walk's own `MAX_NODES` check gets a
/// chance to look at any of them. The node cap has to reach the acquisition,
/// not only the loop that consumes it.
const MAX_CHILDREN_PER_ELEMENT: usize = 512;

#[allow(non_camel_case_types)]
type AXUIElementRef = CFTypeRef;
#[allow(non_camel_case_types)]
type AXError = i32;
const AX_SUCCESS: AXError = 0;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementCopyActionNames(element: AXUIElementRef, names: *mut CFTypeRef) -> AXError;
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
    /// Unwrap an `AXValue` (a boxed CGPoint/CGSize) into a plain struct.
    fn AXValueGetValue(value: CFTypeRef, the_type: u32, out: *mut c_void) -> u8;
    /// How long one accessibility message may wait for the target process.
    /// Set on the system-wide element it becomes the default for every
    /// element this process creates (L-270).
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, seconds: f32) -> AXError;
}

// ── bounding one perception step (L-270) ─────────────────────────────────
//
// The node and depth caps bound how *much* is read. They say nothing about
// how long it takes: every attribute read is a synchronous message to another
// process, and an application that is beachballing answers none of them. The
// caps were satisfied and the agent step sat there.
//
// Two bounds, because one is not enough. `AXUIElementSetMessagingTimeout` is
// the platform's own answer and it bounds a single message; a tree of four
// hundred nodes that each take the full timeout is still minutes. So the walk
// also carries a wall-clock deadline and returns what it has.

/// How long one accessibility message may block. Generous for a healthy app —
/// these normally return in single-digit milliseconds.
const AX_MESSAGE_TIMEOUT_SECS: f32 = 0.5;

/// How long one whole `read_focused_tree` may take before it stops walking and
/// returns what it has. A partial tree is a worse observation than a complete
/// one; a perception step that never returns is worse than either, because it
/// is also holding Stop.
const AX_WALK_DEADLINE: std::time::Duration = std::time::Duration::from_secs(3);

const AX_VALUE_CG_POINT: u32 = 1;
const AX_VALUE_CG_SIZE: u32 = 2;

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPointRaw {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CGSizeRaw {
    width: f64,
    height: f64,
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    fn CFRelease(cf: CFTypeRef);
    fn CFEqual(a: CFTypeRef, b: CFTypeRef) -> u8;
    fn CFGetTypeID(cf: CFTypeRef) -> CFTypeID;
    fn CFArrayGetCount(arr: CFTypeRef) -> isize;
    fn CFArrayGetValueAtIndex(arr: CFTypeRef, idx: isize) -> *const c_void;
    fn CFArrayGetTypeID() -> CFTypeID;
    fn CFStringGetTypeID() -> CFTypeID;
}

/// A +1-owned CFType reference, released exactly once on drop. Used for the
/// transient attribute values read during a walk (never stored beyond it).
struct OwnedCF(CFTypeRef);
impl Drop for OwnedCF {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}

/// A retained handle to a live AX element — the parallel to a snapshot's `id`.
/// Raw pointer + manual release so it is `Send` (the crate's `CFType` is not).
pub struct AxHandle {
    raw: AXUIElementRef,
}
impl Drop for AxHandle {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe { CFRelease(self.raw) }
        }
    }
}
// SAFETY: an AXUIElementRef is a reference-counted CoreFoundation object; the
// AX API is safe to call from any thread, and retain/release are atomic. We
// hand a handle to at most one thread at a time (moved into the snapshot).
unsafe impl Send for AxHandle {}

/// One read of the focused app: the snapshot the model sees, plus a handle
/// table indexed by `AxNode::id` so a later `press(id)` reaches the live
/// element.
pub struct AxSnapshot {
    pub nodes: Vec<AxNode>,
    handles: Vec<AxHandle>,
}

impl AxSnapshot {
    /// Does an approval given against this read still describe pressing
    /// `element_id` in `other` (L-272)?
    ///
    /// This used to compare the whole flattened tree for byte equality plus
    /// the app's native identity. Correct, and unusable: a clock ticking over,
    /// a "saved 2 minutes ago" label, a progress bar or a notification in
    /// another window of the same app all rejected an approval the person had
    /// just given, for an action that had not changed. A gate that fires on
    /// nothing is a gate people route around.
    ///
    /// Three things are compared instead, and the policy for the third lives
    /// in `tree`, where it can be tested without an AX server:
    ///
    ///   1. the **window** is the same live object, not merely the same text;
    ///   2. its structure is unchanged — a re-laid-out app is a fresh
    ///      decision, which is what stops a different control arriving under
    ///      the same id;
    ///   3. its text is unchanged, except for an enumerated list of forms that
    ///      change by themselves.
    pub fn same_context(&self, other: &Self, element_id: usize) -> bool {
        if !tree::same_material_context(&self.nodes, &other.nodes, element_id) {
            return false;
        }
        // The window itself, by identity. Two windows can carry identical text
        // and still be different objects, and an approval is about the one the
        // person was looking at.
        let window = |snap: &Self| {
            tree::window_subtree(&snap.nodes, element_id)
                .and_then(|range| snap.handles.get(range.start))
                .map(|h| h.raw)
        };
        match (window(self), window(other)) {
            (Some(a), Some(b)) => unsafe { CFEqual(a, b) != 0 },
            // No live handles (the test constructor) means no identity claim
            // to make, and claiming one would be worse than refusing.
            _ => false,
        }
    }

    pub fn handle(&self, id: usize) -> Option<&AxHandle> {
        self.handles.get(id)
    }

    /// Test-only: a snapshot of nodes with no live handles, so the pure
    /// id→meaning resolution can be exercised in a process that is not
    /// Accessibility-trusted.
    #[cfg(test)]
    pub fn for_test(nodes: Vec<AxNode>) -> Self {
        AxSnapshot {
            nodes,
            handles: Vec::new(),
        }
    }
}

/// Copy an AX attribute as an owned CFType, or `None` if absent/error.
fn copy_attribute(element: AXUIElementRef, attribute: &str) -> Option<OwnedCF> {
    let attr = CFString::new(attribute);
    let mut out: CFTypeRef = std::ptr::null();
    let err =
        unsafe { AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut out) };
    if err != AX_SUCCESS || out.is_null() {
        None
    } else {
        Some(OwnedCF(out))
    }
}

/// Interpret a CFType as a Rust string iff it is a CFString.
fn as_string(cf: CFTypeRef) -> Option<String> {
    if cf.is_null() {
        return None;
    }
    unsafe {
        if CFGetTypeID(cf) == CFStringGetTypeID() {
            Some(CFString::wrap_under_get_rule(cf as CFStringRef).to_string())
        } else {
            None
        }
    }
}

fn copy_string_attribute(element: AXUIElementRef, attribute: &str) -> Option<String> {
    let value = copy_attribute(element, attribute)?;
    as_string(value.0)
}

/// Does the element advertise the press action?
fn is_pressable(element: AXUIElementRef) -> bool {
    let mut out: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyActionNames(element, &mut out) };
    if err != AX_SUCCESS || out.is_null() {
        return false;
    }
    let owned = OwnedCF(out);
    unsafe {
        if CFGetTypeID(owned.0) != CFArrayGetTypeID() {
            return false;
        }
        let count = CFArrayGetCount(owned.0);
        for i in 0..count {
            let item = CFArrayGetValueAtIndex(owned.0, i);
            if as_string(item).as_deref() == Some("AXPress") {
                return true;
            }
        }
    }
    false
}

/// Clip a copied AX string to [`MAX_STRING_BYTES`] on a character boundary.
fn clip(mut s: String) -> String {
    if s.len() <= MAX_STRING_BYTES {
        return s;
    }
    let mut end = MAX_STRING_BYTES;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s.push('…');
    s
}

/// Is this element a password field?
///
/// macOS marks these either by role or by subrole depending on the toolkit.
/// Both are checked, because getting it wrong once means a password in an
/// observation, and an observation is sent to the model provider.
fn is_secure(element: AXUIElementRef, role: &str) -> bool {
    if role == "AXSecureTextField" {
        return true;
    }
    copy_string_attribute(element, "AXSubrole").is_some_and(|sub| sub == "AXSecureTextField")
}

/// Read one element into an `AxNode` (without its children).
fn describe(element: AXUIElementRef, id: usize, depth: usize) -> AxNode {
    let role = copy_string_attribute(element, "AXRole").unwrap_or_else(|| "AXUnknown".into());
    let label = copy_string_attribute(element, "AXTitle")
        .or_else(|| copy_string_attribute(element, "AXDescription"))
        .filter(|s| !s.is_empty())
        .map(clip);
    // AXValue is rendered only when textual (field contents); numeric/geometry
    // AXValues aren't useful to the model as text. A secure field's value is
    // never copied at all — the model is told a password field is there, which
    // is all it needs to reason about the form (L-267).
    let value = if is_secure(element, &role) {
        Some("‹password field›".to_string())
    } else {
        copy_string_attribute(element, "AXValue")
            .filter(|s| !s.is_empty())
            .map(clip)
    };
    AxNode {
        id,
        depth,
        role,
        label,
        value,
        pressable: is_pressable(element),
    }
}

/// Children of an element as retained handles, at most `budget` of them.
///
/// `budget` is what the walk still has room for, so a single enormous element
/// cannot make this allocate a table the walk was never going to use (L-270).
fn children(element: AXUIElementRef, budget: usize) -> Vec<AxHandle> {
    if budget == 0 {
        return Vec::new();
    }
    let Some(arr) = copy_attribute(element, "AXChildren") else {
        return Vec::new();
    };
    unsafe {
        if CFGetTypeID(arr.0) != CFArrayGetTypeID() {
            return Vec::new();
        }
        let count = CFArrayGetCount(arr.0).max(0) as usize;
        let keep = count.min(budget).min(MAX_CHILDREN_PER_ELEMENT);
        let mut out = Vec::with_capacity(keep);
        for i in 0..keep {
            let raw = CFArrayGetValueAtIndex(arr.0, i as isize);
            if !raw.is_null() {
                // The array holds a borrowed (get-rule) reference; retain so
                // our handle owns its own +1 beyond the array's lifetime.
                CFRetain(raw);
                out.push(AxHandle { raw });
            }
        }
        out
    }
}

/// The windows of an application element, as retained handles.
fn windows_of(app: AXUIElementRef) -> Vec<AxHandle> {
    let Some(arr) = copy_attribute(app, "AXWindows") else {
        return Vec::new();
    };
    unsafe {
        if CFGetTypeID(arr.0) != CFArrayGetTypeID() {
            return Vec::new();
        }
        let count = CFArrayGetCount(arr.0).max(0) as usize;
        let mut out = Vec::with_capacity(count.min(MAX_CHILDREN_PER_ELEMENT));
        for i in 0..count.min(MAX_CHILDREN_PER_ELEMENT) {
            let raw = CFArrayGetValueAtIndex(arr.0, i as isize);
            if !raw.is_null() {
                CFRetain(raw);
                out.push(AxHandle { raw });
            }
        }
        out
    }
}

/// A window's global rectangle, if it exposes one.
fn window_frame(window: AXUIElementRef) -> Option<(f64, f64, f64, f64)> {
    let position = copy_attribute(window, "AXPosition")?;
    let size = copy_attribute(window, "AXSize")?;
    let mut point = CGPointRaw { x: 0.0, y: 0.0 };
    let mut extent = CGSizeRaw {
        width: 0.0,
        height: 0.0,
    };
    unsafe {
        if AXValueGetValue(
            position.0,
            AX_VALUE_CG_POINT,
            &mut point as *mut _ as *mut c_void,
        ) == 0
        {
            return None;
        }
        if AXValueGetValue(
            size.0,
            AX_VALUE_CG_SIZE,
            &mut extent as *mut _ as *mut c_void,
        ) == 0
        {
            return None;
        }
    }
    Some((point.x, point.y, extent.width, extent.height))
}

/// Read the focused application's AX tree into a bounded snapshot, restricted
/// to the windows on the display the session is sharing. Depth-first with a
/// stable preorder id, capped at [`MAX_NODES`]/[`MAX_DEPTH`].
///
/// ### Why the root is a window and not the application (L-267)
///
/// This used to start at `AXFocusedApplication` and walk every child. An
/// application's AX tree is all of its windows, and windows live on whichever
/// monitor the person put them on. The screenshot path was already restricted
/// to the shared display; this path was not, so on a two-monitor Mac the model
/// could be handed the text of a document on the monitor the phone was not
/// watching — and that text goes to the provider. "Only the shared screen is
/// visible" was true of the video and false of the observation.
///
/// So the walk is rooted at windows, and a window is included only when its
/// frame overlaps the shared display. A window that will not say where it is
/// is excluded: an unplaceable window is not evidence of being in scope.
///
/// Synchronous blocking FFI (~tens of ms). Called directly (not on a blocking
/// pool) because the handle table it returns is `!Sync` and cheap enough that
/// briefly occupying the agent step's worker is fine — the agent does one
/// action at a time.
pub fn read_focused_tree(display: Option<u32>) -> Result<AxSnapshot> {
    let system = unsafe { AXUIElementCreateSystemWide() };
    if system.is_null() {
        bail!("AXUIElementCreateSystemWide returned null (accessibility not available)");
    }
    let system = OwnedCF(system);
    // Before the first message, not after: this is the bound on the call that
    // asks which application is focused, too (L-270).
    unsafe { AXUIElementSetMessagingTimeout(system.0, AX_MESSAGE_TIMEOUT_SECS) };
    let started = std::time::Instant::now();
    let app = copy_attribute(system.0, "AXFocusedApplication")
        .ok_or_else(|| anyhow!("no focused application (grant Accessibility, focus an app)"))?;
    // Promote the app value to an owned handle.
    let app_handle = AxHandle {
        raw: unsafe { CFRetain(app.0) },
    };
    unsafe { AXUIElementSetMessagingTimeout(app_handle.raw, AX_MESSAGE_TIMEOUT_SECS) };

    let bounds = shared_display_bounds(display);
    let roots = scoped_roots(&app_handle, bounds);
    if roots.is_empty() {
        bail!(
            "the focused app has no window on the shared display — move it to the screen \
             you are sharing, or share the screen it is on"
        );
    }

    let mut nodes = Vec::new();
    let mut handles: Vec<AxHandle> = Vec::new();
    // Reversed so the first scoped window pops first and keeps id 0.
    let mut stack: Vec<(AxHandle, usize)> = roots.into_iter().rev().map(|h| (h, 0)).collect();
    while let Some((handle, depth)) = stack.pop() {
        if nodes.len() >= MAX_NODES {
            break;
        }
        // Checked per node rather than per message: a message is already
        // bounded, and this is the bound on the sum of them.
        if started.elapsed() >= AX_WALK_DEADLINE {
            break;
        }
        let id = nodes.len();
        let raw = handle.raw;
        nodes.push(describe(raw, id, depth));
        handles.push(handle); // handles[id] == the element for nodes[id]
        if depth < MAX_DEPTH {
            let room = MAX_NODES.saturating_sub(nodes.len() + stack.len());
            // Reversed so natural document order pops first.
            for kid in children(raw, room).into_iter().rev() {
                stack.push((kid, depth + 1));
            }
        }
    }
    Ok(AxSnapshot { nodes, handles })
}

/// The global rectangle of the display the session shares, or the main
/// display's when none was chosen or the chosen one has gone away — the same
/// rule the input backend uses to place a click.
fn shared_display_bounds(display: Option<u32>) -> (f64, f64, f64, f64) {
    use core_graphics::display::CGDisplay;
    let rect = display
        .map(CGDisplay::new)
        .map(|d| d.bounds())
        .filter(|b| b.size.width > 0.0 && b.size.height > 0.0)
        .unwrap_or_else(|| CGDisplay::main().bounds());
    (
        rect.origin.x,
        rect.origin.y,
        rect.size.width,
        rect.size.height,
    )
}

/// Do two global rectangles overlap at all?
fn overlaps(a: (f64, f64, f64, f64), b: (f64, f64, f64, f64)) -> bool {
    a.0 < b.0 + b.2 && b.0 < a.0 + a.2 && a.1 < b.1 + b.3 && b.1 < a.1 + a.3
}

/// The windows of `app` that lie on the shared display.
///
/// An app with no `AXWindows` at all (a menu-bar extra, say) falls back to its
/// focused window, and to nothing if it has none. It deliberately does not
/// fall back to the application element: that is the unscoped walk this
/// function exists to prevent.
fn scoped_roots(app: &AxHandle, bounds: (f64, f64, f64, f64)) -> Vec<AxHandle> {
    let mut scoped: Vec<AxHandle> = windows_of(app.raw)
        .into_iter()
        .filter(|w| window_frame(w.raw).is_some_and(|frame| overlaps(frame, bounds)))
        .collect();
    if scoped.is_empty() {
        if let Some(focused) = copy_attribute(app.raw, "AXFocusedWindow") {
            let handle = AxHandle {
                raw: unsafe { CFRetain(focused.0) },
            };
            if window_frame(handle.raw).is_some_and(|frame| overlaps(frame, bounds)) {
                scoped.push(handle);
            }
        }
    }
    scoped
}

/// Re-read a live element's role and label, for confirming that the control
/// about to be pressed is still the one that was classified and approved.
///
/// The snapshot cannot answer this: it is a copy taken at read time, so
/// comparing it against itself always agrees. Only the live element knows that
/// the dialog re-laid itself out and this button now says something else.
pub fn describe_live(handle: &AxHandle) -> Option<(String, String)> {
    let role = copy_string_attribute(handle.raw, "AXRole")?;
    let label = copy_string_attribute(handle.raw, "AXTitle")
        .or_else(|| copy_string_attribute(handle.raw, "AXDescription"))
        .unwrap_or_default();
    Some((role, label))
}

/// Perform `AXPress` on a handle.
pub fn press(handle: &AxHandle) -> Result<()> {
    let action = CFString::new("AXPress");
    let err = unsafe { AXUIElementPerformAction(handle.raw, action.as_concrete_TypeRef()) };
    if err == AX_SUCCESS {
        Ok(())
    } else {
        bail!("AXPress failed (AXError {err})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live FFI link + memory smoke test. The test process is not Accessibility-
    /// trusted, so this exercises the graceful error path (no focused app) — the
    /// point is that the whole CF/AX FFI links and runs to a clean `Result`
    /// without a crash, use-after-free, or segfault. On a trusted host (the
    /// signed app) the same call returns a populated tree.
    #[test]
    fn read_focused_tree_links_and_returns_cleanly() {
        let started = std::time::Instant::now();
        let result = read_focused_tree(None);
        // L-270. The node and depth caps bound how much is read, not how long
        // it takes. This is the weak half of that check: it proves a healthy
        // read comes back inside the walk deadline. A beachballing application
        // is what the deadline is actually for, and reproducing one is a
        // device test, not this.
        assert!(
            started.elapsed() < AX_WALK_DEADLINE + std::time::Duration::from_secs(1),
            "a perception step took {:?}, past its own deadline",
            started.elapsed()
        );
        match result {
            Ok(snap) => {
                // If we happen to be trusted, ids must be a dense 0..n range.
                for (i, node) in snap.nodes.iter().enumerate() {
                    assert_eq!(node.id, i);
                }
            }
            Err(_) => { /* expected without the Accessibility grant */ }
        }
    }

    /// The two bounds have to compose: one message's timeout times the node
    /// cap is the worst case the walk deadline exists to cut short.
    #[test]
    fn the_perception_bounds_are_not_decorative() {
        let worst_case_messages =
            std::time::Duration::from_secs_f32(AX_MESSAGE_TIMEOUT_SECS) * MAX_NODES as u32;
        assert!(
            AX_WALK_DEADLINE < worst_case_messages,
            "the walk deadline never fires: {AX_WALK_DEADLINE:?} is longer than the              {worst_case_messages:?} a full tree of timed-out messages would take"
        );
    }
}
