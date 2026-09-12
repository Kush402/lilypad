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

/// What a provider actually published about its models, in that provider's own
/// vocabulary (L-310, L-312).
///
/// There is no shared schema for "can this model do the job", so there is no
/// shared parser either. Each arm is one endpoint's documented field, read
/// literally. A provider that publishes nothing gets `Silent`, which means
/// nothing is known and everything is offered — never "nothing is supported".
pub enum Catalogue {
    /// Google's `supportedGenerationMethods`, keyed by the bare model id.
    Methods(MethodIndex),
    /// OpenRouter's `supported_parameters`, keyed by the FULL id. Its ids
    /// carry a vendor prefix (`google/…`, `meta-llama/…`) and two vendors
    /// publishing the same model name is ordinary, so the prefix is part of
    /// the key rather than something to strip.
    Parameters(MethodIndex),
    /// This endpoint published nothing. Everything is offered; the probe is
    /// what settles it.
    Silent,
}

/// The parameter Ask cannot work without.
///
/// Ask is a tool-calling loop: the model asks the Mac to click, type, read the
/// screen. A model that cannot call tools cannot do any of it, and the failure
/// arrives as a model that chats politely and never acts.
const REQUIRED_PARAMETER: &str = "tools";

/// Decide suitability from the parameters an OpenAI-compatible gateway says a
/// model accepts.
///
/// On OpenRouter's catalogue, 2026-09-11: 66 of 443 models did not list
/// `tools`. They were all offered, and every one of them would have failed to
/// do anything useful.
pub fn from_parameters(parameters: Option<&[String]>) -> (Suitability, String) {
    let Some(parameters) = parameters else {
        return (Suitability::Unknown, String::new());
    };
    if parameters.is_empty() {
        return (Suitability::Unknown, String::new());
    }
    if parameters
        .iter()
        .any(|p| p.eq_ignore_ascii_case(REQUIRED_PARAMETER))
    {
        return (Suitability::Usable, String::new());
    }
    (
        Suitability::Unsuitable,
        "This endpoint does not list tool calling for this model. Ask works by calling tools \
         on your Mac, so a model without them could describe what to do but never do it."
            .to_string(),
    )
}

/// A routing variant appended to a model id after a colon (L-310).
///
/// ### Why this is not "judging a model by its name"
///
/// `method_explanation` above deliberately reads a provider's own method names
/// and never the model's name, because a name is marketing. A variant suffix is
/// neither: on OpenRouter it is documented routing grammar, and
/// `google/gemini-3-flash-preview:batch` is a *different destination* from
/// `google/gemini-3-flash-preview`, not a differently-branded one.
///
/// ### Why it has to be the id at all
///
/// Because nothing else says so. Fetched and diffed 2026-09-11: `pricing` is
/// the ONLY field that differs between that pair. `supported_parameters` still
/// lists `tools`, `architecture` still says text output. The endpoint's own
/// answer to a chat request is "This model is only available through the Batch
/// API" — which arrives far too late to help anybody choosing from a list.
///
/// 77 of OpenRouter's 443 models carried `:batch` on that day, and this runs
/// before the parameter check because every one of them lists `tools`.
fn batch_variant(id: &str) -> Option<(Suitability, String)> {
    // Only the last segment: the vendor prefix is `/`-separated and never
    // carries a variant.
    let variant = bare(id).rsplit_once(':')?.1;
    if !variant.eq_ignore_ascii_case("batch") {
        // `:free` is the same model on a rate-limited route. It answers chat
        // requests, so it is not this function's business.
        return None;
    }
    Some((
        Suitability::Unsuitable,
        "This is the batch version of the model. It answers through a queue that returns \
         results later, not the live connection Ask uses. Choose the same model without \
         the :batch ending."
            .to_string(),
    ))
}

/// What is known about one id, read in the vocabulary its provider published.
fn verdict(id: &str, catalogue: &Catalogue) -> (Suitability, String) {
    match catalogue {
        Catalogue::Silent => (Suitability::Unknown, String::new()),
        Catalogue::Methods(index) => from_methods(index.get(bare(id)).map(|m| m.as_slice())),
        Catalogue::Parameters(index) => {
            if let Some(found) = batch_variant(id) {
                return found;
            }
            from_parameters(index.get(id).map(|p| p.as_slice()))
        }
    }
}

/// Whether this endpoint's own `/models` response carries
/// `supported_parameters`, which is what `Catalogue::Parameters` reads.
///
/// A predicate rather than an inline comparison because the caller builds the
/// origin with `store::origin_of` and this decides against it: if the two ever
/// disagree about spelling, the capability data is silently dropped and every
/// model goes back to `Unknown`. The test below pins them together.
pub fn publishes_parameters(origin: &str) -> bool {
    origin.ends_with("://openrouter.ai")
}

/// What is known against this model id from the id and its destination alone —
/// no catalogue, no request (L-316).
///
/// Everything else in this module judges a model against a catalogue the setup
/// screen fetched. That is enforcement in the *list*, and a list is only
/// consulted by someone standing in front of it: a model saved before the
/// catalogue could refuse it stays saved, and the run that uses it fails at the
/// provider. That happened on a released build — `agent-settings.json` held a
/// `:batch` id and the run died with Batch API 404 fifteen seconds after the
/// phone rang.
///
/// A routing variant is the one verdict that needs nothing fetched, because it
/// is in the id. So it is also the one that can be enforced where the run
/// starts, which is the only place a stale setting is ever read again.
pub fn refusal_without_a_catalogue(origin: &str, id: &str) -> Option<String> {
    if !publishes_parameters(origin) {
        return None;
    }
    batch_variant(id).map(|(_, why)| why)
}

/// Parse OpenRouter's `/models` response into its `supported_parameters`.
///
/// Read from the catalogue response the setup screen already fetched: the
/// capability data and the id list arrive together, so this costs no second
/// request. Anything unparseable yields an empty index, which means "nothing
/// known" and never "nothing supported".
pub fn openrouter_parameter_index(body: &serde_json::Value) -> MethodIndex {
    let mut index = MethodIndex::new();
    let Some(rows) = body.get("data").and_then(|d| d.as_array()) else {
        return index;
    };
    for row in rows {
        let Some(id) = row.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(parameters) = row.get("supported_parameters").and_then(|v| v.as_array()) else {
            continue;
        };
        index.insert(
            id.to_string(),
            parameters
                .iter()
                .filter_map(|p| p.as_str())
                .map(str::to_string)
                .collect(),
        );
    }
    index
}

/// Turn a catalogue of ids plus whatever the provider published into the list
/// the setup screen offers.
///
/// Ids the provider said nothing about stay `Unknown`: partial knowledge must
/// not condemn what it does not cover.
pub fn options(ids: &[String], catalogue: &Catalogue) -> Vec<ModelOption> {
    ids.iter()
        .map(|id| {
            let (suitability, reason) = verdict(id, catalogue);
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
pub fn lookup(id: &str, catalogue: &Catalogue) -> ModelOption {
    let (suitability, reason) = verdict(id, catalogue);
    ModelOption {
        id: id.to_string(),
        suitability,
        reason,
    }
}

#[cfg(test)]
mod tests {

    /// L-316. The one verdict that needs nothing fetched, so the one that can
    /// be enforced where a stale setting is read again.
    #[test]
    fn the_catalogue_free_verdict_is_the_routing_variant_and_only_that() {
        let why = refusal_without_a_catalogue(
            "https://openrouter.ai",
            "google/gemini-3-flash-preview:batch",
        )
        .expect("a batch route cannot answer a live request");
        assert!(why.contains("without the :batch ending"), "{why}");

        // The same id without the variant, and an unrelated id, say nothing.
        assert_eq!(
            refusal_without_a_catalogue("https://openrouter.ai", "google/gemini-3-flash-preview"),
            None
        );
        assert_eq!(
            refusal_without_a_catalogue("https://openrouter.ai", "anthropic/claude-opus-4-8:free"),
            None
        );
        // A colon means something else everywhere else — `llama3.1:8b` is a
        // tag on a local server, and this must never speak for that endpoint.
        assert_eq!(
            refusal_without_a_catalogue("http://localhost:11434", "llama3.1:batch"),
            None
        );
    }
    use super::*;

    /// The origin every Google case below is about.
    const GOOGLE: &str = "https://generativelanguage.googleapis.com";
    const OPENROUTER: &str = "https://openrouter.ai";

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
        let offered = options(&ids, &Catalogue::Methods(index));

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
        let typed = lookup(
            "gemini-live-2.5-flash-preview",
            &Catalogue::Methods(index.clone()),
        );
        assert_eq!(typed.suitability, Suitability::Unsuitable);
        // And an id the metadata has never heard of stays open, not condemned.
        assert_eq!(
            lookup(
                "some-gateway/private-model",
                &Catalogue::Methods(index.clone())
            )
            .suitability,
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
            lookup(
                "models/gemini-2.5-flash-audio-understanding",
                &Catalogue::Methods(index.clone())
            )
            .suitability,
            Suitability::Usable,
            "a name-shape rule would have refused this one"
        );
        assert_eq!(
            lookup(
                "models/perfectly-ordinary-name",
                &Catalogue::Methods(index.clone())
            )
            .suitability,
            Suitability::Unsuitable,
            "a name-shape rule would have allowed this one"
        );
    }

    /// OpenRouter's catalogue, in the shape OpenRouter actually serves
    /// (L-310, L-312).
    ///
    /// Rows below are trimmed copies of `https://openrouter.ai/api/v1/models`
    /// fetched 2026-09-11. That day it held 443 models: **77 ended in
    /// `:batch`** and **66 did not list `tools`**. All 143 were offered, and
    /// the owner picked `google/gemini-3-flash-preview:batch` from that list on
    /// a clean v0.1.36 install, which is why Ask could not run at all.
    fn openrouter_catalogue() -> serde_json::Value {
        serde_json::json!({
            "data": [
                {
                    "id": "google/gemini-3-flash-preview",
                    "supported_parameters": ["max_tokens", "tools", "tool_choice", "temperature"]
                },
                {
                    // The batch twin. `pricing` is the only field that differs
                    // from the row above on the real endpoint -- it lists
                    // `tools` exactly like its sibling, which is why the
                    // variant check has to run before the parameter check.
                    "id": "google/gemini-3-flash-preview:batch",
                    "supported_parameters": ["max_tokens", "tools", "tool_choice", "temperature"]
                },
                {
                    // Real row, real reason: a translation model that answers
                    // chat requests and cannot call a single tool.
                    "id": "tencent/hy-mt2-7b",
                    "supported_parameters": ["max_tokens", "temperature", "top_p"]
                },
                {
                    "id": "meta-llama/llama-3.3-70b-instruct:free",
                    "supported_parameters": ["max_tokens", "tools", "temperature"]
                },
                {
                    // Published with no parameter list at all.
                    "id": "some-vendor/brand-new-model"
                }
            ]
        })
    }

    #[test]
    fn openrouter_models_that_cannot_call_tools_are_not_offered() {
        let catalogue = Catalogue::Parameters(openrouter_parameter_index(&openrouter_catalogue()));
        let ids = vec![
            "google/gemini-3-flash-preview".to_string(),
            "google/gemini-3-flash-preview:batch".to_string(),
            "tencent/hy-mt2-7b".to_string(),
            "meta-llama/llama-3.3-70b-instruct:free".to_string(),
            "some-vendor/brand-new-model".to_string(),
        ];
        let offered = options(&ids, &catalogue);

        assert_eq!(
            offered[0].suitability,
            Suitability::Usable,
            "the provider says this one calls tools"
        );
        assert_eq!(
            offered[1].suitability,
            Suitability::Unsuitable,
            "a batch-only model was offered for Ask"
        );
        assert!(offered[1].reason.contains("batch"), "{}", offered[1].reason);
        assert_eq!(
            offered[2].suitability,
            Suitability::Unsuitable,
            "Ask is a tool-calling loop and this model cannot call one"
        );
        assert!(offered[2].reason.contains("tool"), "{}", offered[2].reason);
        // `:free` is the same model on a rate-limited route. It answers chat
        // requests, and removing it would take away the only models somebody
        // without credit can use.
        assert_eq!(
            offered[3].suitability,
            Suitability::Usable,
            "the free route was mistaken for a batch route"
        );
        // Silence is not refusal. A model published with no parameter list is
        // offered, and the probe decides.
        assert_eq!(offered[4].suitability, Suitability::Unknown);
        assert!(offered[4].reason.is_empty());
    }

    /// OpenRouter ids carry a vendor prefix and two vendors publishing the same
    /// model name is ordinary, so the index keys on the whole id. Keying on the
    /// bare name would let one vendor's metadata answer for another's model.
    #[test]
    fn openrouter_capability_is_keyed_on_the_whole_id() {
        let catalogue = Catalogue::Parameters(openrouter_parameter_index(&serde_json::json!({
            "data": [
                { "id": "vendor-a/shared-name", "supported_parameters": ["tools"] },
                { "id": "vendor-b/shared-name", "supported_parameters": ["temperature"] }
            ]
        })));
        assert_eq!(
            lookup("vendor-a/shared-name", &catalogue).suitability,
            Suitability::Usable
        );
        assert_eq!(
            lookup("vendor-b/shared-name", &catalogue).suitability,
            Suitability::Unsuitable
        );
    }

    /// An endpoint that answers with something else entirely must lose nothing.
    #[test]
    fn an_unparseable_openrouter_answer_condemns_nothing() {
        let index = openrouter_parameter_index(&serde_json::json!({ "error": "nope" }));
        assert!(index.is_empty());
        let offered = options(
            &["anything/at-all".to_string()],
            &Catalogue::Parameters(index),
        );
        assert_eq!(offered[0].suitability, Suitability::Unknown);
    }

    /// The predicate decides against an origin it does not build. A silent
    /// disagreement about spelling would drop the capability data and put
    /// every model back to `Unknown`, with every other test still passing.
    #[test]
    fn the_openrouter_preset_resolves_to_the_origin_the_predicate_matches() {
        let origin = crate::agent::llm::store::origin_of("https://openrouter.ai/api/v1")
            .expect("the shipped OpenRouter base URL must parse");
        assert_eq!(origin, OPENROUTER);
        assert!(publishes_parameters(&origin));
        assert!(!publishes_parameters(GOOGLE));
        // Not a suffix match on the bare host: a lookalike domain must not
        // inherit OpenRouter's vocabulary.
        assert!(!publishes_parameters("https://notopenrouter.ai"));
    }

    /// The rule is grammar on one gateway, not a rule about colons.
    #[test]
    fn a_colon_in_an_id_is_ordinary_everywhere_else() {
        // Ollama tags are `name:tag`, and a local endpoint publishes no
        // metadata either. Condemning these would empty the list.
        let ids = vec!["llama3.1:8b".to_string(), "qwen2.5-coder:batch".to_string()];
        let offered = options(&ids, &Catalogue::Silent);
        for option in &offered {
            assert_eq!(
                option.suitability,
                Suitability::Unknown,
                "{} was condemned on an endpoint whose variant grammar we do not know",
                option.id
            );
        }
    }

    /// An endpoint with no metadata must not lose its catalogue. Silence is
    /// not a refusal.
    #[test]
    fn no_metadata_means_unknown_and_everything_still_offered() {
        let index = google_method_index(&serde_json::json!({ "error": "nope" }));
        assert!(index.is_empty());
        let ids = vec!["llama3.1:8b".to_string(), "qwen2.5-coder".to_string()];
        let offered = options(&ids, &Catalogue::Methods(index));
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
                &Catalogue::Methods(first_only.clone())
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
                &Catalogue::Methods(index.clone())
            )
            .suitability,
            Suitability::Unsuitable,
            "a paged catalogue let the Live Audio model through"
        );
        assert_eq!(
            lookup(
                "models/gemini-2.5-flash",
                &Catalogue::Methods(index.clone())
            )
            .suitability,
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
