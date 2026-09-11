//! Which of an endpoint's models Ask can actually use (L-291).
//!
//! ### The defect this exists for
//!
//! A person set up Gemini, pressed "List models", and picked
//! `models/gemini-2.5-flash-native-audio-preview-12-2025` — an id the endpoint
//! itself returned. Google then refused every request, because that model is
//! reached over the Live API's bidirectional WebSocket and Ask sends chat
//! completions. Nothing in the flow could have told them: discovery kept
//! `data[].id`, sorted it, and offered every name with equal confidence.
//!
//! A catalogue lists names. It does not say what the thing behind a name is
//! for. Ask needs one specific thing — text generation over a request/response
//! transport, with tool calls — and several families of model that every
//! catalogue contains cannot do it at all: live/native-audio models want a
//! socket, embedding models return vectors, image and speech models do not
//! take a tool schema.
//!
//! ### What this is, and what it is deliberately not
//!
//! It is a **prefilter built from the provider's own metadata**. Where a
//! provider publishes what methods a model supports — Google does, under
//! `supportedGenerationMethods` — that answer decides. Where no metadata
//! exists, every model stays [`Suitability::Unknown`] and the probe is the
//! only thing that settles it.
//!
//! It is **not** a capability claim. `Usable` means "nothing known rules this
//! out", not "tools and images work" — that is what [`super::probe`] measures,
//! and nothing here replaces it (L-263, L-264).
//!
//! It is **not** a name-shape rule. Guessing from substrings is how a filter
//! starts refusing valid models the week a vendor changes a naming convention,
//! and it never sees a model whose name says nothing. Names are used for one
//! narrow purpose below — matching a catalogue entry to its own metadata —
//! never to decide what a model can do.

use serde::Serialize;
use std::collections::HashMap;

/// What is known about whether Ask can use a model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Suitability {
    /// The provider says this model does text generation over the transport
    /// Ask uses. Still unproven for tools and images until the probe runs.
    Usable,
    /// The provider says this model cannot serve an Ask request at all.
    /// Selecting it would fail on the first message, every time.
    Unsuitable,
    /// The endpoint published no method metadata, so nothing is known. The
    /// model is offered; the probe decides.
    Unknown,
}

/// One model the endpoint offers, with what is known about it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub suitability: Suitability,
    /// Why, in the person's words. Empty when there is nothing to explain.
    pub reason: String,
}

/// The generation method Ask's request/response transport maps onto.
const REQUIRED_METHOD: &str = "generatecontent";

/// Methods that describe a different transport or a different job, and the
/// words for what they are. Matched exactly against the provider's own method
/// names, lowercased — not against the model's name.
fn method_explanation(method: &str) -> Option<&'static str> {
    match method {
        "bidigeneratecontent" => Some(
            "This is a Live model: it needs a continuous two-way audio connection, \
             which Ask does not open. Choose a text model instead.",
        ),
        "embedcontent" | "batchembedcontents" => Some(
            "This model turns text into vectors for search. It does not hold a \
             conversation, so Ask cannot use it.",
        ),
        "predict" | "predictlongrunning" => Some(
            "This model generates images, video or speech rather than text. \
             Ask needs a text model that can call tools.",
        ),
        _ => None,
    }
}

/// Decide suitability from the methods a provider says a model supports.
///
/// `None` means the provider said nothing about this model, which is not the
/// same as saying no.
pub fn from_methods(methods: Option<&[String]>) -> (Suitability, String) {
    let Some(methods) = methods else {
        return (Suitability::Unknown, String::new());
    };
    if methods.is_empty() {
        return (Suitability::Unknown, String::new());
    }
    let lowered: Vec<String> = methods.iter().map(|m| m.to_ascii_lowercase()).collect();
    if lowered.iter().any(|m| m == REQUIRED_METHOD) {
        return (Suitability::Usable, String::new());
    }
    // It cannot serve a chat request. Say which other thing it is for, when the
    // provider named a method this knows about.
    let reason = lowered
        .iter()
        .find_map(|m| method_explanation(m))
        .unwrap_or(
            "This endpoint does not list this model as able to answer a chat \
             request, so Ask cannot use it.",
        );
    (Suitability::Unsuitable, reason.to_string())
}

/// Google publishes a model's name as `models/<id>`; its OpenAI-compatible
/// catalogue returns the same string. Compare on the bare id so a change of
/// prefix on either side cannot silently stop matching.
fn bare(id: &str) -> &str {
    id.rsplit('/').next().unwrap_or(id)
}

/// Method metadata, keyed by the bare model id.
pub type MethodIndex = HashMap<String, Vec<String>>;

/// Parse Google's `/v1beta/models` response into a method index.
///
/// Anything unparseable yields an empty index, which means "nothing known" —
/// never "nothing supported". A metadata endpoint that fails must not be able
/// to hide every model from the list.
pub fn google_method_index(body: &serde_json::Value) -> MethodIndex {
    let mut index = MethodIndex::new();
    extend_method_index(&mut index, body);
    index
}

/// Google's catalogue is **paged** — `models.list` returns 50 by default and
/// hands back a `nextPageToken`. Google publishes well over 50 models, so a
/// single request covers part of the catalogue and no more.
///
/// That matters here in one direction only, and it is the direction this file
/// exists for: a model absent from the metadata stays [`Suitability::Unknown`]
/// and is offered. So fetching one page leaves the Live Audio model offered
/// without a word whenever it happens to sit past the page boundary — which is
/// the original defect, back again, decided by catalogue position.
pub fn next_page_token(body: &serde_json::Value) -> Option<String> {
    body.get("nextPageToken")
        .and_then(|t| t.as_str())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

/// Fold one page of `models.list` into an index.
pub fn extend_method_index(index: &mut MethodIndex, body: &serde_json::Value) {
    let Some(rows) = body.get("models").and_then(|m| m.as_array()) else {
        return;
    };
    for row in rows {
        let Some(name) = row.get("name").and_then(|n| n.as_str()) else {
            continue;
        };
        let methods: Vec<String> = row
            .get("supportedGenerationMethods")
            .and_then(|m| m.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|m| m.as_str())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        if methods.is_empty() {
            continue;
        }
        index.insert(bare(name).to_string(), methods);
    }
}

/// Turn a catalogue of ids plus whatever metadata was obtained into the list
/// the setup screen offers.
///
/// Ids the metadata does not mention stay `Unknown`: a partial index must not
/// condemn what it does not cover.
pub fn options(ids: &[String], index: &MethodIndex) -> Vec<ModelOption> {
    ids.iter()
        .map(|id| {
            let methods = index.get(bare(id)).map(|m| m.as_slice());
            let (suitability, reason) = from_methods(methods);
            ModelOption {
                id: id.clone(),
                suitability,
                reason,
            }
        })
        .collect()
}

/// What is known about one id — including one typed by hand, which never
/// passed through the catalogue at all (L-291).
pub fn lookup(id: &str, index: &MethodIndex) -> ModelOption {
    let (suitability, reason) = from_methods(index.get(bare(id)).map(|m| m.as_slice()));
    ModelOption {
        id: id.to_string(),
        suitability,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn methods(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// The exact model the customer chose, and the exact catalogue it came
    /// from. Before this module the id was offered like any other.
    #[test]
    fn the_live_audio_model_the_customer_chose_is_not_offered_for_ask() {
        let catalogue = serde_json::json!({
            "models": [
                {
                    "name": "models/gemini-2.5-flash",
                    "supportedGenerationMethods": ["generateContent", "countTokens"]
                },
                {
                    "name": "models/gemini-2.5-flash-native-audio-preview-12-2025",
                    "supportedGenerationMethods": ["bidiGenerateContent", "countTokens"]
                },
                {
                    "name": "models/text-embedding-004",
                    "supportedGenerationMethods": ["embedContent"]
                },
                {
                    "name": "models/imagen-4.0-generate-001",
                    "supportedGenerationMethods": ["predict"]
                }
            ]
        });
        let index = google_method_index(&catalogue);
        let ids = vec![
            "models/gemini-2.5-flash".to_string(),
            "models/gemini-2.5-flash-native-audio-preview-12-2025".to_string(),
            "models/text-embedding-004".to_string(),
            "models/imagen-4.0-generate-001".to_string(),
        ];
        let offered = options(&ids, &index);

        assert_eq!(offered[0].suitability, Suitability::Usable);

        let live = &offered[1];
        assert_eq!(
            live.suitability,
            Suitability::Unsuitable,
            "the Live Audio model was offered for Ask"
        );
        assert!(
            live.reason.contains("Live"),
            "the refusal did not say why: {}",
            live.reason
        );
        assert_eq!(offered[2].suitability, Suitability::Unsuitable);
        assert!(
            offered[2].reason.contains("vectors"),
            "{}",
            offered[2].reason
        );
        assert_eq!(offered[3].suitability, Suitability::Unsuitable);
    }

    /// A typed id gets the same answer as a chosen one, or the setup screen is
    /// only guarding the easy path.
    #[test]
    fn a_hand_typed_id_is_judged_by_the_same_metadata() {
        let catalogue = serde_json::json!({
            "models": [{
                "name": "models/gemini-live-2.5-flash-preview",
                "supportedGenerationMethods": ["bidiGenerateContent"]
            }]
        });
        let index = google_method_index(&catalogue);
        // Typed without the `models/` prefix, which is how a person would.
        let typed = lookup("gemini-live-2.5-flash-preview", &index);
        assert_eq!(typed.suitability, Suitability::Unsuitable);
        // And an id the metadata has never heard of stays open, not condemned.
        assert_eq!(
            lookup("some-gateway/private-model", &index).suitability,
            Suitability::Unknown
        );
    }

    /// The rule is the provider's metadata, never the shape of the name. A
    /// model called "audio" that says it does `generateContent` is usable, and
    /// a blandly-named one that says it does not, is not.
    #[test]
    fn suitability_comes_from_the_declared_method_not_the_name() {
        let catalogue = serde_json::json!({
            "models": [
                {
                    "name": "models/gemini-2.5-flash-audio-understanding",
                    "supportedGenerationMethods": ["generateContent"]
                },
                {
                    "name": "models/perfectly-ordinary-name",
                    "supportedGenerationMethods": ["bidiGenerateContent"]
                }
            ]
        });
        let index = google_method_index(&catalogue);
        assert_eq!(
            lookup("models/gemini-2.5-flash-audio-understanding", &index).suitability,
            Suitability::Usable,
            "a name-shape rule would have refused this one"
        );
        assert_eq!(
            lookup("models/perfectly-ordinary-name", &index).suitability,
            Suitability::Unsuitable,
            "a name-shape rule would have allowed this one"
        );
    }

    /// An endpoint with no metadata must not lose its catalogue. Silence is
    /// not a refusal.
    #[test]
    fn no_metadata_means_unknown_and_everything_still_offered() {
        let index = google_method_index(&serde_json::json!({ "error": "nope" }));
        assert!(index.is_empty());
        let ids = vec!["llama3.1:8b".to_string(), "qwen2.5-coder".to_string()];
        let offered = options(&ids, &index);
        assert_eq!(offered.len(), 2);
        for option in &offered {
            assert_eq!(option.suitability, Suitability::Unknown);
            assert!(option.reason.is_empty());
        }
    }

    /// Google pages its catalogue. One request is one page, and a model on a
    /// later page has no metadata — so it is offered, unmarked, which is the
    /// defect this module was written to remove.
    #[test]
    fn a_live_model_on_a_later_page_is_still_caught() {
        let page_one = serde_json::json!({
            "models": [{
                "name": "models/gemini-2.5-flash",
                "supportedGenerationMethods": ["generateContent"]
            }],
            "nextPageToken": "page-2"
        });
        let page_two = serde_json::json!({
            "models": [{
                "name": "models/gemini-2.5-flash-native-audio-preview-12-2025",
                "supportedGenerationMethods": ["bidiGenerateContent"]
            }]
        });

        assert_eq!(next_page_token(&page_one).as_deref(), Some("page-2"));
        assert_eq!(
            next_page_token(&page_two),
            None,
            "a last page must end the walk"
        );

        // Page one alone: the Live model is invisible, so it is offered.
        let first_only = google_method_index(&page_one);
        assert_eq!(
            lookup(
                "models/gemini-2.5-flash-native-audio-preview-12-2025",
                &first_only
            )
            .suitability,
            Suitability::Unknown
        );

        // Both pages: it is caught, exactly as if it had been on page one.
        let mut index = MethodIndex::new();
        extend_method_index(&mut index, &page_one);
        extend_method_index(&mut index, &page_two);
        assert_eq!(
            lookup(
                "models/gemini-2.5-flash-native-audio-preview-12-2025",
                &index
            )
            .suitability,
            Suitability::Unsuitable,
            "a paged catalogue let the Live Audio model through"
        );
        assert_eq!(
            lookup("models/gemini-2.5-flash", &index).suitability,
            Suitability::Usable,
            "merging pages must not lose the earlier one"
        );
    }

    /// A model listed with methods that are all unknown to this file is still
    /// refused — it said what it does, and chat is not among it — but the
    /// explanation must not pretend to know which other thing it is.
    #[test]
    fn an_unrecognised_method_is_refused_without_inventing_a_reason() {
        let (suitability, reason) = from_methods(Some(&methods(&["somethingEntirelyNew"])));
        assert_eq!(suitability, Suitability::Unsuitable);
        assert!(reason.contains("does not list this model"), "{reason}");
        // An empty list is silence, not a claim.
        assert_eq!(from_methods(Some(&[])).0, Suitability::Unknown);
        assert_eq!(from_methods(None).0, Suitability::Unknown);
    }
}
