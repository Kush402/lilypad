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

/// Is `id` a real element in this snapshot, and is it pressable? Used by the
/// executor to reject an `ax_press` for a bad or non-actionable id before it
/// ever touches the FFI.
pub fn pressable_by_id(nodes: &[AxNode], id: usize) -> Option<bool> {
    nodes.iter().find(|n| n.id == id).map(|n| n.pressable)
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
        assert_eq!(out.lines().filter(|l| l.contains("AXCell")).count(), MAX_NODES);
    }

    #[test]
    fn pressable_lookup() {
        let nodes = vec![node(0, 0, "AXButton", None, true), node(1, 0, "AXStaticText", None, false)];
        assert_eq!(pressable_by_id(&nodes, 0), Some(true));
        assert_eq!(pressable_by_id(&nodes, 1), Some(false));
        assert_eq!(pressable_by_id(&nodes, 99), None);
    }
}
