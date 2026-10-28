//! Tests written for the mutants of `engine/feed.rs` and `engine/util.rs` that survived the trial
//! run of the gates (docs/Road/sync-gates-survivors-report.md): the feed is read page by page and
//! ends; a page that is damaged once is asked for again, one that cannot be read is not; folders
//! come in the order of their depth. Real engine only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use std::cell::Cell;
use std::rc::Rc;

use amby_sync_core::crypto::keys::ItemId;

fn sv_a_page_damaged_once_is_asked_for_again_in_the_same_pass(_b: EngineBuilder) {
    // Д14: a bad read is not a forgery yet.
    let w = pair_with_a(Engine::boxed);
    w.save(0, "x.md", "xxx");
    w.pass(0);
    let first = Rc::new(Cell::new(true));
    w.dev(1).lies.borrow_mut().changes = Some(Box::new(move |mut page| {
        if first.replace(false) {
            for entry in &mut page.changes {
                let last = entry.header.len() - 1;
                entry.header[last] ^= 0x55;
            }
        }
        page
    }));
    let report = w.pass(1);
    w.dev(1).lies.borrow_mut().changes = None;
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(w.read(1, "x.md").as_deref(), Some("xxx"));
    assert_eq!(w.remote_calls(1, RemoteKind::Changes), 2);
}

fn sv_a_record_of_a_newer_format_is_not_asked_for_again(_b: EngineBuilder) {
    // It is not a bad read: asking again would only give the same record.
    let w = pair_with_a(Engine::boxed);
    let future = ItemId::from_bytes([0x77; 16]);
    let envelope = forge_envelope(
        &w,
        &future,
        1,
        r#"{"body_id":null,"content_hash":null,"deleted":false,"format":2,"kind":"folder","mtime_ms":0,"path":"Future/x","size":0,"version":1}"#,
    );
    w.inject_raw(vec![commit_entry(&future, 0, &envelope, None, false)]);
    let report = w.pass(1);
    assert!(report.needs_update);
    assert_eq!(w.remote_calls(1, RemoteKind::Changes), 1);
}

fn sv_folders_that_arrive_together_are_made_from_the_top(_b: EngineBuilder) {
    // The child is on the server before its parent; the parent is made first (Д17, step 1).
    let w = pair_with_a(Engine::boxed);
    w.inject_folder(&ItemId::from_bytes([0x11; 16]), 0, "P/Q");
    w.inject_folder(&ItemId::from_bytes([0x22; 16]), 0, "P");
    w.pass(1);
    let made: Vec<String> = disk_changes(&w, 1)
        .into_iter()
        .filter_map(|e| match e {
            FsEvent::CreateDir { path } => Some(path),
            _ => None,
        })
        .collect();
    assert_eq!(made, vec!["P".to_string(), "P/Q".to_string()]);
}

real_only!(
    sv_a_page_damaged_once_is_asked_for_again_in_the_same_pass,
    sv_a_record_of_a_newer_format_is_not_asked_for_again,
    sv_folders_that_arrive_together_are_made_from_the_top,
);
