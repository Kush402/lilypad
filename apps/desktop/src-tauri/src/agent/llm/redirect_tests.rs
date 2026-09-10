//! L-284 — a provider endpoint cannot redirect a credential or an observation
//! to another origin.
//!
//! reqwest's own redirect policy strips `authorization`, `cookie` and
//! `proxy-authorization` when the host changes, and nothing else. Anthropic
//! authenticates with `x-api-key`, which is not on that list. A 307 or 308
//! carries the request **body** as well, and for a chat request the body is the
//! observation: window titles and screen text read from the person's Mac.
//!
//! The claim under test is counted network behaviour rather than a policy
//! setting: the second origin must receive **zero** requests. Both servers are
//! local, both credentials are fake, and nothing leaves this machine.
//!
//! In-crate rather than under `tests/` because `commands` and `agent` are
//! private modules, and widening the crate's surface to reach them would be a
//! larger change than the test is worth.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Drain one request's headers so the peer is not left writing into a closed
/// socket. The content is not asserted on; arrival is the whole signal.
fn drain_request(stream: &mut TcpStream) {
    let Ok(clone) = stream.try_clone() else { return };
    let mut reader = BufReader::new(clone);
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) if line == "\r\n" || line == "\n" => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
}

/// A server that answers every request with `status` pointing at `location`.
fn redirector(status: u16, location: String) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind redirector");
    let addr = listener.local_addr().expect("addr").to_string();
    let handle = std::thread::spawn(move || {
        let _ = listener.set_nonblocking(true);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    drain_request(&mut stream);
                    let response = format!(
                        "HTTP/1.1 {status} Moved\r\nLocation: {location}\r\n\
                         Content-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                    return;
                }
                Err(_) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
    });
    (addr, handle)
}

/// A server that must never be reached. Counts anything that arrives.
fn tripwire() -> (String, Arc<AtomicUsize>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind tripwire");
    let addr = listener.local_addr().expect("addr").to_string();
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&hits);
    let handle = std::thread::spawn(move || {
        let _ = listener.set_nonblocking(true);
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    // Only ever runs if the boundary failed, which is the point.
                    counter.fetch_add(1, Ordering::SeqCst);
                    drain_request(&mut stream);
                    let _ = stream.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                          Content-Length: 11\r\nConnection: close\r\n\r\n{\"data\":[]}",
                    );
                }
                Err(_) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
    });
    (addr, hits, handle)
}

#[tokio::test]
async fn model_discovery_does_not_follow_a_redirect_to_another_origin() {
    let (trip_addr, hits, trip) = tripwire();
    let (from_addr, redir) = redirector(301, format!("http://{trip_addr}/v1/models"));

    let result = crate::commands::list_agent_models(crate::commands::ListModelsArgs {
        provider_kind: "openai_compat".to_string(),
        base_url: Some(format!("http://{from_addr}/v1")),
        // Fake, and never sent anywhere but the loopback redirector.
        api_key: Some("sk-test-not-a-real-key".to_string()),
    })
    .await;

    let err = result.expect_err("a redirect must not be followed");
    assert!(
        err.contains(&trip_addr),
        "the refusal should name where it was being sent: {err}"
    );

    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "discovery followed a redirect to a second origin"
    );
    let _ = redir.join();
    let _ = trip.join();
}

#[tokio::test]
async fn a_chat_request_does_not_follow_a_307_to_another_origin() {
    use super::anthropic::{AnthropicConfig, AnthropicProvider};
    use super::{Block, ChatMessage, LlmProvider, Role};

    let (trip_addr, hits, trip) = tripwire();
    // 307 preserves the method AND the body. The body here stands in for what a
    // real run would have read off the person's screen.
    let (from_addr, redir) = redirector(307, format!("http://{trip_addr}/v1/messages"));

    let mut config = AnthropicConfig::new("fake-key-for-this-test", "test-model");
    config.base_url = format!("http://{from_addr}");
    let provider = AnthropicProvider::new(config);

    let reply = provider
        .complete(
            "system",
            &[ChatMessage {
                role: Role::User,
                blocks: vec![Block::Text("synthetic observation".to_string())],
            }],
            &[],
        )
        .await;

    let err = reply.expect_err("a 307 must not be followed").to_string();
    assert!(
        err.contains(&trip_addr),
        "the refusal should name where it was being sent: {err}"
    );

    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "a chat request followed a 307 to a second origin, carrying its body"
    );
    let _ = redir.join();
    let _ = trip.join();
}
