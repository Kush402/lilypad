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

use super::tree::{AxNode, MAX_DEPTH, MAX_NODES};

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
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    fn CFRelease(cf: CFTypeRef);
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
    pub fn handle(&self, id: usize) -> Option<&AxHandle> {
        self.handles.get(id)
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

/// Read one element into an `AxNode` (without its children).
fn describe(element: AXUIElementRef, id: usize, depth: usize) -> AxNode {
    let role = copy_string_attribute(element, "AXRole").unwrap_or_else(|| "AXUnknown".into());
    let label = copy_string_attribute(element, "AXTitle")
        .or_else(|| copy_string_attribute(element, "AXDescription"))
        .filter(|s| !s.is_empty());
    // AXValue is rendered only when textual (field contents); numeric/geometry
    // AXValues aren't useful to the model as text.
    let value = copy_string_attribute(element, "AXValue").filter(|s| !s.is_empty());
    AxNode {
        id,
        depth,
        role,
        label,
        value,
        pressable: is_pressable(element),
    }
}

/// Children of an element as retained handles.
fn children(element: AXUIElementRef) -> Vec<AxHandle> {
    let Some(arr) = copy_attribute(element, "AXChildren") else {
        return Vec::new();
    };
    unsafe {
        if CFGetTypeID(arr.0) != CFArrayGetTypeID() {
            return Vec::new();
        }
        let count = CFArrayGetCount(arr.0);
        let mut out = Vec::with_capacity(count.max(0) as usize);
        for i in 0..count {
            let raw = CFArrayGetValueAtIndex(arr.0, i);
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

/// Read the focused application's AX tree into a bounded snapshot. Depth-first
/// with a stable preorder id, capped at [`MAX_NODES`]/[`MAX_DEPTH`].
///
/// Synchronous blocking FFI (~tens of ms). Called directly (not on a blocking
/// pool) because the handle table it returns is `!Sync` and cheap enough that
/// briefly occupying the agent step's worker is fine — the agent does one
/// action at a time.
pub fn read_focused_tree() -> Result<AxSnapshot> {
    let system = unsafe { AXUIElementCreateSystemWide() };
    if system.is_null() {
        bail!("AXUIElementCreateSystemWide returned null (accessibility not available)");
    }
    let system = OwnedCF(system);
    let app = copy_attribute(system.0, "AXFocusedApplication")
        .ok_or_else(|| anyhow!("no focused application (grant Accessibility, focus an app)"))?;
    // Promote the app value to an owned handle.
    let app_handle = AxHandle {
        raw: unsafe { CFRetain(app.0) },
    };

    let mut nodes = Vec::new();
    let mut handles: Vec<AxHandle> = Vec::new();
    let mut stack: Vec<(AxHandle, usize)> = vec![(app_handle, 0)];
    while let Some((handle, depth)) = stack.pop() {
        if nodes.len() >= MAX_NODES {
            break;
        }
        let id = nodes.len();
        let raw = handle.raw;
        nodes.push(describe(raw, id, depth));
        handles.push(handle); // handles[id] == the element for nodes[id]
        if depth < MAX_DEPTH {
            // Reversed so natural document order pops first.
            for kid in children(raw).into_iter().rev() {
                stack.push((kid, depth + 1));
            }
        }
    }
    Ok(AxSnapshot { nodes, handles })
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
        match read_focused_tree() {
            Ok(snap) => {
                // If we happen to be trusted, ids must be a dense 0..n range.
                for (i, node) in snap.nodes.iter().enumerate() {
                    assert_eq!(node.id, i);
                }
            }
            Err(_) => { /* expected without the Accessibility grant */ }
        }
    }
}
