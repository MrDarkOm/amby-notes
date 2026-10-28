//! Gate regressions for apply-plan cycle handling and merge eligibility.
#![allow(clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::keys::ItemId;
use amby_sync_core::engine::RenameHint;

struct RemoteFile {
    item: ItemId,
    version: u64,
    body: amby_sync_core::crypto::keys::BodyId,
}

fn add_remote_file(w: &World, id: u8, path: &str, content: &'static [u8]) {
    w.inject_file(&ItemId::from_bytes([id; 16]), 0, path, content);
}

fn remote_file(w: &World, path: &str) -> RemoteFile {
    let (item, version) = w.item_at(path);
    let body = w.versions_at(path)[0]
        .header
        .body_id
        .expect("live file has a body");
    RemoteFile {
        item,
        version,
        body,
    }
}

fn inject_rename(w: &World, file: &RemoteFile, target: &str, content: &'static [u8]) {
    w.inject_rename(&file.item, file.version, target, content, &file.body);
}

fn aside_renames(w: &World, device: usize) -> Vec<(String, String)> {
    w.dev(device)
        .fs
        .events()
        .into_iter()
        .filter_map(|event| match event {
            FsEvent::Rename { from, to } if to.contains(".amby-swap-") => Some((from, to)),
            _ => None,
        })
        .collect()
}

fn first_batch_aside_renames(w: &World, device: usize) -> Vec<(String, String)> {
    let mut in_first_batch = false;
    w.dev(device)
        .fs
        .events()
        .into_iter()
        .take_while(|event| {
            if matches!(event, FsEvent::BatchEnd) && in_first_batch {
                return false;
            }
            if matches!(event, FsEvent::BatchBegin) {
                in_first_batch = true;
            }
            true
        })
        .filter_map(|event| match event {
            FsEvent::Rename { from, to } if to.contains(".amby-swap-") => Some((from, to)),
            _ => None,
        })
        .collect()
}

#[test]
fn three_independent_swaps_do_not_break_a_cycle_after_the_last_round() {
    let w = two(Engine::boxed);
    w.save(1, "Keep/k.md", "keep");
    w.pass(1);

    let pairs = [
        (
            "Cycle/a0.md",
            "Cycle/b0.md",
            b"a0" as &'static [u8],
            b"b0" as &'static [u8],
        ),
        (
            "Cycle/a1.md",
            "Cycle/b1.md",
            b"a1" as &'static [u8],
            b"b1" as &'static [u8],
        ),
        (
            "Cycle/a2.md",
            "Cycle/b2.md",
            b"a2" as &'static [u8],
            b"b2" as &'static [u8],
        ),
    ];
    for (index, (a, b, a_bytes, b_bytes)) in pairs.iter().enumerate() {
        add_remote_file(&w, 0x10 + (index as u8) * 2, a, a_bytes);
        add_remote_file(&w, 0x11 + (index as u8) * 2, b, b_bytes);
    }
    w.pass(1);
    w.dev(1).fs.clear_events();

    let records: Vec<_> = pairs
        .iter()
        .map(|(a, b, _, _)| (remote_file(&w, a), remote_file(&w, b)))
        .collect();
    let space = w.space(0);
    let mut changes = Vec::new();
    for ((a, b, a_bytes, b_bytes), (remote_a, remote_b)) in pairs.iter().zip(&records) {
        changes.push(space.file_with_uploaded_body(
            &remote_a.item,
            remote_a.version,
            b,
            a_bytes,
            &remote_a.body,
        ));
        changes.push(space.file_with_uploaded_body(
            &remote_b.item,
            remote_b.version,
            a,
            b_bytes,
            &remote_b.body,
        ));
    }
    space.commit_ok(&changes);
    w.pass(1);

    // This first apply batch has two cycle-breaking opportunities. The third cycle is still
    // pending after its final round; moving it aside then would leave no round to advance it.
    assert_eq!(first_batch_aside_renames(&w, 1).len(), 2);
}

#[test]
fn an_acyclic_rename_chain_never_uses_a_swap_name() {
    let w = two(Engine::boxed);
    w.save(1, "Keep/k.md", "keep");
    w.pass(1);
    add_remote_file(&w, 0x21, "Chain/a.md", b"from a");
    add_remote_file(&w, 0x22, "Chain/b.md", b"from b");
    w.pass(1);
    w.dev(1).fs.clear_events();

    let a = remote_file(&w, "Chain/a.md");
    let b = remote_file(&w, "Chain/b.md");
    inject_rename(&w, &a, "Chain/b.md", b"from a");
    inject_rename(&w, &b, "Chain/c.md", b"from b");
    w.pass(1);

    assert!(!w.dev(1).fs.exists("Chain/a.md"));
    assert_eq!(w.read(1, "Chain/b.md").as_deref(), Some("from a"));
    assert_eq!(w.read(1, "Chain/c.md").as_deref(), Some("from b"));
    assert!(aside_renames(&w, 1).is_empty());
}

#[test]
fn a_renamed_md_to_txt_with_two_edits_is_not_merged() {
    let w = two(Engine::boxed);
    w.save(0, "Keep/k.md", "keep");
    w.pass(0);
    w.pass(1);
    add_remote_file(&w, 0x33, "Notes/note.md", b"a\nb\nc\n");
    w.pass(0);
    w.pass(1);
    assert!(
        w.dev(1).state.base_count() >= 2,
        "the Keep and note .md bases were retained"
    );

    w.save(1, "Notes/note.md", "a\nb\nC\n");
    w.dev(0).fs.user_rename("Notes/note.md", "Notes/note.txt");
    w.save(0, "Notes/note.txt", "A\nb\nc\n");
    w.dev(0)
        .sync_with(&CycleRequest {
            rename_hints: vec![RenameHint {
                from: "Notes/note.md".into(),
                to: "Notes/note.txt".into(),
            }],
            ..Default::default()
        })
        .expect("device 0 commits the hinted rename and edit");

    let report = w.pass(1);

    assert!(report.merged_paths.is_empty());
    assert_eq!(report.conflicts.len(), 1);
    assert_eq!(w.read(1, "Notes/note.txt").as_deref(), Some("A\nb\nc\n"));
    assert!(!w.dev(1).fs.exists("Notes/note.md"));
    assert_eq!(w.others(1, "Notes/note.txt"), vec!["a\nb\nC\n".to_string()]);
}
