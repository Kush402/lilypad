//! Reading the words on the screen, on this Mac.
//!
//! Accessibility is the fastest way to know what a control is, and for most
//! Mac apps it is the only way that is also exact. It is also, often, absent:
//! an Electron window, a canvas, a game, a remote desktop and a screen shared
//! from another machine expose nothing an agent can act on. Ask used to end
//! there, because for a model that is never sent a picture the elements ARE
//! the screen (L-369).
//!
//! So when accessibility succeeds but offers nothing actionable, the pixels
//! are read here instead, by the Vision framework, on this Mac. The picture
//! and raw recognized text never leave it. [`labels`] bounds the local target
//! set; ADR-0022 separately requires the hosted request to use only a complete
//! recognized label already present in the person's command.

use anyhow::Result;

use super::vision::Frame;

/// One run of words found on the screen, and where it sits as a fraction of
/// the frame — `[x, y, w, h]` from the top left, the same space element
/// rectangles use.
#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub text: String,
    pub rect: [f64; 4],
}

/// The longest a run of words may be and still be a control's name. A
/// sentence on screen is a document being read, not a button.
const MAX_LABEL_CHARS: usize = 48;

/// How many local target names one screen may offer. The hosted boundary
/// filters these against the person's command before building any request.
const MAX_LABELS: usize = 40;

/// The words worth offering as things to click, largest first — a control's
/// name is set in the app's own type, and the biggest runs are its headings
/// and buttons rather than its fine print.
///
/// `off_limits` are rectangles the words must not come from: a text field's,
/// because what a person typed is theirs, and a password field's most of all.
pub fn labels(words: Vec<Word>, off_limits: &[[f64; 4]]) -> Vec<Word> {
    let mut out: Vec<Word> = words
        .into_iter()
        .filter(|w| reads_like_a_label(&w.text) && !off_limits.iter().any(|r| overlaps(w.rect, *r)))
        .collect();
    // Tallest first: a heading or a button label over a footnote.
    out.sort_by(|a, b| b.rect[3].total_cmp(&a.rect[3]));
    out.truncate(MAX_LABELS);
    out
}

/// Does a run of words read like the name of something, rather than like a
/// line of whatever the person is working on?
///
/// The screen an agent is blind to is often an editor or a terminal, and what
/// is on it is the person's work. Measured on this repository open in an
/// editor, this is what separates `env.example` and `Target Type` from
/// `"lint": "eslint src",` — punctuation that belongs to code and prose, and
/// nowhere in a button.
fn reads_like_a_label(text: &str) -> bool {
    const NEVER_IN_A_NAME: &[char] = &['"', '{', '}', ';', '=', '|', '\\', '`', '<'];
    let text = text.trim();
    !text.is_empty()
        && text.chars().count() <= MAX_LABEL_CHARS
        // Something to read: "08", "+" and "|" are not names.
        && text.chars().any(char::is_alphabetic)
        && !text.contains(NEVER_IN_A_NAME)
        && !text.ends_with(',')
}

/// Do two rectangles share any area? Used to keep a field's contents out of
/// what is offered, so the test is "touches at all", not "is mostly inside".
fn overlaps(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}

#[cfg(target_os = "macos")]
pub use macos::read;

/// Nothing to read where there is no Vision framework. The caller falls back
/// to accessibility alone, which is what every platform but macOS has.
#[cfg(not(target_os = "macos"))]
pub fn read(_frame: &Frame) -> Result<Vec<Word>> {
    Ok(Vec::new())
}

#[cfg(target_os = "macos")]
mod macos {
    use anyhow::{anyhow, Result};
    use image::ImageEncoder;
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
    };

    use super::{Frame, Word};

    /// Text shorter than this fraction of the screen's height is below what a
    /// Mac uses for a control, and asking for it costs time on every run.
    const MIN_TEXT_HEIGHT: f32 = 0.008;

    /// How sure the recognizer must be. Vision reports a candidate's own
    /// confidence; a name Ask may offer as a thing to click has to be a name
    /// it actually read.
    const MIN_CONFIDENCE: f32 = 0.4;

    /// JPEG quality for the recognizer. Higher than the 75 a model is sent:
    /// nothing here has to travel, and thin strokes are what is being read.
    const JPEG_QUALITY: u8 = 92;

    /// Every run of words the Vision framework finds on this frame.
    ///
    /// Blocking: encode, recognize, and read the results back. The caller
    /// runs it off the async threads, as it does the capture.
    pub fn read(frame: &Frame) -> Result<Vec<Word>> {
        let png = encode(frame)?;
        let data = NSData::with_bytes(&png);
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        // Control names are not prose. "Untitled 2" and "Xcode" come back
        // wrong when the recognizer is allowed to correct them into words.
        request.setUsesLanguageCorrection(false);
        request.setMinimumTextHeight(MIN_TEXT_HEIGHT);
        let requests: Retained<NSArray<VNRequest>> =
            NSArray::from_retained_slice(&[Retained::into_super(Retained::into_super(
                request.clone(),
            ))]);
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &NSDictionary::new(),
        );
        handler
            .performRequests_error(&requests)
            .map_err(|e| anyhow!("the screen could not be read: {e}"))?;

        let mut out = Vec::new();
        let Some(results) = request.results() else {
            return Ok(out);
        };
        for observation in results.iter() {
            let candidates = observation.topCandidates(1);
            let Some(best) = candidates.iter().next() else {
                continue;
            };
            if best.confidence() < MIN_CONFIDENCE {
                continue;
            }
            let text = best.string().to_string();
            // Vision measures from the bottom left in a 0..1 box; element
            // rectangles are measured from the top left. One flip, here,
            // rather than everywhere that reads a Word.
            // Safe in the only way this can be called: the observation came
            // back from the request above and is read before it is dropped.
            let box_ = unsafe { observation.boundingBox() };
            out.push(Word {
                text,
                rect: [
                    box_.origin.x,
                    1.0 - box_.origin.y - box_.size.height,
                    box_.size.width,
                    box_.size.height,
                ],
            });
        }
        Ok(out)
    }

    /// The frame as JPEG bytes, at a quality above the one a model is sent.
    ///
    /// Measured on a 2880x1800 screen: PNG took 3.9 seconds to encode, which
    /// is four times what the recognizer itself costs, for the same 136 runs
    /// of words that JPEG at this quality finds. Interface type is thin, so
    /// the quality is high; it is the compression time, not the compression,
    /// that made lossless the wrong trade here.
    fn encode(frame: &Frame) -> Result<Vec<u8>> {
        let mut jpeg = std::io::Cursor::new(Vec::new());
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
            .encode_image(&frame.rgba)
            .map_err(|e| anyhow!("the screen could not be encoded to read: {e}"))?;
        Ok(jpeg.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, rect: [f64; 4]) -> Word {
        Word {
            text: text.into(),
            rect,
        }
    }

    /// What a person typed is theirs. A field's rectangle is off limits even
    /// when the words in it are the only ones on screen.
    #[test]
    fn a_fields_contents_are_never_offered_as_a_name() {
        let words = vec![
            word("Send", [0.8, 0.9, 0.06, 0.03]),
            word("dinner at eight", [0.2, 0.5, 0.3, 0.03]),
        ];
        let field = [0.15, 0.48, 0.5, 0.06];
        let kept = labels(words, &[field]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].text, "Send");
    }

    /// Read off this repository open in an editor. The left column is what a
    /// person would click; the right is their work, and none of it is Ask's
    /// to offer or to send anywhere.
    #[test]
    fn a_line_of_someones_work_is_not_a_name() {
        for name in [
            "env.example",
            "Target Type",
            "Timeline",
            "Reply All",
            "Send",
        ] {
            assert!(reads_like_a_label(name), "{name}");
        }
        for work in [
            r#""lint": "eslint src","#,
            r#""@tauri-apps/cli": "^2.2.5","#,
            "const MAX = 40;",
            "08",
            "+",
        ] {
            assert!(!reads_like_a_label(work), "{work}");
        }
    }

    #[test]
    fn a_paragraph_is_not_a_control_name() {
        let long = "This message and any files transmitted with it are confidential";
        let kept = labels(
            vec![
                word(long, [0.1, 0.1, 0.8, 0.02]),
                word("Reply All", [0.1, 0.2, 0.1, 0.02]),
            ],
            &[],
        );
        assert_eq!(
            kept.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
            ["Reply All"]
        );
    }

    /// The biggest type on a screen is its headings and its buttons. Keeping
    /// those when there are more words than fit is the difference between a
    /// usable list and forty lines of fine print.
    #[test]
    fn the_largest_names_survive_a_busy_screen() {
        let mut words: Vec<Word> = (0..MAX_LABELS + 10)
            .map(|i| word("fine print", [0.0, i as f64 / 100.0, 0.05, 0.005]))
            .collect();
        words.push(word("Continue", [0.4, 0.8, 0.2, 0.04]));
        let kept = labels(words, &[]);
        assert_eq!(kept.len(), MAX_LABELS);
        assert_eq!(kept[0].text, "Continue");
    }

    /// The whole Vision path, end to end, on a picture with nothing to read:
    /// encode, hand to the framework, run the request, read the results back.
    /// A blank screen is the case that must come back empty rather than
    /// failing, and it exercises every call the real path makes.
    #[test]
    fn reading_a_blank_screen_finds_no_words_and_does_not_fail() {
        let frame = Frame {
            rgba: image::RgbaImage::from_pixel(200, 120, image::Rgba([255, 255, 255, 255])),
            bounds: [0.0, 0.0, 200.0, 120.0],
        };
        assert_eq!(read(&frame).expect("Vision answers"), Vec::new());
    }

    /// What this Mac's own screen says right now, printed. The device gate is
    /// where perception is judged; this is the loop to run while judging it.
    ///
    /// `cargo test --lib read_this_screen -- --ignored --nocapture`
    #[test]
    #[ignore = "reads the real screen; needs the Screen Recording grant"]
    fn read_this_screen() {
        let t0 = std::time::Instant::now();
        let frame = super::super::vision::grab(None).expect("a capture");
        let captured = t0.elapsed();
        let t1 = std::time::Instant::now();
        let words = read(&frame).expect("Vision answers");
        println!(
            "{}x{} captured in {} ms, read in {} ms, {} runs of words",
            frame.rgba.width(),
            frame.rgba.height(),
            captured.as_millis(),
            t1.elapsed().as_millis(),
            words.len()
        );
        for w in labels(words, &[]).iter().take(20) {
            println!("  {:?} at {:?}", w.text, w.rect);
        }
    }

    #[test]
    fn rectangles_that_merely_touch_count_as_overlapping() {
        assert!(overlaps([0.0, 0.0, 0.5, 0.5], [0.4, 0.4, 0.2, 0.2]));
        assert!(!overlaps([0.0, 0.0, 0.3, 0.3], [0.4, 0.4, 0.2, 0.2]));
    }
}
