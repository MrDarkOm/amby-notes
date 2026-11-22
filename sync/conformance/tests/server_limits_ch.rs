//! Appendix Ч: the low-risk findings of the Э5 security review — event streams per device and the
//! body read timeout (Б7), and temporary files of parallel uploads (Б8).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use amby_sync_conformance::client::{enroll, new_item, Space, PASSWORD};
use amby_sync_conformance::{in_process_or_skip, Sse, Target};
use amby_sync_server::store::{BlobKey, BlobStore, FsBlobStore};

fn open(space: &Space) -> Sse {
    let mut stream = space
        .api
        .open_events(
            &space.path("/events"),
            Some(&space.token),
            Duration::from_secs(10),
        )
        .unwrap_or_else(|answer| panic!("the stream did not open: HTTP {}", answer.status));
    assert_eq!(stream.next_real_event().expect("no hello").name, "hello");
    stream
}

/// Whether the stream ends well before its 10 s read timeout would.
fn ends_soon(stream: &mut Sse) -> bool {
    let started = Instant::now();
    stream.next_real_event().is_none() && started.elapsed() < Duration::from_secs(5)
}

#[test]
fn a_device_keeps_at_most_four_event_streams_and_the_oldest_ends() {
    // Ч2: a fifth stream of the same device closes the oldest; the other four keep working.
    let target = Target::from_env();
    let space = enroll(&target, PASSWORD).create_space();
    let mut streams: Vec<Sse> = (0..5).map(|_| open(&space)).collect();
    assert!(
        ends_soon(&mut streams[0]),
        "the oldest stream must end when a fifth opens"
    );
    space.commit_ok(&[space.folder(&new_item(), 0, "A")]);
    for (index, stream) in streams.iter_mut().enumerate().skip(1) {
        let event = stream
            .next_real_event()
            .unwrap_or_else(|| panic!("stream {index} ended or heard nothing"));
        assert_eq!(event.name, "commit", "stream {index}");
    }
}

#[test]
fn another_device_has_its_own_four_streams() {
    // Ч2: the limit is per device, not per account.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    let mut first: Vec<Sse> = (0..4).map(|_| open(&space)).collect();
    let second = account.another_device("second");
    let other = Space {
        token: second.token.clone(),
        ..space.clone()
    };
    let _others: Vec<Sse> = (0..4).map(|_| open(&other)).collect();
    space.commit_ok(&[space.folder(&new_item(), 0, "B")]);
    for stream in &mut first {
        assert_eq!(stream.next_real_event().expect("ended").name, "commit");
    }
}

#[test]
fn a_body_that_stops_arriving_is_refused_after_the_timeout() {
    // Ч3: a request whose body stalls gets `408 request_timeout` instead of holding the
    // connection until the client goes away.
    let target = Target::in_process_with(|config| config.body_timeout_secs = 1);
    let _ = in_process_or_skip!(target);
    let space = enroll(&target, PASSWORD).create_space();
    let base = target.api.base().trim_start_matches("http://").to_string();
    let mut stream = TcpStream::connect(&base).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    let path = space.path("/commit");
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {base}\r\nAuthorization: Bearer {}\r\n\
         Content-Type: application/json\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{{",
        space.token
    );
    stream.write_all(head.as_bytes()).unwrap();
    stream.flush().unwrap();
    let started = Instant::now();
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the server waited for the body too long"
    );
    assert!(text.starts_with("HTTP/1.1 408"), "answer: {text:?}");
    assert!(text.contains("request_timeout"), "answer: {text:?}");
}

#[test]
fn parallel_uploads_of_the_same_part_and_body_do_not_trip_over_each_other() {
    // Ч4: each write uses its own temporary file, so two uploads of the same part or two
    // `complete` calls never share one; every call succeeds and leaves a whole file.
    let dir = std::env::temp_dir().join(format!("amby-sync-ch-{}", hex::encode(rand_bytes())));
    let store = std::sync::Arc::new(FsBlobStore::new(&dir));
    let key = BlobKey {
        space_id: [1; 16],
        blob_id: [2; 16],
    };
    store.create(&key, 0).unwrap();
    let workers: Vec<_> = (0..4u8)
        .map(|worker| {
            let store = store.clone();
            std::thread::spawn(move || {
                let data = vec![worker; 256 * 1024];
                for _ in 0..40 {
                    store.put_part(&key, 0, &data).expect("a part write failed");
                    store.assemble(&key, 1).expect("joining the body failed");
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    let body = store.read(&key, None).unwrap();
    assert_eq!(body.len(), 256 * 1024);
    assert!(
        body.iter().all(|byte| *byte == body[0]),
        "a body mixed two uploads"
    );
    let _ = std::fs::remove_dir_all(dir);
}

fn rand_bytes() -> [u8; 8] {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    (nanos as u64 ^ u64::from(std::process::id())).to_le_bytes()
}
