//! Р13, Д19: a newer server that still supports v1 remains compatible.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

#[test]
fn a_server_supporting_versions_one_through_two_accepts_this_client() {
    let w = two(Engine::boxed);
    w.dev(0).lies.borrow_mut().info = Some(Box::new(|mut info| {
        info.protocol_min = 1;
        info.protocol_max = 2;
        info
    }));
    w.save(0, "a.md", "content");
    let report = w.pass(0);
    assert_eq!(report.outcome, CycleOutcome::Done);
    assert_eq!(w.server_files()["a.md"], b"content".to_vec());
}
