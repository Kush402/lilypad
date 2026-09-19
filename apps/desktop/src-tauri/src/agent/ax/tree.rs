//! The Accessibility-tree model — pure, OS-free, and fully testable. The macOS
//! FFI in `super::macos` produces a `Vec<AxNode>` (a flattened snapshot with
//! stable ids); everything here — serialization for the model, id lookup — is
//! logic with no `AXUIElement` in sight.
//!
//! Ids are the contract with the model: a `read_ax_tree` observation lists each
//! element as `[id] …`, and the model acts by naming an id (`ax_press` with
//! that id). The executor maps the id back to the live element via the parallel
//! handle table the FFI walk built.

/// One accessibility element, snapshotted. `id` is its index in the flattened
/// walk — stable for the lifetime of one read, and the token the model uses to
/// refer back to it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AxNode {
    pub id: usize,
    /// Depth in the tree (0 = the focused application root).
    pub depth: usize,
    /// AX role, e.g. "AXButton", "AXTextField", "AXStaticText".
    pub role: String,
    /// A human label: AXTitle, or AXDescription, whichever is present.
    pub label: Option<String>,
    /// AXValue rendered as text, when it is textual (field contents, etc.).
    pub value: Option<String>,
    /// Whether the element advertises the press action (`AXPress`).
    pub pressable: bool,
    /// Global rectangle in points `[x, y, width, height]`, read for the
    /// elements a model might point at. `None` when not read or not exposed.
    pub frame: Option<[f64; 4]>,
    /// Whether this element has keyboard focus.
    pub focused: bool,
}

/// Roles a person types into or picks from, listed even when they do not
/// advertise `AXPress`.
const INPUT_ROLES: &[&str] = &[
    "AXTextField",
    "AXTextArea",
    "AXSearchField",
    "AXSecureTextField",
    "AXComboBox",
    "AXCheckBox",
    "AXRadioButton",
    "AXPopUpButton",
    "AXMenuButton",
    "AXSlider",
    "AXIncrementor",
    "AXLink",
    "AXTab",
    "AXMenuItem",
    "AXDisclosureTriangle",
];

/// Is this an element a model would act on — so worth a frame, a line in the
/// element list and a mark on the screenshot?
pub fn is_actionable(node: &AxNode) -> bool {
    node.pressable || INPUT_ROLES.contains(&node.role.as_str())
}

/// The opening line of the element list in a screen reading, which the thread
/// pruner also recognizes (see [`OBSERVATION_PREFIX`]).
pub const ELEMENTS_HEADING: &str = "Elements you can act on";

/// `frame` relative to `display` as a normalized rectangle, clipped to the
/// display. `None` when it is empty or entirely off the display.
pub fn normalized_frame(frame: [f64; 4], display: [f64; 4]) -> Option<[f64; 4]> {
    let [fx, fy, fw, fh] = frame;
    let [dx, dy, dw, dh] = display;
    if fw <= 0.0 || fh <= 0.0 || dw <= 0.0 || dh <= 0.0 {
        return None;
    }
    let x0 = ((fx - dx) / dw).max(0.0);
    let y0 = ((fy - dy) / dh).max(0.0);
    let x1 = ((fx + fw - dx) / dw).min(1.0);
    let y1 = ((fy + fh - dy) / dh).min(1.0);
    (x1 > x0 && y1 > y0).then_some([x0, y0, x1 - x0, y1 - y0])
}

/// The elements worth listing for a model: actionable, on the display, and
/// big enough to see — each with its normalized rectangle, focused first.
pub fn on_screen_actionable(nodes: &[AxNode], display: [f64; 4]) -> Vec<(&AxNode, [f64; 4])> {
    let mut out: Vec<(&AxNode, [f64; 4])> = nodes
        .iter()
        .filter(|n| is_actionable(n))
        .filter_map(|n| {
            let rect = normalized_frame(n.frame?, display)?;
            // Two points or smaller in either direction is not a target a
            // person could hit either.
            let min = |span: f64, of: f64| span * of >= 2.0;
            (min(rect[2], display[2]) && min(rect[3], display[3])).then_some((n, rect))
        })
        .collect();
    out.sort_by_key(|(n, _)| !n.focused);
    out
}

/// Caps so a huge tree can't blow the model's context or our own memory. The
/// FFI walk honors these; kept here beside the serializer that also respects
/// them so the two never disagree.
pub const MAX_NODES: usize = 400;
pub const MAX_DEPTH: usize = 12;

/// The opening line of a `read_ax_tree` observation.
///
/// A contract between the one place that writes a screen reading
/// (`executor::ax_exec`) and the one place that ages them out of the model
/// thread (`llm::retain_recent_trees`, L-317). A constant rather than a
/// literal in each, so the two cannot drift apart silently — if they did, the
/// readings would simply never be pruned and the only symptom would be a
/// larger bill.
pub const OBSERVATION_PREFIX: &str = "Accessibility tree:\n";

// ── what makes an approval still apply (L-272) ───────────────────────────
//
// Approval used to be re-checked by comparing the whole flattened tree for
// byte equality. Every part of that is defensible on its own and the sum was
// unusable: a clock ticking over, a "saved 2 minutes ago" label, a progress
// bar, or a notification in another window of the same app all rejected an
// approval the person had just given, for an action that had not changed at
// all. A gate that fires on nothing is a gate people learn to work around.
//
// The scope is therefore narrowed to the window that contains the target: a
// different window of the same app is not this decision, and its clock is not
// either. Inside that window, everything is compared exactly — same nodes,
// same roles, same depths, same actionability, same text.
//
// An earlier pass also allowed enumerated "self-changing" text forms — a
// clock, a percentage, a relative time, an `n of m` counter — to differ
// inside the window. That was wrong, and reproduced as wrong: a tip field
// going 5% → 95% and an appointment going 10:30 → 18:30 are both a pair of
// same-form strings, and both change what pressing the button does. A
// clock-shaped string is not evidence that it is a decorative clock. Text
// shape cannot tell a decoration from a decision; only context and identity
// can, and this comparison has neither. So the shape rule is gone. If a
// specific element is later shown to be decorative, exclude that element —
// not every string that looks like it.

/// The slice of `nodes` covering the window that contains `id`.
///
/// Roots are at depth 0 and the walk is preorder, so a node's window is the
/// nearest depth-0 node at or before it, and the window ends at the next one.
pub fn window_subtree(nodes: &[AxNode], id: usize) -> Option<std::ops::Range<usize>> {
    if id >= nodes.len() {
        return None;
    }
    let start = (0..=id).rev().find(|&i| nodes[i].depth == 0)?;
    let end = nodes[start + 1..]
        .iter()
        .position(|n| n.depth == 0)
        .map(|offset| start + 1 + offset)
        .unwrap_or(nodes.len());
    Some(start..end)
}

/// Does an approval given against `before` still describe pressing `id` in
/// `after` (L-272)?
///
/// Structure and exact text inside the target's own window, and nothing
/// outside it. No text form is exempt: see the note above `window_subtree`.
pub fn same_material_context(before: &[AxNode], after: &[AxNode], id: usize) -> bool {
    let (Some(a), Some(b)) = (window_subtree(before, id), window_subtree(after, id)) else {
        return false;
    };
    // The target must still be at the same place in the same window.
    if id - a.start != id - b.start || a.len() != b.len() {
        return false;
    }
    before[a].iter().zip(after[b].iter()).all(|(x, y)| {
        x.depth == y.depth
            && x.role == y.role
            && x.pressable == y.pressable
            && x.label == y.label
            && x.value == y.value
    })
}

/// Truncate a label/value to keep one line readable and bounded.
pub fn clip(s: &str) -> String {
    const CAP: usize = 120;
    let one_line = s.replace(['\n', '\r'], " ");
    if one_line.chars().count() <= CAP {
        one_line
    } else {
        let truncated: String = one_line.chars().take(CAP).collect();
        format!("{truncated}…")
    }
}

/// The whole observation a `read_ax_tree` returns: the prefix the thread
/// pruner looks for, then the tree. One function so the producer and
/// `OBSERVATION_PREFIX` cannot drift apart.
pub fn observation(nodes: &[AxNode]) -> String {
    format!("{OBSERVATION_PREFIX}{}", serialize(nodes))
}

/// Render a flattened tree as compact, indented text for the model. Each line:
/// `  [id] AXRole "label" = value  {pressable}`. Empty fields are omitted.
pub fn serialize(nodes: &[AxNode]) -> String {
    if nodes.is_empty() {
        return "(no accessible elements — the focused app exposes no AX tree; use vision)".into();
    }
    let mut out = String::new();
    for node in nodes.iter().take(MAX_NODES) {
        for _ in 0..node.depth.min(MAX_DEPTH) {
            out.push_str("  ");
        }
        out.push_str(&format!("[{}] {}", node.id, node.role));
        if let Some(label) = &node.label {
            if !label.is_empty() {
                out.push_str(&format!(" \"{}\"", clip(label)));
            }
        }
        if let Some(value) = &node.value {
            if !value.is_empty() {
                out.push_str(&format!(" = {}", clip(value)));
            }
        }
        if node.pressable {
            out.push_str("  {pressable}");
        }
        out.push('\n');
    }
    if nodes.len() > MAX_NODES {
        out.push_str(&format!(
            "… ({} more elements omitted — narrow the task or scroll)\n",
            nodes.len() - MAX_NODES
        ));
    }
    out
}

/// The role and label of `id` in this snapshot, for the security gate to
/// classify a press against. `None` when the id names no element here.
///
/// Returned as a plain tuple rather than a `security::AxTarget` so this module
/// stays what its header promises: pure tree logic with no policy in it.
pub fn describe_by_id(nodes: &[AxNode], id: usize) -> Option<(String, String)> {
    nodes
        .iter()
        .find(|n| n.id == id)
        .map(|n| (n.role.clone(), n.label.clone().unwrap_or_default()))
}

/// Is `id` a real element in this snapshot, and is it pressable? Used by the
/// executor to reject an `ax_press` for a bad or non-actionable id before it
/// ever touches the FFI.
pub fn pressable_by_id(nodes: &[AxNode], id: usize) -> Option<bool> {
    nodes.iter().find(|n| n.id == id).map(|n| n.pressable)
}

#[cfg(test)]
mod material_context_tests {
    use super::*;

    fn node(id: usize, depth: usize, role: &str, label: &str, value: Option<&str>) -> AxNode {
        AxNode {
            id,
            depth,
            role: role.into(),
            label: (!label.is_empty()).then(|| label.to_string()),
            value: value.map(str::to_string),
            pressable: role == "AXButton",
            ..Default::default()
        }
    }

    /// A payment sheet: the window, the amount, the recipient, the clock in
    /// the corner, and the button that does it.
    fn sheet(amount: &str, recipient: &str, clock: &str) -> Vec<AxNode> {
        vec![
            node(0, 0, "AXWindow", "Send money", None),
            node(1, 1, "AXStaticText", "Amount", Some(amount)),
            node(2, 1, "AXStaticText", "To", Some(recipient)),
            node(3, 1, "AXStaticText", "", Some(clock)),
            node(4, 1, "AXButton", "Send", None),
        ]
    }

    const SEND: usize = 4;

    /// One consequential field and the button that acts on it.
    fn decision(field: &str, value: &str, action: &str) -> Vec<AxNode> {
        vec![
            node(0, 0, "AXWindow", "Checkout", None),
            node(1, 1, "AXStaticText", field, Some(value)),
            node(2, 1, "AXButton", action, None),
        ]
    }

    const ACT: usize = 2;

    #[test]
    fn a_self_changing_shape_in_a_consequential_field_is_still_a_change() {
        // Reproduced 2026-09-10 against the enumerated-form rule, which let
        // every one of these through: "5%" and "95%" are both percentages,
        // "10:30" and "18:30" are both clocks, "1 of 10" and "9 of 10" are
        // both counters. All of them change what pressing the button does.
        for (field, before, after, action) in [
            ("Tip", "5%", "95%", "Pay"),
            ("Appointment", "10:30", "18:30", "Book"),
            ("Discount", "10%", "90%", "Apply"),
            ("APR", "3.9%", "29.9%", "Accept"),
            ("Quantity", "1 of 10", "9 of 10", "Order"),
            ("Due", "2 days ago", "9 days ago", "Pay now"),
            ("Duration", "0:30", "8:00", "Start"),
        ] {
            assert!(
                !same_material_context(
                    &decision(field, before, action),
                    &decision(field, after, action),
                    ACT
                ),
                "{field} {before} -> {after} kept an approval given for {before}"
            );
        }
    }

    #[test]
    fn a_decoration_sharing_the_deciding_window_costs_a_fresh_approval() {
        // The accepted price of exactness, stated so it is not mistaken for an
        // oversight: a clock in the *same* window as the button is asked
        // again, because nothing here can tell it from the appointment time
        // one row above it. Window scoping (below) is what keeps this from
        // firing on everything.
        let before = sheet("$40.00", "Rae", "10:31");
        let after = sheet("$40.00", "Rae", "10:32");
        assert!(!same_material_context(&before, &after, SEND));
    }

    #[test]
    fn a_changed_amount_or_recipient_demands_fresh_approval() {
        let before = sheet("$40.00", "Rae", "10:31");
        for after in [
            sheet("$400.00", "Rae", "10:31"),
            sheet("$40.00", "Someone Else", "10:31"),
            // Same digit count, different money. No shape-based rule may ever
            // make these two interchangeable.
            sheet("$50.00", "Rae", "10:31"),
        ] {
            assert!(
                !same_material_context(&before, &after, SEND),
                "a material change kept an old approval"
            );
        }
    }

    #[test]
    fn a_relaid_out_window_is_a_fresh_decision() {
        let before = sheet("$40.00", "Rae", "10:31");
        // A row appears: the id the model named no longer means what it did.
        let mut after = sheet("$40.00", "Rae", "10:31");
        after.insert(1, node(1, 1, "AXStaticText", "Fee", Some("$1.00")));
        for (i, n) in after.iter_mut().enumerate() {
            n.id = i;
        }
        assert!(!same_material_context(&before, &after, SEND));

        // The button becomes something else in place.
        let mut swapped = sheet("$40.00", "Rae", "10:31");
        swapped[SEND] = node(SEND, 1, "AXButton", "Delete account", None);
        assert!(!same_material_context(&before, &swapped, SEND));

        // …and a control that stops being actionable is not the same control.
        let mut inert = sheet("$40.00", "Rae", "10:31");
        inert[SEND].pressable = false;
        assert!(!same_material_context(&before, &inert, SEND));
    }

    #[test]
    fn another_window_of_the_same_app_is_not_this_decision() {
        // The other half of L-272: an unrelated window used to invalidate an
        // approval because the comparison was over the whole flattened tree.
        let mut before = sheet("$40.00", "Rae", "10:31");
        before.push(node(5, 0, "AXWindow", "Inbox", None));
        before.push(node(6, 1, "AXStaticText", "", Some("2 unread")));
        let mut after = sheet("$40.00", "Rae", "10:31");
        after.push(node(5, 0, "AXWindow", "Inbox", None));
        after.push(node(6, 1, "AXStaticText", "", Some("9 unread")));
        assert!(same_material_context(&before, &after, SEND));

        // But that window's own button is judged by its own window.
        let inbox_button = 6;
        let mut a = sheet("$40.00", "Rae", "10:31");
        a.push(node(5, 0, "AXWindow", "Inbox", None));
        a.push(node(6, 1, "AXButton", "Delete all", None));
        let mut b = a.clone();
        b[inbox_button] = node(6, 1, "AXButton", "Archive all", None);
        assert!(!same_material_context(&a, &b, inbox_button));
    }

    #[test]
    fn an_id_outside_the_tree_is_never_the_same_context() {
        let before = sheet("$40.00", "Rae", "10:31");
        assert!(!same_material_context(&before, &before, 99));
        assert!(!same_material_context(&[], &[], 0));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: usize, depth: usize, role: &str, label: Option<&str>, pressable: bool) -> AxNode {
        AxNode {
            id,
            depth,
            role: role.into(),
            label: label.map(str::to_string),
            value: None,
            pressable,
            ..Default::default()
        }
    }

    #[test]
    fn serialize_indents_and_marks_pressable() {
        let nodes = vec![
            node(0, 0, "AXApplication", Some("Safari"), false),
            node(1, 1, "AXButton", Some("Reload"), true),
        ];
        let out = serialize(&nodes);
        assert!(out.contains("[0] AXApplication \"Safari\""));
        assert!(out.contains("  [1] AXButton \"Reload\"  {pressable}"));
    }

    #[test]
    fn serialize_renders_value_and_clips_long_text() {
        let long = "x".repeat(300);
        let nodes = vec![AxNode {
            id: 0,
            depth: 0,
            role: "AXTextField".into(),
            label: Some("URL".into()),
            value: Some(long),
            pressable: false,
            ..Default::default()
        }];
        let out = serialize(&nodes);
        assert!(out.contains("[0] AXTextField \"URL\" = "));
        assert!(out.contains('…'));
        assert!(out.lines().next().unwrap().len() < 200);
    }

    #[test]
    fn serialize_handles_empty_tree_with_guidance() {
        let out = serialize(&[]);
        assert!(out.contains("no accessible elements"));
        assert!(out.contains("vision"));
    }

    #[test]
    fn serialize_caps_and_notes_omissions() {
        let nodes: Vec<AxNode> = (0..(MAX_NODES + 10))
            .map(|i| node(i, 0, "AXCell", None, false))
            .collect();
        let out = serialize(&nodes);
        assert!(out.contains("10 more elements omitted"));
        // The capped body has MAX_NODES element lines + the omission note.
        assert_eq!(
            out.lines().filter(|l| l.contains("AXCell")).count(),
            MAX_NODES
        );
    }

    #[test]
    fn only_actionable_elements_on_the_display_are_listed_focused_first() {
        let display = [0.0, 0.0, 1000.0, 500.0];
        let mut nodes = vec![
            node(0, 0, "AXWindow", Some("Doc"), false),
            node(1, 1, "AXButton", Some("Save"), true),
            node(2, 1, "AXStaticText", Some("hello"), false),
            node(3, 1, "AXTextField", Some("Name"), false),
            node(4, 1, "AXButton", Some("Offscreen"), true),
            node(5, 1, "AXButton", Some("Tiny"), true),
        ];
        nodes[1].frame = Some([100.0, 100.0, 50.0, 20.0]);
        nodes[2].frame = Some([0.0, 0.0, 100.0, 20.0]);
        nodes[3].frame = Some([200.0, 100.0, 200.0, 20.0]);
        nodes[3].focused = true;
        nodes[4].frame = Some([2000.0, 100.0, 50.0, 20.0]);
        nodes[5].frame = Some([10.0, 10.0, 1.0, 1.0]);
        let listed: Vec<usize> = on_screen_actionable(&nodes, display)
            .iter()
            .map(|(n, _)| n.id)
            .collect();
        assert_eq!(listed, [3, 1]);
        let rect = on_screen_actionable(&nodes, display)[1].1;
        for (got, want) in rect.iter().zip([0.1, 0.2, 0.05, 0.04]) {
            assert!((got - want).abs() < 1e-9, "{rect:?}");
        }
    }

    #[test]
    fn a_frame_is_normalized_to_its_display_and_clipped() {
        // A second display to the right of the main one.
        let second = [1512.0, 0.0, 2000.0, 1000.0];
        let close = |a: Option<[f64; 4]>, b: [f64; 4]| {
            let a = a.expect("on the display");
            a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9)
        };
        assert!(close(
            normalized_frame([2512.0, 500.0, 200.0, 100.0], second),
            [0.5, 0.5, 0.1, 0.1]
        ));
        // Half off the left edge: clipped, not dropped.
        assert!(close(
            normalized_frame([1412.0, 0.0, 200.0, 100.0], second),
            [0.0, 0.0, 0.05, 0.1]
        ));
        // On the other display entirely.
        assert_eq!(normalized_frame([0.0, 0.0, 100.0, 100.0], second), None);
        assert_eq!(normalized_frame([2000.0, 0.0, 0.0, 10.0], second), None);
    }

    #[test]
    fn pressable_lookup() {
        let nodes = vec![
            node(0, 0, "AXButton", None, true),
            node(1, 0, "AXStaticText", None, false),
        ];
        assert_eq!(pressable_by_id(&nodes, 0), Some(true));
        assert_eq!(pressable_by_id(&nodes, 1), Some(false));
        assert_eq!(pressable_by_id(&nodes, 99), None);
    }
}
