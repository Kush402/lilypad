//! Key chords as models write them, parsed into something the backend can
//! press.
//!
//! A model says `ctrl+s`, `cmd+shift+t`, `Return`, `Page_Down`, `KP_Enter`,
//! `KeyS`, `⌘⇧T` or `Cmd-Q` and means the same few things. Every vendor's
//! computer-use tool uses xdotool keysym names; web-trained models use UI
//! Events codes; Mac-trained ones use Mac words and glyphs. All of them are
//! accepted here and reduced to one [`Chord`]: the modifiers held, and the key
//! pressed.
//!
//! A letter is kept as a [`Key::Char`] rather than a physical position.
//! "⌘Z" means "the key that types z", which on AZERTY is where QWERTY keeps
//! W — pressing the QWERTY position there would close the window instead of
//! undoing. The backend resolves characters through the current layout.

use super::Modifier;

/// The key a chord presses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    /// A physical key by its UI Events `code` ("Enter", "ArrowUp", "F5").
    Code(String),
    /// The key that types this character on the current layout.
    Char(char),
}

/// Modifiers held while one key is pressed. `key` is `None` for a chord that
/// is only modifiers ("shift", "ctrl+alt") — tapped on its own, or held.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    pub modifiers: Vec<Modifier>,
    pub key: Option<Key>,
}

impl Chord {
    /// Lower-case canonical parts, modifiers first — what the security gate
    /// compares against. A letter and its physical code canonicalize the same
    /// way, so `cmd+q` and `meta+KeyQ` are one chord to the gate.
    pub fn canonical(&self) -> Vec<String> {
        let mut parts: Vec<String> = self
            .modifiers
            .iter()
            .map(|m| match m {
                Modifier::Ctrl => "ctrl",
                Modifier::Alt => "alt",
                Modifier::Shift => "shift",
                Modifier::Meta => "meta",
            })
            .map(str::to_string)
            .collect();
        match &self.key {
            Some(Key::Code(code)) => parts.push(code.to_ascii_lowercase()),
            Some(Key::Char(c)) if c.is_ascii_alphabetic() => {
                parts.push(format!("key{}", c.to_ascii_lowercase()))
            }
            Some(Key::Char(c)) if c.is_ascii_digit() => parts.push(format!("digit{c}")),
            Some(Key::Char(c)) => parts.push(c.to_string()),
            None => {}
        }
        parts
    }

    /// How the chord reads to a person, e.g. "⌘⇧T", "Return", "⌃C".
    pub fn display(&self) -> String {
        let mut out = String::new();
        for m in [
            Modifier::Ctrl,
            Modifier::Alt,
            Modifier::Shift,
            Modifier::Meta,
        ] {
            if self.modifiers.contains(&m) {
                out.push(match m {
                    Modifier::Ctrl => '⌃',
                    Modifier::Alt => '⌥',
                    Modifier::Shift => '⇧',
                    Modifier::Meta => '⌘',
                });
            }
        }
        match &self.key {
            Some(Key::Char(' ')) => out.push_str("Space"),
            Some(Key::Char(c)) => out.extend(c.to_uppercase()),
            Some(Key::Code(code)) => out.push_str(match code.as_str() {
                "Enter" | "NumpadEnter" => "Return",
                "Backspace" => "Delete",
                "Delete" => "Forward Delete",
                "Escape" => "Esc",
                "ArrowUp" => "↑",
                "ArrowDown" => "↓",
                "ArrowLeft" => "←",
                "ArrowRight" => "→",
                other => other,
            }),
            None => {}
        }
        out
    }
}

fn modifier(word: &str) -> Option<Modifier> {
    Some(match word.to_ascii_lowercase().as_str() {
        "ctrl" | "control" | "ctl" | "control_l" | "control_r" | "controlleft" | "controlright"
        | "⌃" => Modifier::Ctrl,
        "alt" | "option" | "opt" | "alt_l" | "alt_r" | "altleft" | "altright" | "⌥" => {
            Modifier::Alt
        }
        "shift" | "shift_l" | "shift_r" | "shiftleft" | "shiftright" | "⇧" => Modifier::Shift,
        // On a Mac every one of these means Command. xdotool's `super` is the
        // Windows key on Linux, which is the key in Command's place.
        "cmd" | "command" | "super" | "super_l" | "super_r" | "meta" | "meta_l" | "meta_r"
        | "win" | "windows" | "metaleft" | "metaright" | "os" | "⌘" => Modifier::Meta,
        _ => return None,
    })
}

/// A named key: xdotool keysyms, UI Events codes and common spellings.
fn named(word: &str) -> Option<Key> {
    let code = |c: &str| Some(Key::Code(c.to_string()));
    let ch = |c: char| Some(Key::Char(c));
    let lower = word.to_ascii_lowercase();
    match lower.as_str() {
        "return" | "enter" | "ret" | "↩" | "⏎" => code("Enter"),
        "kp_enter" | "numpadenter" => code("NumpadEnter"),
        "tab" | "⇥" => code("Tab"),
        "space" | "spacebar" | "␣" => ch(' '),
        "backspace" | "back_space" | "⌫" => code("Backspace"),
        "delete" | "del" | "forwarddelete" | "forward_delete" | "⌦" => code("Delete"),
        "escape" | "esc" | "⎋" => code("Escape"),
        "up" | "arrowup" | "uparrow" | "↑" => code("ArrowUp"),
        "down" | "arrowdown" | "downarrow" | "↓" => code("ArrowDown"),
        "left" | "arrowleft" | "leftarrow" | "←" => code("ArrowLeft"),
        "right" | "arrowright" | "rightarrow" | "→" => code("ArrowRight"),
        "home" | "↖" => code("Home"),
        "end" | "↘" => code("End"),
        "page_up" | "pageup" | "prior" | "pgup" | "⇞" => code("PageUp"),
        "page_down" | "pagedown" | "next" | "pgdn" | "⇟" => code("PageDown"),
        "insert" | "help" => code("Help"),
        "capslock" | "caps_lock" | "⇪" => code("CapsLock"),
        "kp_add" | "numpadadd" => code("NumpadAdd"),
        "kp_subtract" | "numpadsubtract" => code("NumpadSubtract"),
        "kp_multiply" | "numpadmultiply" => code("NumpadMultiply"),
        "kp_divide" | "numpaddivide" => code("NumpadDivide"),
        "kp_decimal" | "numpaddecimal" => code("NumpadDecimal"),
        "kp_equal" | "numpadequal" => code("NumpadEqual"),
        "numlock" | "num_lock" | "clear" | "numpadclear" => code("NumpadClear"),
        "minus" | "hyphen" => ch('-'),
        "equal" | "equals" => ch('='),
        "plus" => ch('+'),
        "comma" => ch(','),
        "period" | "dot" => ch('.'),
        "slash" => ch('/'),
        "backslash" => ch('\\'),
        "semicolon" => ch(';'),
        "colon" => ch(':'),
        "apostrophe" | "quote" | "quoteright" => ch('\''),
        "quotedbl" => ch('"'),
        "grave" | "backquote" | "quoteleft" => ch('`'),
        "asciitilde" | "tilde" => ch('~'),
        "bracketleft" => ch('['),
        "bracketright" => ch(']'),
        "braceleft" => ch('{'),
        "braceright" => ch('}'),
        "parenleft" => ch('('),
        "parenright" => ch(')'),
        "less" => ch('<'),
        "greater" => ch('>'),
        "question" => ch('?'),
        "exclam" => ch('!'),
        "at" => ch('@'),
        "numbersign" => ch('#'),
        "dollar" => ch('$'),
        "percent" => ch('%'),
        "asciicircum" => ch('^'),
        "ampersand" => ch('&'),
        "asterisk" => ch('*'),
        "underscore" => ch('_'),
        "bar" => ch('|'),
        _ => {
            // F1…F20.
            if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
                if (1..=20).contains(&n) {
                    return Some(Key::Code(format!("F{n}")));
                }
            }
            // xdotool keypad digits, and web `Numpad0`…`Numpad9`.
            for prefix in ["kp_", "numpad"] {
                if let Some(d) = lower.strip_prefix(prefix) {
                    if d.len() == 1 && d.as_bytes()[0].is_ascii_digit() {
                        return Some(Key::Code(format!("Numpad{d}")));
                    }
                }
            }
            // Web codes for the character keys: `KeyS`, `Digit1`.
            if let Some(l) = lower.strip_prefix("key") {
                if l.len() == 1 && l.as_bytes()[0].is_ascii_alphabetic() {
                    return ch(l.as_bytes()[0] as char);
                }
            }
            if let Some(d) = lower.strip_prefix("digit") {
                if d.len() == 1 && d.as_bytes()[0].is_ascii_digit() {
                    return ch(d.as_bytes()[0] as char);
                }
            }
            None
        }
    }
}

/// One chord from one whitespace-free token: `ctrl+s`, `Cmd-Shift-T`, `⌘Q`,
/// `Return`, `a`.
fn parse_one(token: &str) -> Result<Chord, String> {
    let mut modifiers: Vec<Modifier> = Vec::new();
    let push = |m: Modifier, mods: &mut Vec<Modifier>| {
        if !mods.contains(&m) {
            mods.push(m);
        }
    };

    // Glyph form: leading modifier glyphs, then the key ("⌘⇧T").
    let mut rest = token;
    while let Some(c) = rest.chars().next() {
        let m = match c {
            '⌘' => Modifier::Meta,
            '⇧' => Modifier::Shift,
            '⌥' => Modifier::Alt,
            '⌃' => Modifier::Ctrl,
            _ => break,
        };
        push(m, &mut modifiers);
        rest = &rest[c.len_utf8()..];
    }

    // `+` separates, except that a trailing `+` (as in `ctrl++`) is the key.
    let mut parts: Vec<&str> = if rest == "+" {
        vec!["+"]
    } else if let Some(stripped) = rest.strip_suffix("++") {
        let mut v: Vec<&str> = stripped.split('+').collect();
        v.push("+");
        v
    } else {
        rest.split('+').collect()
    };
    // `-` separates only after a modifier word ("Cmd-Q", "ctrl-shift-a"),
    // never inside a key name or as the minus key itself.
    if parts.len() == 1 && parts[0].contains('-') && parts[0].len() > 1 {
        let token = parts[0];
        // "ctrl--" is Control and the minus key.
        let (body, minus_key) = match token.strip_suffix("--") {
            Some(body) => (body, true),
            None => (token, false),
        };
        let mut dashed: Vec<&str> = body.split('-').collect();
        let head_len = if minus_key {
            dashed.len()
        } else {
            dashed.len() - 1
        };
        let head = &dashed[..head_len];
        if !head.is_empty()
            && head.iter().all(|w| modifier(w).is_some())
            && (minus_key || dashed.last().is_some_and(|k| !k.is_empty()))
        {
            if minus_key {
                dashed.push("-");
            }
            parts = dashed;
        }
    }

    let mut key: Option<Key> = None;
    for part in parts {
        if part.is_empty() {
            return Err(format!("`{token}` has an empty part"));
        }
        if let Some(m) = modifier(part) {
            push(m, &mut modifiers);
            continue;
        }
        if key.is_some() {
            return Err(format!(
                "`{token}` names more than one key; press them as separate chords"
            ));
        }
        key = Some(match named(part) {
            Some(k) => k,
            None => {
                let mut chars = part.chars();
                match (chars.next(), chars.next()) {
                    // Letter case is not a modifier: `cmd+S` is ⌘S. Shift is
                    // asked for by name.
                    (Some(c), None) => Key::Char(if c.is_ascii_uppercase() {
                        c.to_ascii_lowercase()
                    } else {
                        c
                    }),
                    _ => return Err(format!("unknown key `{part}` in `{token}`")),
                }
            }
        });
    }
    if key.is_none() && modifiers.is_empty() {
        return Err(format!("`{token}` names no key"));
    }
    Ok(Chord { modifiers, key })
}

/// Parse a key specification into the chords to press in order. Whitespace
/// separates chords (`ctrl+a Delete`), as in xdotool. A lone space is the
/// space bar.
pub fn parse_keys(spec: &str) -> Result<Vec<Chord>, String> {
    if spec == " " {
        return Ok(vec![Chord {
            modifiers: vec![],
            key: Some(Key::Char(' ')),
        }]);
    }
    let chords: Vec<Chord> = spec
        .split_whitespace()
        .map(parse_one)
        .collect::<Result<_, _>>()?;
    match chords.len() {
        0 => Err("no key was given".into()),
        n if n > 16 => Err(format!(
            "{n} chords in one key action; send at most 16, or use `type` for text"
        )),
        _ => Ok(chords),
    }
}

/// Parse modifiers only, as a click's or scroll's `text` field carries them
/// ("shift", "ctrl+shift", "cmd").
pub fn parse_modifiers(spec: &str) -> Result<Vec<Modifier>, String> {
    let chords = parse_keys(spec)?;
    let mut out = Vec::new();
    for chord in chords {
        if chord.key.is_some() {
            return Err(format!(
                "`{spec}` is not only modifier keys; use shift, ctrl, alt or cmd"
            ));
        }
        for m in chord.modifiers {
            if !out.contains(&m) {
                out.push(m);
            }
        }
    }
    Ok(out)
}

/// The US-layout position of a character, as a UI Events code plus whether
/// Shift is needed — the fallback when the real layout cannot be read.
pub fn us_key_for_char(c: char) -> Option<(String, bool)> {
    let code = |s: &str, shift: bool| Some((s.to_string(), shift));
    match c {
        'a'..='z' => Some((format!("Key{}", c.to_ascii_uppercase()), false)),
        'A'..='Z' => Some((format!("Key{c}"), true)),
        '0'..='9' => Some((format!("Digit{c}"), false)),
        ' ' => code("Space", false),
        '-' => code("Minus", false),
        '_' => code("Minus", true),
        '=' => code("Equal", false),
        '+' => code("Equal", true),
        '[' => code("BracketLeft", false),
        '{' => code("BracketLeft", true),
        ']' => code("BracketRight", false),
        '}' => code("BracketRight", true),
        '\\' => code("Backslash", false),
        '|' => code("Backslash", true),
        ';' => code("Semicolon", false),
        ':' => code("Semicolon", true),
        '\'' => code("Quote", false),
        '"' => code("Quote", true),
        ',' => code("Comma", false),
        '<' => code("Comma", true),
        '.' => code("Period", false),
        '>' => code("Period", true),
        '/' => code("Slash", false),
        '?' => code("Slash", true),
        '`' => code("Backquote", false),
        '~' => code("Backquote", true),
        '!' => code("Digit1", true),
        '@' => code("Digit2", true),
        '#' => code("Digit3", true),
        '$' => code("Digit4", true),
        '%' => code("Digit5", true),
        '^' => code("Digit6", true),
        '&' => code("Digit7", true),
        '*' => code("Digit8", true),
        '(' => code("Digit9", true),
        ')' => code("Digit0", true),
        _ => None,
    }
}

/// Split text into the units one synthetic key event carries.
///
/// One user-perceived character per event, not one `char`: a flag, a family
/// emoji or an accented letter written as base + combining mark is several
/// code points, and splitting them across events lets an app see the halves
/// as separate characters. Not full UAX #29 — the cases that actually break
/// typing are covered: ZWJ sequences, variation selectors, combining marks,
/// skin tones, tag sequences and regional-indicator pairs.
pub fn text_units(text: &str) -> Vec<String> {
    fn extends(c: char) -> bool {
        matches!(c as u32,
            0x200D                // zero-width joiner
            | 0xFE00..=0xFE0F     // variation selectors
            | 0x0300..=0x036F     // combining diacritical marks
            | 0x1AB0..=0x1AFF
            | 0x1DC0..=0x1DFF
            | 0x20D0..=0x20FF
            | 0xFE20..=0xFE2F
            | 0x1F3FB..=0x1F3FF   // skin tones
            | 0xE0020..=0xE007F   // tag characters
        )
    }
    fn regional(c: char) -> bool {
        (0x1F1E6..=0x1F1FF).contains(&(c as u32))
    }
    let mut units: Vec<String> = Vec::new();
    let mut after_zwj = false;
    let mut open_flag = false;
    for c in text.chars() {
        let join = match units.last() {
            None => false,
            Some(_) if c == '\n' || c == '\t' || c == '\r' => false,
            Some(last) if last == "\n" || last == "\t" || last == "\r" => false,
            Some(_) => extends(c) || after_zwj || (regional(c) && open_flag),
        };
        if join {
            units.last_mut().unwrap().push(c);
        } else {
            units.push(c.to_string());
        }
        open_flag = regional(c) && !(join && open_flag);
        after_zwj = c == '\u{200D}';
    }
    units
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(spec: &str) -> Chord {
        let mut v = parse_keys(spec).unwrap_or_else(|e| panic!("{spec}: {e}"));
        assert_eq!(v.len(), 1, "{spec}");
        v.remove(0)
    }

    #[test]
    fn every_dialect_of_save_is_the_same_chord() {
        for spec in [
            "cmd+s",
            "Cmd+S",
            "command+s",
            "super+s",
            "meta+KeyS",
            "⌘S",
            "⌘s",
            "Cmd-S",
            "cmd+KeyS",
        ] {
            assert_eq!(one(spec).canonical(), ["meta", "keys"], "{spec}");
        }
    }

    #[test]
    fn xdotool_names_map_to_the_keys_they_mean() {
        let code = |s: &str| one(s).key.unwrap();
        assert_eq!(code("Return"), Key::Code("Enter".into()));
        assert_eq!(code("KP_Enter"), Key::Code("NumpadEnter".into()));
        assert_eq!(code("Page_Down"), Key::Code("PageDown".into()));
        assert_eq!(code("Prior"), Key::Code("PageUp".into()));
        assert_eq!(code("BackSpace"), Key::Code("Backspace".into()));
        assert_eq!(code("Delete"), Key::Code("Delete".into()));
        assert_eq!(code("KP_7"), Key::Code("Numpad7".into()));
        assert_eq!(code("F13"), Key::Code("F13".into()));
        assert_eq!(code("F20"), Key::Code("F20".into()));
        assert_eq!(code("minus"), Key::Char('-'));
        assert_eq!(code("space"), Key::Char(' '));
        assert!(parse_keys("F21").is_err());
    }

    #[test]
    fn plus_and_minus_can_be_the_key_itself() {
        assert_eq!(one("ctrl++").canonical(), ["ctrl", "+"]);
        assert_eq!(one("cmd+plus").canonical(), ["meta", "+"]);
        assert_eq!(one("+").canonical(), ["+"]);
        assert_eq!(one("-").canonical(), ["-"]);
        assert_eq!(one("cmd+-").canonical(), ["meta", "-"]);
        assert_eq!(one("ctrl--").canonical(), ["ctrl", "-"]);
        assert_eq!(one("Cmd-Shift-T").canonical(), ["meta", "shift", "keyt"]);
    }

    #[test]
    fn glyphs_and_modifier_only_chords_parse() {
        assert_eq!(one("⌘⇧T").canonical(), ["meta", "shift", "keyt"]);
        assert_eq!(one("⌃⌘Q").canonical(), ["ctrl", "meta", "keyq"]);
        let shift = one("shift");
        assert_eq!(shift.key, None);
        assert_eq!(shift.modifiers, vec![Modifier::Shift]);
        assert_eq!(
            parse_modifiers("ctrl+shift").unwrap(),
            vec![Modifier::Ctrl, Modifier::Shift]
        );
        assert!(parse_modifiers("ctrl+s").is_err());
    }

    #[test]
    fn sequences_split_on_whitespace() {
        let v = parse_keys("ctrl+a Delete").unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[1].key, Some(Key::Code("Delete".into())));
        assert_eq!(parse_keys(" ").unwrap()[0].key, Some(Key::Char(' ')));
        assert!(parse_keys("").is_err());
        assert!(parse_keys("   ").is_err());
        assert!(parse_keys(&"a ".repeat(17)).is_err());
    }

    #[test]
    fn nonsense_is_an_error_with_the_reason() {
        assert!(parse_keys("ctrl+s+d")
            .unwrap_err()
            .contains("more than one key"));
        assert!(parse_keys("hyperspace")
            .unwrap_err()
            .contains("unknown key"));
        assert!(parse_keys("ctrl+").is_err());
    }

    #[test]
    fn the_display_form_is_what_a_mac_user_reads() {
        assert_eq!(one("cmd+shift+t").display(), "⇧⌘T");
        assert_eq!(one("Return").display(), "Return");
        assert_eq!(one("ctrl+c").display(), "⌃C");
        assert_eq!(one("space").display(), "Space");
    }

    #[test]
    fn us_fallback_covers_printable_ascii() {
        for c in (0x20u8..0x7F).map(char::from) {
            assert!(us_key_for_char(c).is_some(), "{c:?}");
        }
        assert_eq!(us_key_for_char('Q'), Some(("KeyQ".into(), true)));
        assert_eq!(us_key_for_char('é'), None);
    }

    #[test]
    fn text_units_keep_composed_characters_whole() {
        assert_eq!(text_units("ab"), ["a", "b"]);
        // Family emoji: three people joined by ZWJs is one unit.
        let family = "👨\u{200D}👩\u{200D}👧";
        assert_eq!(text_units(&format!("x{family}y")), ["x", family, "y"]);
        // Flags are regional-indicator pairs; two flags are two units.
        assert_eq!(text_units("🇫🇷🇩🇪"), ["🇫🇷", "🇩🇪"]);
        // e + combining acute stays one unit.
        assert_eq!(text_units("e\u{301}!"), ["e\u{301}", "!"]);
        // Skin tone and variation selector attach.
        assert_eq!(text_units("👍🏽❤️"), ["👍🏽", "❤️"]);
        // Newlines and tabs are their own units, never joined.
        assert_eq!(text_units("a\n\tb"), ["a", "\n", "\t", "b"]);
    }
}
