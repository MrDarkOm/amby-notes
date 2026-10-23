//! The failures of раздел 5 (С1–С14) as scenarios. What the mini-engine can do runs against both
//! engines; resumable uploads and records of a newer format are for the real engine only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::engine::{FsError, ItemErrorKind};

fn big_text(len: usize) -> String {
    (0..len)
        .map(|i| char::from(b'a' + (i * 7 % 26) as u8))
        .collect()
}

fn c1_an_interrupted_upload_continues_with_the_same_body(_b: EngineBuilder) {
    // С1, Д6: the connection breaks after the first part of a large body; the next pass starts
    // the same body, sends only the missing parts, and the other device gets the file intact.
    let w = pair_with_a(Engine::boxed);
    let content = big_text(17 * 1024 * 1024);
    w.save(0, "Big/large.bin", &content);
    w.dev(0).faults.net_rule(|call| {
        if call.kind == RemoteKind::PutPart(1) {
            NetFault::DropRequest
        } else {
            NetFault::None
        }
    });
    assert!(w.dev(0).sync().is_err());
    let first = w.dev(0).faults.remote_log();
    let blob = first
        .iter()
        .find(|c| c.kind == RemoteKind::BlobStart)
        .and_then(|c| c.blob)
        .expect("a body was started");
    w.pass(0);
    let second = w.dev(0).faults.remote_log();
    let started: Vec<_> = second
        .iter()
        .filter(|c| c.kind == RemoteKind::BlobStart)
        .collect();
    assert_eq!(started.len(), 1);
    assert_eq!(started[0].blob, Some(blob), "the same body continues");
    assert!(
        !second.iter().any(|c| c.kind == RemoteKind::PutPart(0)),
        "part 0 is already there and is not sent again: {second:?}"
    );
    assert!(second.iter().any(|c| c.kind == RemoteKind::PutPart(1)));
    w.pass(1);
    assert_eq!(
        w.read(1, "Big/large.bin"),
        Some(content),
        "byte for byte (О7)"
    );
    w.finish_light();
}

fn c1_a_file_edited_after_the_break_gets_a_new_body(_b: EngineBuilder) {
    // С1, Д6: if the file changed, the old upload is dropped and a new body is made.
    let w = pair_with_a(Engine::boxed);
    w.save(0, "Big/large.bin", &big_text(10 * 1024 * 1024));
    w.dev(0).faults.net_rule(|call| {
        if call.kind == RemoteKind::PutPart(1) {
            NetFault::DropRequest
        } else {
            NetFault::None
        }
    });
    assert!(w.dev(0).sync().is_err());
    let blob = w
        .dev(0)
        .faults
        .remote_log()
        .iter()
        .find_map(|c| c.blob)
        .unwrap();
    w.save(0, "Big/large.bin", "now a short file");
    w.pass(0);
    let blobs: Vec<_> = w
        .dev(0)
        .faults
        .remote_log()
        .iter()
        .filter(|c| c.kind == RemoteKind::BlobStart)
        .filter_map(|c| c.blob)
        .collect();
    assert!(
        blobs.iter().all(|b| *b != blob),
        "the new content has a new body"
    );
    w.pass(1);
    assert_eq!(
        w.read(1, "Big/large.bin").as_deref(),
        Some("now a short file")
    );
    w.finish(true);
}

fn c2_a_lost_answer_to_a_commit_does_not_duplicate_it(_b: EngineBuilder) {
    // С2, Р3, Д7: the commit reached the server, the answer was lost; the repeat returns the
    // earlier result: one new version, not two, no copy.
    let w = pair_with_a(_b);
    w.save(0, "Notes/a.md", "version two");
    w.dev(0).faults.lose_response_of(RemoteKind::Commit);
    assert!(w.dev(0).sync().is_err());
    assert_eq!(
        w.versions_at("Notes/a.md").len(),
        2,
        "the server did apply it"
    );
    w.pass(0);
    assert_eq!(
        w.versions_at("Notes/a.md").len(),
        2,
        "the repeat added nothing"
    );
    w.pass(1);
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("version two"));
    assert!(w.copies(0, "Notes/a.md").is_empty() && w.copies(1, "Notes/a.md").is_empty());
    w.finish(false);
}

fn c2_a_commit_that_is_lost_with_its_record_is_recognised_in_the_feed(_b: EngineBuilder) {
    // С2, Д15: even if the device lost the record of the commit, the feed shows its own change
    // with the same content: it is linked, not a conflict.
    let w = pair_with_a(_b);
    w.save(0, "Notes/a.md", "version two");
    w.dev(0).faults.lose_response_of(RemoteKind::Commit);
    assert!(w.dev(0).sync().is_err());
    let mut state = w.dev(0).state.snapshot();
    state.commit = None;
    w.dev(0).state.set(state);
    let report = w.pass(0);
    assert!(report.conflicts.is_empty());
    assert_eq!(w.versions_at("Notes/a.md").len(), 2);
    assert!(w.copies(0, "Notes/a.md").is_empty());
    w.finish(false);
}

fn c3_a_crash_at_any_moment_leaves_the_old_or_the_new_file(_b: EngineBuilder) {
    // С3, Д4, Д17: the process dies at every possible call while a large file is replaced: the
    // file is whole, old or new, a temporary file may remain, and the next pass finishes the job.
    let old = big_text(150_000);
    let new = format!("NEW-{}", big_text(150_000));
    for crash_at in 1..300 {
        let w = pair_with_a(_b);
        w.save(0, "Notes/a.md", &old);
        w.pass(0);
        w.pass(1);
        w.save(0, "Notes/a.md", &new);
        w.pass(0);
        w.dev(1).faults.crash_at(crash_at);
        let _ = w.dev(1).sync();
        let reached = w.dev(1).faults.calls();
        let now = w.read(1, "Notes/a.md").expect("the file is never missing");
        assert!(
            now == old || now == new,
            "a crash at call {crash_at} left a broken file ({} bytes)",
            now.len()
        );
        w.pass(1);
        assert!(
            w.dev(1).fs.tmp_files().is_empty(),
            "temporary files are cleaned (call {crash_at})"
        );
        assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some(new.as_str()));
        w.finish_light();
        if reached < crash_at {
            break;
        }
    }
}

fn c4_a_full_disk_leaves_the_file_alone_and_reports(_b: EngineBuilder) {
    // С4, Д17: no space: the file is untouched, the error is in the report, and when there is
    // room again the next pass applies the change.
    let w = pair_with_a(_b);
    w.save(0, "Notes/a.md", "new content");
    w.pass(0);
    w.dev(1).fs.set_disk_full(true);
    let report = w.dev(1).sync().unwrap();
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("base"));
    assert!(
        report
            .errors
            .iter()
            .any(|e| e.kind == ItemErrorKind::Disk(FsError::NoSpace)),
        "{:?}",
        report.errors
    );
    assert!(w.dev(1).fs.tmp_files().is_empty());
    w.dev(1).fs.set_disk_full(false);
    w.pass(1);
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("new content"));
    w.finish(false);
}

fn c5_damaged_data_writes_nothing_and_heals_later(_b: EngineBuilder) {
    // С5, Р6, Д14: a body with one changed byte does not authenticate: nothing is published, the
    // error is reported, the cursor stays before the item; a clean pass heals.
    let w = pair_with_a(_b);
    w.save(0, "Notes/a.md", "good new content");
    w.pass(0);
    w.dev(1).lies.borrow_mut().download = Some(Box::new(|_, mut bytes| {
        let middle = bytes.len() / 2;
        bytes[middle] ^= 1;
        Ok(bytes)
    }));
    w.dev(1).fs.clear_events();
    let report = w.dev(1).sync().unwrap();
    assert!(
        report
            .errors
            .iter()
            .any(|e| matches!(e.kind, ItemErrorKind::Invalid(_))),
        "{:?}",
        report.errors
    );
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("base"));
    assert!(
        !w.dev(1)
            .fs
            .events()
            .iter()
            .any(|e| matches!(e, FsEvent::Publish { .. })),
        "nothing was published"
    );
    let cursor = w.dev(1).state.snapshot().cursor;
    assert!(
        cursor < w.server_head(),
        "the cursor stays before the bad item"
    );
    w.dev(1).lies.borrow_mut().download = None;
    w.pass(1);
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("good new content"));
    w.finish(false);
}

fn c5_a_damaged_header_is_skipped_and_the_rest_arrives(_b: EngineBuilder) {
    // С5, Р6, Д14: a header that does not authenticate stops that record only.
    let w = pair_with_a(_b);
    w.save(0, "Notes/a.md", "changed");
    w.save(0, "Notes/other.md", "independent");
    w.pass(0);
    let (item, _) = w.item_at("Notes/a.md");
    w.dev(1).lies.borrow_mut().changes = Some(Box::new(move |mut page| {
        for c in &mut page.changes {
            if c.item_id == item {
                let last = c.header.len() - 1;
                c.header[last] ^= 1;
            }
        }
        page
    }));
    let report = w.dev(1).sync().unwrap();
    assert_eq!(report.errors.len(), 1);
    assert_eq!(w.read(1, "Notes/other.md").as_deref(), Some("independent"));
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("base"));
    w.dev(1).lies.borrow_mut().changes = None;
    w.pass(1);
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("changed"));
    w.finish(false);
}

fn c1_a_cut_download_is_not_an_authentication_error(_b: EngineBuilder) {
    // С1, С5, Д68: a connection cut in the middle of a download is a network problem: nothing is
    // published, the pass fails or reports it, and the next pass downloads again.
    let w = pair_with_a(_b);
    w.save(0, "Notes/a.md", &big_text(200_000));
    w.pass(0);
    w.dev(1).lies.borrow_mut().download = Some(Box::new(|_, bytes| Err(bytes.len() / 2)));
    w.dev(1).fs.clear_events();
    let result = w.dev(1).sync();
    assert!(!w
        .dev(1)
        .fs
        .events()
        .iter()
        .any(|e| matches!(e, FsEvent::Publish { .. })));
    if let Ok(report) = result {
        assert!(
            report
                .errors
                .iter()
                .all(|e| !matches!(e.kind, ItemErrorKind::Invalid(_))),
            "{:?}",
            report.errors
        );
    }
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("base"));
    w.dev(1).lies.borrow_mut().download = None;
    w.pass(1);
    assert_eq!(w.read(1, "Notes/a.md"), Some(big_text(200_000)));
}

fn c9_a_file_edited_while_it_is_read_is_sent_by_the_next_pass(_b: EngineBuilder) {
    // С9, Д12: the user saves again between the listing and the reading; no loss, and the latest
    // content wins in the end.
    let w = pair_with_a(_b);
    w.save(0, "Notes/a.md", "second");
    let vfs = w.dev(0).fs.clone();
    w.dev(0).faults.after_named("Fs.list", move || {
        vfs.user_write("Notes/a.md", b"third, saved during the pass")
    });
    w.dev(0).sync().unwrap();
    w.pass(0);
    w.pass(1);
    assert_eq!(
        w.read(1, "Notes/a.md").as_deref(),
        Some("third, saved during the pass")
    );
    w.finish(false);
}

fn c10_clocks_that_are_wrong_decide_nothing(_b: EngineBuilder) {
    // С10, Р3: a clock far in the past on the device that syncs first and far in the future on
    // the other: the first to reach the server still keeps the path; no version wins by time.
    let w = pair_with_a(_b);
    w.dev(0).set_clock(0);
    w.dev(1).set_clock(i64::MAX / 4);
    w.save(1, "Notes/a.md", "written later by the clock, synced second");
    w.save(
        0,
        "Notes/a.md",
        "written earlier by the clock, synced first",
    );
    w.pass(0);
    w.pass(1);
    assert_eq!(
        w.read(1, "Notes/a.md").as_deref(),
        Some("written earlier by the clock, synced first")
    );
    assert_eq!(
        w.others(1, "Notes/a.md"),
        vec!["written later by the clock, synced second".to_string()],
        "the second version is in a set, whatever the clocks say"
    );
    w.finish(false);
}

fn c11_a_copied_vault_without_its_state_reconciles_and_deletes_nothing(_b: EngineBuilder) {
    // С11, Р10, Д8, Г10: the state is gone (the vault was copied with its files to another
    // computer): identical files link, different ones go into conflict sets (there is no base, so
    // they are not merged), new ones arrive, local-only
    // ones go up, and nothing is deleted anywhere.
    let w = pair_with_a(_b);
    w.save(0, "Notes/a.md", "edited meanwhile");
    w.save(0, "Notes/new.md", "new elsewhere");
    w.pass(0);
    w.save(1, "Notes/local-only.md", "only here");
    w.dev(1).state.wipe();
    w.dev(1).fs.clear_events();
    w.pass(1);
    assert!(w.dev(1).fs.trash().is_empty(), "nothing is deleted");
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("edited meanwhile"));
    assert_eq!(w.others(1, "Notes/a.md"), vec!["base".to_string()]);
    assert!(w.old_copies(1).is_empty());
    assert_eq!(w.read(1, "Notes/new.md").as_deref(), Some("new elsewhere"));
    assert!(
        !w.dev(1)
            .fs
            .events()
            .iter()
            .any(|e| matches!(e, FsEvent::Publish { path, .. } if path == "Keep/k.md")),
        "identical files are linked, not rewritten"
    );
    assert!(w.dev(1).state.snapshot().instance_id.is_some());
    w.pass(0);
    assert_eq!(
        w.read(0, "Notes/local-only.md").as_deref(),
        Some("only here")
    );
    w.finish(false);
}

fn c14_a_second_process_cannot_synchronise_the_same_vault(_b: EngineBuilder) {
    // С14, Д9: the lock is taken first; when it is busy nothing is read or written.
    let w = pair_with_a(_b);
    w.save(1, "Notes/a.md", "local change");
    let guard = w.dev(1).state.lock_from_outside();
    let head = w.server_head();
    let result = w.dev(1).sync();
    assert_eq!(
        result.unwrap_err(),
        amby_sync_core::engine::EngineError::Locked
    );
    assert_eq!(
        w.dev(1).faults.log(),
        vec!["State.lock".to_string()],
        "nothing else was touched"
    );
    assert_eq!(w.server_head(), head);
    drop(guard);
    w.pass(1);
    assert!(w.server_head() > head);
}

fn c13_a_record_of_a_newer_format_is_read_only(_b: EngineBuilder) {
    // С13, Р13, Д66: a header with `format: 2` is neither applied nor overwritten, a local edit
    // of that file is not sent, the report asks for an update, the other records are applied.
    let w = pair_with_a(Engine::boxed);
    let (item, version) = w.item_at("Notes/a.md");
    let future = amby_sync_core::crypto::keys::ItemId::from_bytes([0x77; 16]);
    let envelope_new = forge_envelope(
        &w,
        &future,
        1,
        r#"{"body_id":null,"content_hash":null,"deleted":false,"format":2,"kind":"folder","mtime_ms":0,"newfield":1,"path":"Future/x","size":0,"version":1}"#,
    );
    let envelope_old = forge_envelope(
        &w,
        &item,
        version + 1,
        &format!(
            r#"{{"body_id":null,"content_hash":null,"deleted":false,"format":2,"kind":"file","mtime_ms":0,"path":"Notes/a.md","size":0,"version":{}}}"#,
            version + 1
        ),
    );
    w.inject_raw(vec![
        commit_entry(&future, 0, &envelope_new, None, false),
        commit_entry(&item, version, &envelope_old, None, false),
    ]);
    w.save(0, "Notes/ordinary.md", "ordinary");
    w.pass(0);
    w.save(1, "Notes/a.md", "my local edit");
    let head = w.server_head();
    let report = w.pass(1);
    assert!(report.needs_update);
    assert_eq!(report.read_only.len(), 2);
    assert!(!w.dev(1).fs.exists("Future/x"));
    assert_eq!(
        w.read(1, "Notes/a.md").as_deref(),
        Some("my local edit"),
        "not overwritten"
    );
    assert_eq!(w.read(1, "Notes/ordinary.md").as_deref(), Some("ordinary"));
    assert_eq!(
        w.server_head(),
        head,
        "the local edit of a read-only record is not sent"
    );
}

both!(
    c2_a_lost_answer_to_a_commit_does_not_duplicate_it,
    c2_a_commit_that_is_lost_with_its_record_is_recognised_in_the_feed,
    c3_a_crash_at_any_moment_leaves_the_old_or_the_new_file,
    c4_a_full_disk_leaves_the_file_alone_and_reports,
    c5_damaged_data_writes_nothing_and_heals_later,
    c5_a_damaged_header_is_skipped_and_the_rest_arrives,
    c1_a_cut_download_is_not_an_authentication_error,
    c9_a_file_edited_while_it_is_read_is_sent_by_the_next_pass,
    c10_clocks_that_are_wrong_decide_nothing,
    c11_a_copied_vault_without_its_state_reconciles_and_deletes_nothing,
    c14_a_second_process_cannot_synchronise_the_same_vault,
);

real_only!(
    c1_an_interrupted_upload_continues_with_the_same_body,
    c1_a_file_edited_after_the_break_gets_a_new_body,
    c13_a_record_of_a_newer_format_is_read_only,
);
