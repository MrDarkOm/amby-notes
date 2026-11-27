//! Server-Sent Events: "check the feed" notifications (Р11, П34).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use amby_sync_conformance::client::{enroll, info, limit, new_item, Space, PASSWORD};
use amby_sync_conformance::{Sse, Target};

fn fresh(target: &Target) -> (amby_sync_conformance::client::Account, Space) {
    let account = enroll(target, PASSWORD);
    let space = account.create_space();
    (account, space)
}

fn open(space: &Space, wait_secs: u64) -> Sse {
    space
        .api
        .open_events(
            &space.path("/events"),
            Some(&space.token),
            Duration::from_secs(wait_secs),
        )
        .unwrap_or_else(|answer| {
            panic!(
                "the stream did not open: HTTP {} {}",
                answer.status,
                answer.text()
            )
        })
}

#[test]
fn the_stream_opens_with_a_hello_that_names_the_server_and_the_head() {
    // П34, П10: text/event-stream; the first event is `hello` with seq and instance_id.
    let target = Target::from_env();
    let (_, space) = fresh(&target);
    let mut stream = open(&space, 10);
    assert!(
        stream.content_type.starts_with("text/event-stream"),
        "content type: {}",
        stream.content_type
    );
    let hello = stream.next_real_event().expect("no hello within the time");
    assert_eq!(hello.name, "hello");
    let data = hello.json();
    assert_eq!(data["seq"], 0);
    assert_eq!(data["instance_id"], info(&target.api)["instance_id"]);
}

#[test]
fn hello_reports_the_current_head() {
    // П34: a device that connects late learns the head and fetches the feed itself.
    let target = Target::from_env();
    let (_, space) = fresh(&target);
    space.commit_ok(&[space.folder(&new_item(), 0, "A")]);
    space.commit_ok(&[space.folder(&new_item(), 0, "B")]);
    let mut stream = open(&space, 10);
    let hello = stream.next_real_event().expect("no hello");
    assert_eq!(hello.name, "hello");
    assert_eq!(hello.json()["seq"], 2);
}

#[test]
fn a_commit_sends_an_event_that_tells_who_and_how_many_but_nothing_else() {
    // П34, Р11, О1: id = seq; data = seq, device_id, number of items; no header, no path.
    let target = Target::from_env();
    let (account, space) = fresh(&target);
    let mut stream = open(&space, 10);
    assert_eq!(stream.next_real_event().unwrap().name, "hello");
    space.commit_ok(&[
        space.file(&new_item(), 0, "Secret folder/secret-name-ZEBRA.md", b"x"),
        space.folder(&new_item(), 0, "Secret folder"),
    ]);
    let event = stream.next_real_event().expect("no commit event");
    assert_eq!(event.name, "commit");
    assert_eq!(event.id.as_deref(), Some("1"));
    let data = event.json();
    assert_eq!(data["seq"], 1);
    assert_eq!(data["items"], 2);
    assert_eq!(data["device_id"], account.device_id.as_str());
    assert!(!event.data.contains("ZEBRA") && !event.data.contains("header"));
}

#[test]
fn events_come_in_the_order_of_the_commits() {
    // П34, П29.
    let target = Target::from_env();
    let (_, space) = fresh(&target);
    let mut stream = open(&space, 10);
    stream.next_real_event().unwrap();
    for _ in 0..3 {
        space.commit_ok(&[space.folder(&new_item(), 0, "F")]);
    }
    let ids: Vec<Option<String>> = (0..3)
        .map(|_| stream.next_real_event().unwrap().id)
        .collect();
    assert_eq!(
        ids,
        vec![Some("1".into()), Some("2".into()), Some("3".into())]
    );
}

#[test]
fn another_device_of_the_same_user_hears_the_commit() {
    // Р11, П34: the point of the stream — device B learns that device A committed.
    let target = Target::from_env();
    let (first, space) = fresh(&target);
    let second = first.another_device("second");
    let as_second = space.with_token(&second.token);
    let mut stream = open(&as_second, 10);
    stream.next_real_event().unwrap();
    space.commit_ok(&[space.folder(&new_item(), 0, "From the first")]);
    let event = stream
        .next_real_event()
        .expect("the second device heard nothing");
    assert_eq!(event.name, "commit");
    assert_eq!(event.json()["device_id"], first.device_id.as_str());
}

#[test]
fn a_new_stream_does_not_replay_old_commits() {
    // П34: lost events are not restored; the device reads the feed from its cursor instead.
    let target = Target::from_env();
    let (_, space) = fresh(&target);
    space.commit_ok(&[space.folder(&new_item(), 0, "Old")]);
    let mut stream = open(&space, 2);
    assert_eq!(stream.next_real_event().unwrap().name, "hello");
    // Keep-alive comments may come; a commit event must not (a few reads, not an endless wait).
    for _ in 0..4 {
        match stream.next_event() {
            None => break,
            Some(event) if event.name == ":comment" => continue,
            Some(event) => panic!("no commit event may be replayed, got {event:?}"),
        }
    }
}

#[test]
fn the_stream_sends_keep_alive_comments() {
    // П34: a `: ping` line at the keep-alive interval, so that proxies do not cut it.
    let target = Target::from_env();
    let (_, space) = fresh(&target);
    let keepalive = limit(&target.api, "sse_keepalive_secs");
    let mut stream = open(&space, keepalive + 8);
    assert_eq!(stream.next_real_event().unwrap().name, "hello");
    let comment = stream
        .next_event()
        .expect("no keep-alive within the interval");
    assert_eq!(comment.name, ":comment");
    assert_eq!(comment.data, "ping");
}

#[test]
fn a_stream_needs_a_live_token_and_the_owner() {
    // П34, П5, П6: no token → 401; a stranger → 404.
    let target = Target::from_env();
    let (_, space) = fresh(&target);
    let stranger = enroll(&target, PASSWORD);
    let no_token = space
        .api
        .open_events(&space.path("/events"), None, Duration::from_secs(5))
        .err()
        .expect("a stream without a token");
    no_token.expect_error(401, "unauthorized");
    let foreign = space
        .api
        .open_events(
            &space.path("/events"),
            Some(&stranger.token),
            Duration::from_secs(5),
        )
        .err()
        .expect("a stream of somebody else's space");
    foreign.expect_error(404, "not_found");
}

#[test]
fn the_stream_of_a_revoked_device_is_closed_within_one_keep_alive() {
    // Р5, П34, П19: disconnecting a device ends its open stream by the next event or ping, and
    // the commits that follow are not delivered to it.
    let target = Target::from_env();
    let (first, space) = fresh(&target);
    let second = first.another_device("second");
    let as_second = space.with_token(&second.token);
    let keepalive = limit(&target.api, "sse_keepalive_secs");
    let mut stream = open(&as_second, keepalive + 10);
    assert_eq!(stream.next_real_event().unwrap().name, "hello");
    first
        .delete(&format!("/v1/devices/{}", second.device_id))
        .expect(204);
    space.commit_ok(&[space.folder(&new_item(), 0, "After the revocation")]);
    let started = std::time::Instant::now();
    loop {
        match stream.next_event() {
            None => break,
            Some(event) if event.name == ":comment" => {}
            Some(event) => panic!("a revoked device must not get events, got {event:?}"),
        }
        assert!(
            started.elapsed() < Duration::from_secs(keepalive + 5),
            "the stream of a revoked device is still open"
        );
    }
    assert!(
        started.elapsed() < Duration::from_secs(keepalive + 5),
        "the stream ended only because the read timed out, not because the server closed it"
    );
}
