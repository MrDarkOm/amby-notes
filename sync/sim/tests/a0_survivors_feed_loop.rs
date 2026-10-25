//! The one test of the feed that must not hang when its loop does not end (mutant of
//! `engine/feed.rs`, docs/Road/sync-gates-survivors-report.md): it is alone in its file and its
//! name sorts first, so that the run of the mutants meets it before any test that would wait for
//! ever. The server is asked for the feed at most a few times in a pass, or the test fails. Real
//! engine only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use std::cell::Cell;
use std::rc::Rc;


fn sv_the_feed_is_read_once_and_ends(_b: EngineBuilder) {
    let w = two(Engine::boxed);
    // From the very first pass: the passes of the set-up would wait for ever too.
    let calls = Rc::new(Cell::new(0u32));
    for d in 0..2 {
        let seen = calls.clone();
        w.dev(d).lies.borrow_mut().changes = Some(Box::new(move |page| {
            seen.set(seen.get() + 1);
            assert!(seen.get() < 60, "the feed is asked for again and again");
            page
        }));
    }
    w.save(0, "Keep/k.md", "keep");
    w.pass(0);
    w.pass(1);
    calls.set(0);
    w.save(0, "x.md", "xxx");
    w.pass(0);
    calls.set(0);
    w.pass(1);
    assert_eq!(calls.get(), 1);
    assert_eq!(w.read(1, "x.md").as_deref(), Some("xxx"));
}

real_only!(sv_the_feed_is_read_once_and_ends);
