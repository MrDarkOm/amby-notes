//! A three-edge rename chain must not be mistaken for a cycle by apply_plan.
#![allow(clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::keys::{BodyId, ItemId};

struct RemoteFile {
    item: ItemId,
    version: u64,
    body: BodyId,
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

#[test]
fn three_rename_chain_does_not_break_a_false_cycle() {
    let w = two(Engine::boxed);
    w.save(1, "Keep/k.md", "keep");
    w.pass(1);

    add_remote_file(&w, 0x40, "Chain/a.md", b"from a");
    add_remote_file(&w, 0x41, "Chain/b.md", b"from b");
    add_remote_file(&w, 0x42, "Chain/c.md", b"from c");
    w.pass(1);
    w.dev(1).fs.clear_events();

    // Capture every descriptor before injecting any rename: the server will temporarily have
    // duplicate paths while the three independent records are updated.
    let a = remote_file(&w, "Chain/a.md");
    let b = remote_file(&w, "Chain/b.md");
    let c = remote_file(&w, "Chain/c.md");
    let space = w.space(0);
    let changes = [
        space.file_with_uploaded_body(&a.item, a.version, "Chain/b.md", b"from a", &a.body),
        space.file_with_uploaded_body(&b.item, b.version, "Chain/c.md", b"from b", &b.body),
        space.file_with_uploaded_body(&c.item, c.version, "Chain/d.md", b"from c", &c.body),
    ];
    space.commit_ok(&changes);

    w.pass(1);

    assert!(!w.dev(1).fs.exists("Chain/a.md"));
    assert_eq!(w.read(1, "Chain/b.md").as_deref(), Some("from a"));
    assert_eq!(w.read(1, "Chain/c.md").as_deref(), Some("from b"));
    assert_eq!(w.read(1, "Chain/d.md").as_deref(), Some("from c"));
    assert!(
        w.dev(1).fs.events().iter().all(|event| match event {
            FsEvent::Rename { from, to } => {
                !from.contains(".amby-swap-") && !to.contains(".amby-swap-")
            }
            _ => true,
        }),
        "an acyclic rename chain must not use swap names: {:?}",
        w.dev(1).fs.events()
    );
}
