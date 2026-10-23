//! The test client reuses its connections (carried over from stage Э3, review of 23.10): on macOS
//! a connection per request filled the table of ports in TIME_WAIT and the long simulation runs
//! failed on the transport. A keep-alive connection must serve many requests; a connection the
//! server closed in between must not fail the next request.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;

use amby_sync_conformance::Api;

/// Reads one request head (no bodies in these tests); `None` when the peer closed.
fn read_head(stream: &mut TcpStream) -> Option<()> {
    let mut seen = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) | Err(_) => return None,
            Ok(_) => seen.push(byte[0]),
        }
        if seen.ends_with(b"\r\n\r\n") {
            return Some(());
        }
    }
}

/// A server that counts accepted connections. `serve_per_connection` requests are answered on a
/// connection (keep-alive), then the connection is closed without a word.
fn counting_server(serve_per_connection: usize) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let accepted = Arc::new(AtomicUsize::new(0));
    let counter = accepted.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            counter.fetch_add(1, Ordering::SeqCst);
            thread::spawn(move || {
                for _ in 0..serve_per_connection {
                    if read_head(&mut stream).is_none() {
                        return;
                    }
                    let body = b"{\"ok\":true}";
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                        body.len()
                    );
                    if stream.write_all(head.as_bytes()).is_err() || stream.write_all(body).is_err()
                    {
                        return;
                    }
                }
            });
        }
    });
    (base, accepted)
}

#[test]
fn many_requests_share_one_connection() {
    let (base, accepted) = counting_server(1_000);
    let api = Api::new(&base);
    for _ in 0..25 {
        api.get("/v1/info", None).expect(200);
    }
    assert!(
        accepted.load(Ordering::SeqCst) <= 2,
        "25 requests opened {} connections",
        accepted.load(Ordering::SeqCst)
    );
}

#[test]
fn a_connection_the_server_closed_does_not_fail_the_next_request() {
    // The server closes each connection after two answers; the client has to notice and open a
    // new one instead of failing with a transport error.
    let (base, accepted) = counting_server(2);
    let api = Api::new(&base);
    for _ in 0..9 {
        api.get("/v1/info", None).expect(200);
    }
    let opened = accepted.load(Ordering::SeqCst);
    assert!(
        (4..=6).contains(&opened),
        "9 requests at 2 per connection used {opened} connections"
    );
}

#[test]
fn clones_of_a_client_share_the_pool() {
    let (base, accepted) = counting_server(1_000);
    let api = Api::new(&base);
    let clones: Vec<Api> = (0..4).map(|_| api.clone()).collect();
    for round in 0..5 {
        for clone in &clones {
            clone
                .get(&format!("/v1/info?round={round}"), None)
                .expect(200);
        }
    }
    assert!(
        accepted.load(Ordering::SeqCst) <= 2,
        "20 requests of 4 clones opened {} connections",
        accepted.load(Ordering::SeqCst)
    );
}
