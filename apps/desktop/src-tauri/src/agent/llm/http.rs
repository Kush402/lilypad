//! The HTTP shell both adapters share: bounded reading, then classification,
//! then parsing — in that order (L-275, L-276).
//!
//! The order is the fix. Both adapters used to call `resp.json()` first and
//! look at the status afterwards, which has two consequences that only look
//! unrelated:
//!
//!   1. **No byte bound.** `json()` buys the whole body before anything
//!      validates it. Output-token limits bound what a *model* writes; they
//!      bound nothing about what an endpoint returns, and a custom or
//!      misbehaving gateway is exactly the case the person is most likely to
//!      have typed in themselves.
//!   2. **HTML failures fell out of the retry path.** A 429 or 502 from a
//!      proxy is usually an HTML page. Parsing before checking meant the
//!      request died at "response was not JSON" — no `Retry-After`, no
//!      backoff, and an error message that named JSON when the real answer was
//!      "you are rate limited".
//!
//! So: read the status and headers, collect a bounded body, classify, and only
//! then try to parse. A structured error body is a bonus, not a requirement.

use anyhow::{anyhow, Result};
use serde_json::Value;

/// Hard ceiling on a provider response held in memory. Generous next to any
/// real completion (which the adapters cap by `max_tokens` anyway) and small
/// next to what an error page or a broken gateway can produce.
pub(crate) const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// How much of a failure body is quoted back into an error message. Error text
/// reaches logs and the setup screen; an HTML page in either is noise.
const MAX_QUOTED_ERROR_BYTES: usize = 600;

/// What went wrong, in terms the setup screen can act on. "Something failed"
/// is not a recovery instruction; "that key was rejected" is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureKind {
    /// The credential was rejected (401/403).
    Auth,
    /// Authenticated, but out of credit or over a hard quota (402, and a 429
    /// that survived the retry budget).
    Quota,
    /// The endpoint does not know this model (404, or a message that says so).
    UnknownModel,
    /// The endpoint refused the request itself — wrong dialect, missing
    /// deployment id, unsupported tool schema.
    BadRequest,
    /// The service is failing or unreachable right now (5xx after retries).
    Unavailable,
    /// Could not connect: DNS, TLS, refused, timed out.
    Transport,
    /// A success status carrying something that is not the expected JSON.
    Malformed,
    /// The endpoint answered with a redirect to somewhere else. Not followed
    /// (L-284): the person agreed to an origin, and a redirect is that origin
    /// naming a different one.
    Redirected,
}

impl FailureKind {
    /// Is retrying this the same request likely to help? Used by the setup
    /// screen to choose between "Try again" and "Fix the setting".
    pub fn is_transient(self) -> bool {
        matches!(self, FailureKind::Unavailable | FailureKind::Transport)
    }
}

#[derive(Debug, Clone)]
pub struct ProviderFailure {
    pub kind: FailureKind,
    pub status: Option<u16>,
    /// Already bounded and stripped of markup. Safe for a log line or a label.
    pub message: String,
}

impl std::fmt::Display for ProviderFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(status) => write!(f, "provider API error ({status}): {}", self.message),
            None => write!(f, "{}", self.message),
        }
    }
}
impl std::error::Error for ProviderFailure {}

/// Read a response body up to [`MAX_RESPONSE_BYTES`], refusing rather than
/// truncating.
///
/// Truncation would be worse than refusal here: half a JSON document parses as
/// nothing, and half an error page reads as a different error. Chunked bodies
/// with no `Content-Length` are the normal case, so the limit is enforced as
/// bytes accumulate rather than trusted from a header — a compressed body that
/// expands past the limit is caught the same way, because this counts what was
/// decoded, not what arrived.
pub(crate) async fn collect_bounded(resp: reqwest::Response) -> Result<Vec<u8>> {
    let mut resp = resp;
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await? {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(anyhow!(
                "the provider's reply is larger than {} bytes, which no valid response is",
                MAX_RESPONSE_BYTES
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Collapse a body into something quotable: lossy UTF-8, tags removed, runs of
/// whitespace collapsed, bounded.
pub(crate) fn quotable(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let mut out = String::new();
    let mut in_tag = false;
    let mut last_space = true;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                if !last_space {
                    out.push(' ');
                    last_space = true;
                }
            }
            _ if in_tag => {}
            c if c.is_whitespace() => {
                if !last_space {
                    out.push(' ');
                    last_space = true;
                }
            }
            c => {
                out.push(c);
                last_space = false;
                if out.len() >= MAX_QUOTED_ERROR_BYTES {
                    out.push('…');
                    return out;
                }
            }
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        "the provider sent an empty reply".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Classify a non-success response. `body` is already bounded.
pub(crate) fn classify(status: u16, body: &[u8]) -> ProviderFailure {
    // A structured error is preferred; a gateway's HTML is not a reason to
    // lose the status, which is the part that says what to do next.
    let structured = serde_json::from_slice::<Value>(body)
        .ok()
        .map(|json| super::provider_error_message(&json));
    let message = structured.unwrap_or_else(|| quotable(body));
    let lowered = message.to_ascii_lowercase();
    let kind = match status {
        401 | 403 => FailureKind::Auth,
        402 => FailureKind::Quota,
        404 => FailureKind::UnknownModel,
        429 => FailureKind::Quota,
        400 | 422 if lowered.contains("model") && lowered.contains("not") => {
            FailureKind::UnknownModel
        }
        400..=499 => FailureKind::BadRequest,
        _ => FailureKind::Unavailable,
    };
    ProviderFailure {
        kind,
        status: Some(status),
        message,
    }
}

/// Describe a redirect this client refused to follow.
///
/// Named, not swallowed: "the address you configured is redirecting elsewhere"
/// is something a person can act on, and it is the only honest thing to say
/// when the alternative is carrying their key to a host they never chose.
pub(crate) fn refused_redirect(status: u16, location: Option<&str>) -> ProviderFailure {
    let message = match location {
        Some(target) => format!(
            "That address redirects to {target}, which is a different destination from the one \
             you set up. Lilypad does not follow it, because your key and what Ask read from \
             your screen would go there too. If the endpoint really has moved, enter the new \
             address yourself."
        ),
        None => "That address answered with a redirect but did not say where to. Lilypad does \
                 not follow redirects for provider requests."
            .to_string(),
    };
    ProviderFailure {
        kind: FailureKind::Redirected,
        status: Some(status),
        message,
    }
}

/// The `Location` of a response, when it has a usable one.
pub(crate) fn location_of(resp: &reqwest::Response) -> Option<String> {
    resp.headers()
        .get(reqwest::header::LOCATION)?
        .to_str()
        .ok()
        .map(|s| s.chars().take(200).collect())
}

/// Classify a connection-level error, which never reached a status.
pub(crate) fn classify_transport(err: &reqwest::Error) -> ProviderFailure {
    ProviderFailure {
        kind: FailureKind::Transport,
        status: None,
        message: format!("could not reach the provider: {err}"),
    }
}

/// Parse a bounded success body, keeping "not JSON" a distinct outcome from
/// "the request failed".
pub(crate) fn parse_success(body: &[u8]) -> std::result::Result<Value, ProviderFailure> {
    serde_json::from_slice(body).map_err(|_| ProviderFailure {
        kind: FailureKind::Malformed,
        status: None,
        message: format!("the provider replied with something that is not JSON: {}", quotable(body)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_html_gateway_failure_keeps_its_status_and_retry_class() {
        // L-276, the exact shape that used to exit at "response was not JSON".
        let html = b"<html><head><title>502 Bad Gateway</title></head>\
                     <body><h1>502 Bad Gateway</h1><p>nginx</p></body></html>";
        let failure = classify(502, html);
        assert_eq!(failure.kind, FailureKind::Unavailable);
        assert!(failure.kind.is_transient());
        assert!(failure.message.contains("502 Bad Gateway"), "{}", failure.message);
        assert!(!failure.message.contains('<'), "markup survived: {}", failure.message);
    }

    #[test]
    fn a_plain_text_rate_limit_is_a_quota_failure_not_a_parse_error() {
        let failure = classify(429, b"Too Many Requests\n\nslow down");
        assert_eq!(failure.kind, FailureKind::Quota);
        assert!(failure.message.contains("Too Many Requests"));
    }

    #[test]
    fn an_empty_503_still_says_something_useful() {
        let failure = classify(503, b"");
        assert_eq!(failure.kind, FailureKind::Unavailable);
        assert!(failure.message.contains("empty reply"));
    }

    #[test]
    fn a_rejected_key_is_distinguishable_from_a_missing_model() {
        assert_eq!(
            classify(401, br#"{"error":{"message":"Incorrect API key"}}"#).kind,
            FailureKind::Auth
        );
        assert_eq!(
            classify(404, br#"{"error":{"message":"The model `x` does not exist"}}"#).kind,
            FailureKind::UnknownModel
        );
        assert_eq!(
            classify(400, br#"{"error":{"message":"model not found: llama9"}}"#).kind,
            FailureKind::UnknownModel
        );
        // An ordinary 400 stays a request problem, not a model problem.
        assert_eq!(
            classify(400, br#"{"error":{"message":"unsupported parameter"}}"#).kind,
            FailureKind::BadRequest
        );
        assert!(!FailureKind::Auth.is_transient());
    }

    #[test]
    fn quoted_error_text_is_bounded() {
        let huge = vec![b'x'; 10 * 1024];
        let quoted = quotable(&huge);
        assert!(quoted.len() <= MAX_QUOTED_ERROR_BYTES + 4, "{}", quoted.len());
        assert!(quoted.ends_with('…'));
    }

    #[test]
    fn a_refused_redirect_names_where_it_wanted_to_go() {
        let failure = refused_redirect(301, Some("https://elsewhere.example/v1"));
        assert_eq!(failure.kind, FailureKind::Redirected);
        assert!(failure.message.contains("elsewhere.example"), "{}", failure.message);
        assert!(!failure.kind.is_transient(), "retrying the same address will redirect again");
        // A redirect with no Location still refuses rather than guessing.
        assert_eq!(refused_redirect(302, None).kind, FailureKind::Redirected);
    }

    #[test]
    fn malformed_success_json_is_its_own_category() {
        let failure = parse_success(b"{not json").unwrap_err();
        assert_eq!(failure.kind, FailureKind::Malformed);
    }
}
