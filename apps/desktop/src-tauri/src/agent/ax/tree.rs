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
#[derive(Debug, Clone, PartialEq, Eq)]
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
}

/// Caps so a huge tree can't blow the model's context or our own memory. The
/// FFI walk honors these; kept here beside the serializer that also respects
/// them so the two never disagree.
pub const MAX_NODES: usize = 400;
pub const MAX_DEPTH: usize = 12;

// ── what makes an approval still apply (L-272) ───────────────────────────
//
// Approval used to be re-checked by comparing the whole flattened tree for
// byte equality. Every part of that is defensible on its own and the sum was
// unusable: a clock ticking over, a "saved 2 minutes ago" label, a progress
// bar, or a notification in another window of the same app all rejected an
// approval the person had just given, for an action that had not changed at
// all. A gate that fires on nothing is a gate people learn to work around.
//
// So the question is narrowed to what could change what pressing the button
// *does*:
//
//   - the same window (a different window of the same app is not this
//     decision, and its clock is not either);
//   - the same structure inside it — same nodes, same roles, same depths, same
//     actionability, so an app that re-laid itself out is a fresh decision;
//   - the same text, except for an explicit, enumerated list of forms that
//     change by themselves.
//
// That last list is deliberately a list of *forms*, not a similarity measure.
// "10:31" and "10:32" are both clocks. "$100" and "$200" are both money, and
// money is the thing an approval is about — so no digit-shape rule is used
// here, because one would make those two interchangeable.

/// A text form that changes on its own while meaning the same thing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VolatileForm {
    /// `10:31`, `1:05:22`, `10:31 PM`.
    Clock,
    /// `45%`.
    Percent,
    /// `3 minutes ago`.
    RelativeTime,
    /// `4 of 27`.
    Counter,
}

/// Which self-changing form this text is, if any.
///
/// Anything not on this list compares exactly. A recipient, an amount, a file
/// name and a document title are all "anything else".
pub fn volatile_form(text: &str) -> Option<VolatileForm> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    // `10:31`, `10:31 PM`, `1:05:22`
    let body = match t.rsplit_once(' ') {
        Some((head, tail))
            if tail.eq_ignore_ascii_case("am") || tail.eq_ignore_ascii_case("pm") =>
        {
            head
        }
        _ => t,
    };
    let parts: Vec<&str> = body.split(':').collect();
    if (2..=3).contains(&parts.len())
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && parts[0].len() <= 2
        && parts[1..].iter().all(|p| p.len() == 2)
    {
        return Some(VolatileForm::Clock);
    }
    if let Some(num) = t.strip_suffix('%') {
        let num = num.trim();
        if !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
            return Some(VolatileForm::Percent);
        }
    }
    if let Some(head) = t.strip_suffix(" ago") {
        let mut it = head.split_whitespace();
        if let (Some(n), Some(unit), None) = (it.next(), it.next(), it.next()) {
            const UNITS: [&str; 7] = ["second", "minute", "hour", "day", "week", "month", "year"];
            let unit = unit.trim_end_matches('s').to_ascii_lowercase();
            if n.bytes().all(|b| b.is_ascii_digit()) && UNITS.contains(&unit.as_str()) {
                return Some(VolatileForm::RelativeTime);
            }
        }
    }
    if let Some((a, b)) = t.split_once(" of ") {
        if !a.is_empty()
            && !b.is_empty()
            && a.bytes().all(|c| c.is_ascii_digit())
            && b.bytes().all(|c| c.is_ascii_digit())
        {
            return Some(VolatileForm::Counter);
        }
    }
    None
}

/// Are these two texts the same decision?
fn same_text(before: &Option<String>, after: &Option<String>) -> bool {
    match (before, after) {
        (Some(a), Some(b)) => {
            if a == b {
                return true;
            }
            // Only interchangeable when they are the same enumerated form.
            match (volatile_form(a), volatile_form(b)) {
                (Some(x), Some(y)) => x == y,
                _ => false,
            }
        }
        (None, None) => true,
        // Text appearing or disappearing is a change, not a tick.
        _ => false,
    }
}

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
/// Structure and text inside the target's own window, and nothing outside it.
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
            && same_text(&x.label, &y.label)
            && same_text(&x.value, &y.value)
    })
}

/// Truncate a label/value to keep one line readable and bounded.
fn clip(s: &str) -> String {
    const CAP: usize = 120;
    let one_line = s.replace(['\n', '\r'], " ");
    if one_line.chars().count() <= CAP {
        one_line
    } else {
        let truncated: String = one_line.chars().take(CAP).collect();
        format!("{truncated}…")
    }
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

    #[test]
    fn a_ticking_clock_does_not_revoke_an_approval() {
        // The defect: full equality meant a clock, a progress bar or a
        // "3 minutes ago" label rejected the same action, repeatedly, and the
        // person had no way to tell why.
        let before = sheet("$40.00", "Rae", "10:31");
        let after = sheet("$40.00", "Rae", "10:32");
        assert!(same_material_context(&before, &after, SEND));

        for (a, b) in [
            ("45%", "80%"),
            ("3 minutes ago", "4 minutes ago"),
            ("1 of 27", "2 of 27"),
            ("1:05:22", "1:05:23"),
            ("10:31 PM", "10:32 PM"),
        ] {
            assert!(
                same_material_context(&sheet("$40.00", "Rae", a), &sheet("$40.00", "Rae", b), SEND),
                "{a} -> {b} revoked an approval it should not have"
            );
        }
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
    fn the_volatile_list_is_a_list_of_forms_not_a_similarity_measure() {
        assert_eq!(volatile_form("10:31"), Some(VolatileForm::Clock));
        assert_eq!(volatile_form("1:05:22"), Some(VolatileForm::Clock));
        assert_eq!(volatile_form("10:31 pm"), Some(VolatileForm::Clock));
        assert_eq!(volatile_form("45%"), Some(VolatileForm::Percent));
        assert_eq!(
            volatile_form("3 minutes ago"),
            Some(VolatileForm::RelativeTime)
        );
        assert_eq!(volatile_form("4 of 27"), Some(VolatileForm::Counter));
        // Everything that decides something is not on the list.
        for decisive in [
            "$40.00",
            "Rae",
            "Delete account",
            "report-final.pdf",
            "40",
            "",
        ] {
            assert_eq!(
                volatile_form(decisive),
                None,
                "{decisive} was treated as volatile"
            );
        }
        // Two volatile values of *different* forms are still a change.
        assert!(!same_text(&Some("10:31".into()), &Some("45%".into())));
        // Text appearing is a change, not a tick.
        assert!(!same_text(&None, &Some("10:31".into())));
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
