//! The change feed, its cursor and paging, the history of an item (Р2, Р3, Р6, О4, О7, С7;
//! П31–П33).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_conformance::client::{assert_hex, enroll, hex16, info, new_item, Space, PASSWORD};
use amby_sync_conformance::Target;
use serde_json::Value;

fn fresh_space(target: &Target) -> Space {
    enroll(target, PASSWORD).create_space()
}

fn seqs(changes: &[Value]) -> Vec<u64> {
    changes.iter().map(|c| c["seq"].as_u64().unwrap()).collect()
}

#[test]
fn the_feed_gives_headers_that_open_and_bodies_that_come_back_byte_for_byte() {
    // О7, Р2, Р6, О1: content with a BOM, CRLF and zero bytes comes back exactly as it went in,
    // the path is only in the encrypted header.
    let space = fresh_space(&Target::from_env());
    let contents: Vec<(&str, Vec<u8>)> = vec![
        (
            "Notes/with bom.md",
            b"\xEF\xBB\xBFtitle\r\nbody\r\n".to_vec(),
        ),
        ("Notes/binary.bin", vec![0, 1, 2, 0, 0, 255, 254, 0]),
        ("Notes/empty.md", Vec::new()),
        ("Заметки/Привет мир.md", "день добрый\n".as_bytes().to_vec()),
    ];
    let prepared: Vec<_> = contents
        .iter()
        .map(|(path, bytes)| space.file(&new_item(), 0, path, bytes))
        .collect();
    space.commit_ok(&prepared);
    let feed = space.all_changes(0);
    assert_eq!(feed.len(), 4);
    for (change, (path, bytes)) in feed.iter().zip(&contents) {
        assert_eq!(space.open_change(change).path, *path);
        assert_eq!(
            space.fetch_file(change),
            *bytes,
            "{path} must come back byte for byte"
        );
    }
}

#[test]
fn the_feed_answer_has_the_documented_shape() {
    // П31, П10: instance_id, head seq, since, next, more, gap; every entry has its fields.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    let item = new_item();
    space.commit_ok(&[space.file(&item, 0, "a.md", b"hello")]);
    let page = space.changes(0, None).expect(200).json();
    assert_eq!(page["instance_id"], info(&target.api)["instance_id"]);
    assert_eq!(page["seq"], 1);
    assert_eq!(page["since"], 0);
    assert_eq!(page["next"], 1);
    assert_eq!(page["more"], false);
    assert_eq!(page["gap"], false);
    let change = &page["changes"][0];
    assert_eq!(change["seq"], 1);
    assert_eq!(change["item_id"], hex16(item.as_bytes()).as_str());
    assert_eq!(change["version"], 1);
    assert_hex(
        &change["header"],
        change["header"].as_str().unwrap().len() / 2,
        "header",
    );
    assert_hex(&change["blob_id"], 16, "blob_id");
    assert!(
        change["blob_size"].as_u64().unwrap() >= 48,
        "the sealed body is at least 48 bytes"
    );
    assert_eq!(change["deleted"], false);
    assert_eq!(change["device_id"], account.device_id.as_str());
    assert!(change["committed_ms"].as_i64().unwrap() > 0);
}

#[test]
fn the_cursor_returns_only_newer_changes() {
    // Р3, П31: `since` is exclusive; an empty page keeps the cursor.
    let space = fresh_space(&Target::from_env());
    let (a, b) = (new_item(), new_item());
    space.commit_ok(&[space.file(&a, 0, "a.md", b"1")]);
    space.commit_ok(&[space.file(&b, 0, "b.md", b"2")]);
    let after_first = space.changes(1, None).expect(200).json();
    assert_eq!(seqs(after_first["changes"].as_array().unwrap()), vec![2]);
    assert_eq!(
        after_first["changes"][0]["item_id"],
        hex16(b.as_bytes()).as_str()
    );
    assert_eq!(after_first["next"], 2);
    let nothing = space.changes(2, None).expect(200).json();
    assert!(nothing["changes"].as_array().unwrap().is_empty());
    assert_eq!(nothing["next"], 2);
    assert_eq!(nothing["more"], false);
    assert_eq!(nothing["seq"], 2);
}

#[test]
fn an_empty_space_has_an_empty_feed() {
    // П31, П29.
    let space = fresh_space(&Target::from_env());
    let page = space.changes(0, None).expect(200).json();
    assert!(page["changes"].as_array().unwrap().is_empty());
    assert_eq!(page["seq"], 0);
    assert_eq!(page["next"], 0);
    assert_eq!(page["more"], false);
}

#[test]
fn a_page_never_splits_a_commit() {
    // Р2, П31: a renamed folder arrives whole. A page holds whole commits, at least one, even if
    // that is more than `limit`.
    let space = fresh_space(&Target::from_env());
    let batch = |n: usize, tag: &str| -> Vec<_> {
        (0..n)
            .map(|i| space.folder(&new_item(), 0, &format!("{tag}{i}")))
            .collect()
    };
    space.commit_ok(&batch(5, "A"));
    space.commit_ok(&batch(5, "B"));
    space.commit_ok(&batch(1, "C"));
    let first = space.changes(0, Some(3)).expect(200).json();
    assert_eq!(
        seqs(first["changes"].as_array().unwrap()),
        vec![1; 5],
        "one whole commit, more than limit"
    );
    assert_eq!(first["more"], true);
    assert_eq!(first["next"], 1);
    let second = space.changes(1, Some(5)).expect(200).json();
    assert_eq!(
        seqs(second["changes"].as_array().unwrap()),
        vec![2; 5],
        "B fits, adding C would not"
    );
    assert_eq!(second["more"], true);
    assert_eq!(second["next"], 2);
    let third = space.changes(2, Some(5)).expect(200).json();
    assert_eq!(seqs(third["changes"].as_array().unwrap()), vec![3]);
    assert_eq!(third["more"], false);
    let wide = space.changes(1, Some(6)).expect(200).json();
    assert_eq!(
        seqs(wide["changes"].as_array().unwrap()),
        vec![2, 2, 2, 2, 2, 3],
        "B and C fit in 6"
    );
    assert_eq!(wide["more"], false);
}

#[test]
fn paging_to_the_end_covers_every_change_once_in_order() {
    // П31, Р10: follow `next` while `more`; no repeats, no gaps.
    let space = fresh_space(&Target::from_env());
    for n in 0..7 {
        space.commit_ok(&[space.folder(&new_item(), 0, &format!("F{n}"))]);
    }
    let mut cursor = 0;
    let mut collected = Vec::new();
    let mut pages = 0;
    loop {
        let page = space.changes(cursor, Some(2)).expect(200).json();
        collected.extend(seqs(page["changes"].as_array().unwrap()));
        cursor = page["next"].as_u64().unwrap();
        pages += 1;
        assert!(pages < 20, "the cursor must advance");
        if page["more"] != true {
            break;
        }
    }
    assert_eq!(collected, (1..=7).collect::<Vec<u64>>());
    assert_eq!(pages, 4, "2 + 2 + 2 + 1");
}

#[test]
fn a_limit_above_the_maximum_is_capped_not_refused() {
    // П31: `changes_page_max`.
    let space = fresh_space(&Target::from_env());
    space.commit_ok(&[space.folder(&new_item(), 0, "F")]);
    space.changes(0, Some(1_000_000)).expect(200);
}

#[test]
fn bad_cursor_values_are_refused() {
    // П31: `since` is a non-negative integer, `limit` at least 1.
    let space = fresh_space(&Target::from_env());
    for suffix in [
        "/changes?since=abc",
        "/changes?since=-1",
        "/changes?since=1.5",
        "/changes?limit=0",
        "/changes?limit=-3",
        "/changes?limit=many",
    ] {
        space.get(suffix).expect_error(400, "bad_request");
    }
}

#[test]
fn a_cursor_beyond_the_head_is_an_empty_answer_that_shows_the_real_head() {
    // П31, С7, Р8: a device that remembers seq 9 from a server that is now at 2 sees the head and
    // can stop.
    let space = fresh_space(&Target::from_env());
    space.commit_ok(&[space.folder(&new_item(), 0, "F")]);
    space.commit_ok(&[space.folder(&new_item(), 0, "G")]);
    let page = space.changes(9, None).expect(200).json();
    assert!(page["changes"].as_array().unwrap().is_empty());
    assert_eq!(page["seq"], 2);
    assert_eq!(page["next"], 9);
    assert_eq!(page["since"], 9);
}

#[test]
fn entries_of_a_commit_keep_the_order_of_the_request() {
    // П31: the order inside a commit is the order the device wrote.
    let space = fresh_space(&Target::from_env());
    let order: Vec<_> = (0..4).map(|_| new_item()).collect();
    let batch = [
        space.folder(&order[2], 0, "c"),
        space.folder(&order[0], 0, "a"),
        space.folder(&order[3], 0, "d"),
        space.folder(&order[1], 0, "b"),
    ];
    space.commit_ok(&batch);
    let got: Vec<String> = space
        .all_changes(0)
        .iter()
        .map(|c| c["item_id"].as_str().unwrap().to_string())
        .collect();
    let want: Vec<String> = [2, 0, 3, 1]
        .iter()
        .map(|&i| hex16(order[i].as_bytes()))
        .collect();
    assert_eq!(got, want);
}

#[test]
fn the_feed_shows_only_the_latest_version_of_each_item() {
    // П31, Р6, О4: create, change, delete → one entry, version 3, deleted, at the seq of the
    // deletion. The earlier versions are in the history (П33), not in the feed.
    let space = fresh_space(&Target::from_env());
    let item = new_item();
    space.commit_ok(&[space.file(&item, 0, "a.md", b"one")]);
    space.commit_ok(&[space.file(&item, 1, "a.md", b"two")]);
    space.commit_ok(&[space.deletion(&item, 2, "a.md")]);
    let feed = space.all_changes(0);
    assert_eq!(feed.len(), 1, "one entry per item: {feed:?}");
    assert_eq!(feed[0]["version"], 3);
    assert_eq!(feed[0]["deleted"], true);
    assert_eq!(feed[0]["seq"], 3);
    let versions = space.versions(&item).expect(200).json();
    assert_eq!(
        versions["versions"].as_array().unwrap().len(),
        3,
        "the history keeps all three"
    );
}

#[test]
fn a_replaced_item_moves_to_its_new_seq_and_leaves_the_old_one() {
    // П31: the entry of an item sits at the seq of its latest version.
    let space = fresh_space(&Target::from_env());
    let (a, b) = (new_item(), new_item());
    space.commit_ok(&[space.file(&a, 0, "a.md", b"a1")]); // seq 1
    space.commit_ok(&[space.file(&b, 0, "b.md", b"b1")]); // seq 2
    space.commit_ok(&[space.file(&a, 1, "a.md", b"a2")]); // seq 3
    let feed = space.all_changes(0);
    let shape: Vec<(String, u64, u64)> = feed
        .iter()
        .map(|c| {
            (
                c["item_id"].as_str().unwrap().to_string(),
                c["seq"].as_u64().unwrap(),
                c["version"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        shape,
        vec![(hex16(b.as_bytes()), 2, 1), (hex16(a.as_bytes()), 3, 2)]
    );
    // From seq 1 on: a device that had a@1 learns a@2; nothing is lost.
    let later = space.changes(1, None).expect(200).json();
    assert_eq!(seqs(later["changes"].as_array().unwrap()), vec![2, 3]);
}

#[test]
fn what_is_left_of_a_commit_still_arrives_whole() {
    // П31, Р2: a commit of three items, one of them replaced later: the other two stay at the
    // old seq and are never split from each other by a page.
    let space = fresh_space(&Target::from_env());
    let items: Vec<_> = (0..3).map(|_| new_item()).collect();
    let batch: Vec<_> = items
        .iter()
        .enumerate()
        .map(|(i, item)| space.folder(item, 0, &format!("F{i}")))
        .collect();
    space.commit_ok(&batch); // seq 1
    space.commit_ok(&[space.folder(&items[0], 1, "F0 renamed")]); // seq 2
    let page = space.changes(0, Some(1)).expect(200).json();
    assert_eq!(
        seqs(page["changes"].as_array().unwrap()),
        vec![1, 1],
        "the two that stayed come together"
    );
    assert_eq!(page["more"], true);
    let rest = space
        .changes(page["next"].as_u64().unwrap(), Some(1))
        .expect(200)
        .json();
    assert_eq!(seqs(rest["changes"].as_array().unwrap()), vec![2]);
}

#[test]
fn an_item_changed_while_paging_arrives_later_and_is_not_lost() {
    // П31, Р10: the first page is read, then an item of it changes; the cursor moves forward only,
    // and the change shows up on a later page.
    let space = fresh_space(&Target::from_env());
    let items: Vec<_> = (0..4).map(|_| new_item()).collect();
    for (i, item) in items.iter().enumerate() {
        space.commit_ok(&[space.file(item, 0, &format!("f{i}.md"), b"v1")]); // seq 1..4
    }
    let first = space.changes(0, Some(2)).expect(200).json();
    assert_eq!(seqs(first["changes"].as_array().unwrap()), vec![1, 2]);
    assert_eq!(first["more"], true);
    // Meanwhile the first item is changed (seq 5).
    space.commit_ok(&[space.file(&items[0], 1, "f0.md", b"v2")]);
    let mut seen = std::collections::BTreeMap::new();
    for page in [first] {
        for change in page["changes"].as_array().unwrap() {
            seen.insert(
                change["item_id"].as_str().unwrap().to_string(),
                change["version"].as_u64().unwrap(),
            );
        }
    }
    let mut cursor = 2;
    loop {
        let page = space.changes(cursor, Some(2)).expect(200).json();
        for change in page["changes"].as_array().unwrap() {
            seen.insert(
                change["item_id"].as_str().unwrap().to_string(),
                change["version"].as_u64().unwrap(),
            );
        }
        cursor = page["next"].as_u64().unwrap();
        if page["more"] != true {
            break;
        }
    }
    assert_eq!(seen.len(), 4);
    assert_eq!(
        seen[&hex16(items[0].as_bytes())],
        2,
        "the changed item arrived with its new version"
    );
    assert_eq!(cursor, 5);
}

#[test]
fn the_history_lists_old_versions_newest_first_and_their_bodies_stay_readable() {
    // О4, Р8, П33: a device can restore an earlier version from the server.
    let space = fresh_space(&Target::from_env());
    let item = new_item();
    space.commit_ok(&[space.file(&item, 0, "a.md", b"first text")]);
    space.commit_ok(&[space.file(&item, 1, "a.md", b"second text")]);
    space.commit_ok(&[space.file(&item, 2, "a.md", b"third text")]);
    let history = space.versions(&item).expect(200).json();
    assert_eq!(history["item_id"], hex16(item.as_bytes()).as_str());
    let versions = history["versions"].as_array().unwrap();
    let numbers: Vec<u64> = versions
        .iter()
        .map(|v| v["version"].as_u64().unwrap())
        .collect();
    assert_eq!(numbers, vec![3, 2, 1]);
    assert_eq!(space.fetch_file(&versions[0]), b"third text");
    assert_eq!(space.fetch_file(&versions[1]), b"second text");
    assert_eq!(space.fetch_file(&versions[2]), b"first text");
    assert_eq!(
        versions[0]["superseded_ms"],
        Value::Null,
        "the latest is not superseded"
    );
    assert!(versions[1]["superseded_ms"].as_i64().unwrap() > 0);
    assert!(versions[2]["superseded_ms"].as_i64().unwrap() > 0);
    assert_eq!(versions[0]["seq"], 3);
}

#[test]
fn the_history_of_an_unknown_item_is_not_found() {
    // П33, П6.
    let space = fresh_space(&Target::from_env());
    space.versions(&new_item()).expect_error(404, "not_found");
}

#[test]
fn a_deleted_item_keeps_its_history_for_restoring() {
    // О4, П33, П36: the deletion is the newest version; the last real content is behind it.
    let space = fresh_space(&Target::from_env());
    let item = new_item();
    space.commit_ok(&[space.file(&item, 0, "precious.md", b"do not lose me")]);
    space.commit_ok(&[space.deletion(&item, 1, "precious.md")]);
    let history = space.versions(&item).expect(200).json();
    let versions = history["versions"].as_array().unwrap();
    assert_eq!(versions[0]["deleted"], true);
    assert_eq!(space.fetch_file(&versions[1]), b"do not lose me");
}

#[test]
fn the_feed_is_per_space() {
    // П6, П31: a commit in one space does not show in another.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let (first, second) = (account.create_space(), account.create_space());
    first.commit_ok(&[first.folder(&new_item(), 0, "F")]);
    assert_eq!(first.all_changes(0).len(), 1);
    assert!(second.all_changes(0).is_empty());
    assert_eq!(second.changes(0, None).expect(200).json()["seq"], 0);
}
