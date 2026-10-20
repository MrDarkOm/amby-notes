//! Atomic batch commits: compare-and-swap on versions, refusal of the whole batch, races,
//! replays by `commit_id`, `seq` (Р2, Р3, О5, С2, С10; П26–П30).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Barrier;
use std::time::Duration;

use amby_sync_conformance::client::{
    assert_hex, enroll, hex16, new_body, new_item, random16, Space, PASSWORD,
};
use amby_sync_conformance::{in_process_or_skip, Target};
use amby_sync_core::crypto::keys::ItemId;
use serde_json::{json, Value};

fn fresh_space(target: &Target) -> Space {
    enroll(target, PASSWORD).create_space()
}

fn ids(changes: &[Value]) -> Vec<String> {
    changes
        .iter()
        .map(|c| c["item_id"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn the_first_commit_creates_items_at_version_one() {
    // Р3, Р2, П26, П29: a folder and a file in one commit; version = base + 1; seq 1.
    let space = fresh_space(&Target::from_env());
    let (folder, file) = (new_item(), new_item());
    let answer = space
        .commit(&[
            space.folder(&folder, 0, "Docs"),
            space.file(&file, 0, "Docs/a.md", b"hello"),
        ])
        .expect(200)
        .json();
    assert_eq!(answer["seq"], 1);
    assert_eq!(answer["replayed"], false);
    assert!(answer["committed_ms"].as_i64().unwrap() > 0);
    assert_eq!(
        answer["items"][0]["item_id"],
        hex16(folder.as_bytes()).as_str()
    );
    assert_eq!(answer["items"][0]["version"], 1);
    assert_eq!(
        answer["items"][1]["item_id"],
        hex16(file.as_bytes()).as_str()
    );
    assert_eq!(answer["items"][1]["version"], 1);
    assert_hex(&answer["commit_id"], 16, "commit_id");
}

#[test]
fn a_correct_base_version_gets_the_next_version() {
    // Р3, П26: base 1 → version 2 → base 2 → version 3.
    let space = fresh_space(&Target::from_env());
    let item = new_item();
    space.commit_ok(&[space.file(&item, 0, "a.md", b"one")]);
    let second = space
        .commit(&[space.file(&item, 1, "a.md", b"two")])
        .expect(200)
        .json();
    assert_eq!(second["items"][0]["version"], 2);
    assert_eq!(second["seq"], 2);
    let third = space
        .commit(&[space.file(&item, 2, "a.md", b"three")])
        .expect(200)
        .json();
    assert_eq!(third["items"][0]["version"], 3);
}

#[test]
fn a_stale_item_refuses_the_whole_commit() {
    // Р3, О5, П27: one stale base among several refuses everything; nothing is applied, even the
    // items that were fine.
    let space = fresh_space(&Target::from_env());
    let (stale, fine) = (new_item(), new_item());
    space.commit_ok(&[space.file(&stale, 0, "stale.md", b"v1")]);
    space.commit_ok(&[space.file(&stale, 1, "stale.md", b"v2")]);
    let seq_before = 2;
    let refused = space
        .commit(&[
            space.file(&fine, 0, "new.md", b"brand new"),
            space.file(&stale, 1, "stale.md", b"from a device that was behind"),
        ])
        .expect_error(409, "version_conflict");
    let conflicts = refused.details()["conflicts"].clone();
    assert_eq!(
        conflicts,
        json!([{ "item_id": hex16(stale.as_bytes()), "base_version": 1, "current_version": 2 }])
    );
    let feed = space.changes(0, None).expect(200).json();
    assert_eq!(feed["seq"], seq_before, "a refused commit spends no seq");
    assert!(
        !ids(feed["changes"].as_array().unwrap()).contains(&hex16(fine.as_bytes())),
        "the fine item of a refused commit must not appear"
    );
    // The fine item can be committed alone afterwards, with the version it would have had.
    let later = space
        .commit(&[space.file(&fine, 0, "new.md", b"brand new")])
        .expect(200)
        .json();
    assert_eq!(later["items"][0]["version"], 1);
    assert_eq!(later["seq"], 3);
}

#[test]
fn every_conflicting_item_is_listed() {
    // П27: all of them, with the version each one has now.
    let space = fresh_space(&Target::from_env());
    let items: Vec<ItemId> = (0..4).map(|_| new_item()).collect();
    for item in &items {
        space.commit_ok(&[space.file(item, 0, "x.md", b"1")]);
    }
    space.commit_ok(&[space.file(&items[1], 1, "x.md", b"2")]);
    space.commit_ok(&[space.file(&items[1], 2, "x.md", b"3")]);
    space.commit_ok(&[space.file(&items[3], 1, "x.md", b"2")]);
    let refused = space
        .commit(&[
            space.file(&items[0], 1, "x.md", b"fine"),
            space.file(&items[1], 1, "x.md", b"stale"),
            space.file(&items[2], 0, "x.md", b"already exists"),
            space.file(&items[3], 1, "x.md", b"stale too"),
        ])
        .expect_error(409, "version_conflict");
    let mut conflicts: Vec<(String, u64, u64)> = refused.details()["conflicts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["item_id"].as_str().unwrap().to_string(),
                c["base_version"].as_u64().unwrap(),
                c["current_version"].as_u64().unwrap(),
            )
        })
        .collect();
    conflicts.sort();
    let mut expected = vec![
        (hex16(items[1].as_bytes()), 1, 3),
        (hex16(items[2].as_bytes()), 0, 1),
        (hex16(items[3].as_bytes()), 1, 2),
    ];
    expected.sort();
    assert_eq!(conflicts, expected);
}

#[test]
fn updating_an_item_that_does_not_exist_is_a_conflict_with_version_zero() {
    // П27: the current version of a missing item is 0.
    let space = fresh_space(&Target::from_env());
    let ghost = new_item();
    let refused = space
        .commit(&[space.file(&ghost, 5, "ghost.md", b"?")])
        .expect_error(409, "version_conflict");
    assert_eq!(refused.details()["conflicts"][0]["current_version"], 0);
    assert_eq!(refused.details()["conflicts"][0]["base_version"], 5);
}

#[test]
fn seq_counts_accepted_commits_without_gaps_and_a_commit_shares_one_seq() {
    // П29, Р3: refused commits and replays spend nothing; all items of a commit share a seq.
    let space = fresh_space(&Target::from_env());
    let a = new_item();
    assert_eq!(space.commit_ok(&[space.file(&a, 0, "a.md", b"1")]), 1);
    let _ = space
        .commit(&[space.file(&a, 0, "a.md", b"x")])
        .expect_error(409, "version_conflict");
    assert_eq!(space.commit_ok(&[space.file(&a, 1, "a.md", b"2")]), 2);
    let (b, c, d) = (new_item(), new_item(), new_item());
    let batch = [
        space.folder(&b, 0, "B"),
        space.folder(&c, 0, "C"),
        space.folder(&d, 0, "D"),
    ];
    let commit_id = random16();
    assert_eq!(
        space.commit_with(&commit_id, &batch).expect(200).json()["seq"],
        3
    );
    space.commit_with(&commit_id, &batch).expect(200);
    assert_eq!(space.commit_ok(&[space.folder(&new_item(), 0, "E")]), 4);
    let feed = space.all_changes(0);
    let seqs: Vec<u64> = feed.iter().map(|c| c["seq"].as_u64().unwrap()).collect();
    // The first item moved from seq 1 to seq 2 (П31): the feed holds its latest version only.
    assert_eq!(seqs, vec![2, 3, 3, 3, 4]);
}

#[test]
fn racing_commits_from_one_base_accept_exactly_one() {
    // Р3, О5, П27: eight devices change the same item from version 1 at the same moment; the
    // server takes one and refuses the rest with `version_conflict`.
    let space = fresh_space(&Target::from_env());
    let item = new_item();
    space.commit_ok(&[space.file(&item, 0, "shared.md", b"start")]);
    let attempts: Vec<_> = (0..8)
        .map(|n| space.file(&item, 1, "shared.md", format!("edit {n}").as_bytes()))
        .collect();
    let barrier = Barrier::new(attempts.len());
    let statuses: Vec<(u16, Option<String>)> = std::thread::scope(|scope| {
        let handles: Vec<_> = attempts
            .iter()
            .map(|attempt| {
                let (space, barrier) = (&space, &barrier);
                scope.spawn(move || {
                    barrier.wait();
                    let answer = space.commit(std::slice::from_ref(attempt));
                    (answer.status, answer.error_code())
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let accepted = statuses.iter().filter(|(status, _)| *status == 200).count();
    let refused = statuses
        .iter()
        .filter(|(status, code)| *status == 409 && code.as_deref() == Some("version_conflict"))
        .count();
    assert_eq!((accepted, refused), (1, 7), "answers: {statuses:?}");
    let feed = space.all_changes(0);
    assert_eq!(feed.len(), 1, "one entry for the item (П31)");
    assert_eq!(feed[0]["version"], 2, "exactly one winner");
}

#[test]
fn racing_commits_on_different_items_are_all_accepted_with_distinct_seqs() {
    // Р3, П29: commits of one space are applied one after another; no seq is skipped or reused.
    let space = fresh_space(&Target::from_env());
    let attempts: Vec<_> = (0..8)
        .map(|n| space.folder(&new_item(), 0, &format!("F{n}")))
        .collect();
    let barrier = Barrier::new(attempts.len());
    let mut seqs: Vec<u64> = std::thread::scope(|scope| {
        let handles: Vec<_> = attempts
            .iter()
            .map(|attempt| {
                let (space, barrier) = (&space, &barrier);
                scope.spawn(move || {
                    barrier.wait();
                    space
                        .commit(std::slice::from_ref(attempt))
                        .expect(200)
                        .json()["seq"]
                        .as_u64()
                        .unwrap()
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    seqs.sort_unstable();
    assert_eq!(seqs, (1..=8).collect::<Vec<u64>>());
}

#[test]
fn racing_batches_that_overlap_leave_no_half_applied_batch() {
    // Р2, Р3, П27: two renames of folders share one file; one batch wins whole, the other leaves
    // nothing behind (no new item of the loser appears).
    let space = fresh_space(&Target::from_env());
    let shared = new_item();
    space.commit_ok(&[space.file(&shared, 0, "shared.md", b"x")]);
    let (a_only, b_only) = ([new_item(), new_item()], [new_item(), new_item()]);
    let batch_a = [
        space.file(&shared, 1, "A/shared.md", b"x"),
        space.folder(&a_only[0], 0, "A"),
        space.folder(&a_only[1], 0, "A/inner"),
    ];
    let batch_b = [
        space.file(&shared, 1, "B/shared.md", b"x"),
        space.folder(&b_only[0], 0, "B"),
        space.folder(&b_only[1], 0, "B/inner"),
    ];
    let barrier = Barrier::new(2);
    let answers: Vec<u16> = std::thread::scope(|scope| {
        let handles: Vec<_> = [&batch_a, &batch_b]
            .into_iter()
            .map(|batch| {
                let (space, barrier) = (&space, &barrier);
                scope.spawn(move || {
                    barrier.wait();
                    space.commit(batch).status
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(
        answers.iter().filter(|&&s| s == 200).count(),
        1,
        "answers: {answers:?}"
    );
    assert_eq!(
        answers.iter().filter(|&&s| s == 409).count(),
        1,
        "answers: {answers:?}"
    );
    let winner_is_a = answers[0] == 200;
    let feed = space.all_changes(0);
    let present = ids(&feed);
    let (won, lost) = if winner_is_a {
        (&a_only, &b_only)
    } else {
        (&b_only, &a_only)
    };
    for item in won {
        assert!(
            present.contains(&hex16(item.as_bytes())),
            "the winner's items arrive together"
        );
    }
    for item in lost {
        assert!(
            !present.contains(&hex16(item.as_bytes())),
            "nothing of the loser may remain"
        );
    }
}

#[test]
fn a_repeated_commit_returns_the_first_answer_and_applies_nothing_twice() {
    // С2, Р3, П28: the answer got lost; the same commit_id comes again.
    let space = fresh_space(&Target::from_env());
    let item = new_item();
    let batch = [space.file(&item, 0, "a.md", b"once")];
    let commit_id = random16();
    let first = space.commit_with(&commit_id, &batch).expect(200).json();
    let second = space.commit_with(&commit_id, &batch).expect(200).json();
    assert_eq!(second["replayed"], true);
    assert_eq!(second["seq"], first["seq"]);
    assert_eq!(second["items"], first["items"]);
    assert_eq!(second["committed_ms"], first["committed_ms"]);
    let feed = space.all_changes(0);
    assert_eq!(feed.len(), 1, "the change must not be applied twice");
}

#[test]
fn a_replay_after_the_item_moved_on_still_gets_the_first_answer() {
    // С2, П28: the retry arrives after another commit changed the item.
    let space = fresh_space(&Target::from_env());
    let item = new_item();
    let batch = [space.file(&item, 0, "a.md", b"first")];
    let commit_id = random16();
    space.commit_with(&commit_id, &batch).expect(200);
    space.commit_ok(&[space.file(&item, 1, "a.md", b"second")]);
    let replay = space.commit_with(&commit_id, &batch).expect(200).json();
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["seq"], 1);
    assert_eq!(replay["items"][0]["version"], 1);
}

#[test]
fn the_same_commit_id_with_other_content_is_refused() {
    // П28: a reused id is a bug or an attack; it is not a replay.
    let space = fresh_space(&Target::from_env());
    let commit_id = random16();
    space
        .commit_with(&commit_id, &[space.file(&new_item(), 0, "a.md", b"a")])
        .expect(200);
    space
        .commit_with(&commit_id, &[space.file(&new_item(), 0, "b.md", b"b")])
        .expect_error(409, "commit_id_reused");
}

#[test]
fn a_refused_commit_is_not_remembered() {
    // П28: after a conflict the device may fix the base and send again with the same commit_id.
    let space = fresh_space(&Target::from_env());
    let item = new_item();
    space.commit_ok(&[space.file(&item, 0, "a.md", b"v1")]);
    space.commit_ok(&[space.file(&item, 1, "a.md", b"v2")]);
    let commit_id = random16();
    space
        .commit_with(&commit_id, &[space.file(&item, 1, "a.md", b"mine")])
        .expect_error(409, "version_conflict");
    let retried = space
        .commit_with(&commit_id, &[space.file(&item, 2, "a.md", b"mine on top")])
        .expect(200)
        .json();
    assert_eq!(retried["replayed"], false);
    assert_eq!(retried["items"][0]["version"], 3);
}

#[test]
fn a_commit_may_only_refer_to_a_finished_body_of_this_space() {
    // П30: unknown, unfinished and foreign bodies are `unknown_blob`, and the commit is refused
    // whole.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    let other = account.create_space();
    let (ok_item, bad_item) = (new_item(), new_item());
    let good = space.file(&ok_item, 0, "good.md", b"good");

    // A body that was never started.
    let unknown = space.file_with_uploaded_body(&bad_item, 0, "bad.md", b"x", &new_body());
    space
        .commit(&[good.clone(), unknown])
        .expect_error(422, "unknown_blob");

    // A body started but not completed.
    let unfinished = new_body();
    space.init_blob(&unfinished, 100).expect(201);
    space.put_part(&unfinished, 0, vec![1; 100]).expect(200);
    let pending = space.file_with_uploaded_body(&bad_item, 0, "bad.md", b"x", &unfinished);
    space
        .commit(&[good.clone(), pending])
        .expect_error(422, "unknown_blob");

    // A finished body of the other space.
    let foreign = new_body();
    other.upload_sealed(&foreign, &[3u8; 100]);
    let stolen = space.file_with_uploaded_body(&bad_item, 0, "bad.md", b"x", &foreign);
    space
        .commit(&[good.clone(), stolen])
        .expect_error(422, "unknown_blob");

    assert!(
        space.all_changes(0).is_empty(),
        "the good item of a refused commit must not appear"
    );
    space.commit(&[good]).expect(200);
}

#[test]
fn a_rename_reuses_the_body_without_uploading_it_again() {
    // Р2, П30: version 2 points to the body of version 1 under a new path.
    let space = fresh_space(&Target::from_env());
    let item = new_item();
    let first = space.file(&item, 0, "old name.md", b"same bytes");
    let body = first.body.unwrap();
    space.commit_ok(&[first]);
    let renamed = space.file_with_uploaded_body(&item, 1, "new name.md", b"same bytes", &body);
    space.commit_ok(&[renamed]);
    let feed = space.all_changes(0);
    assert_eq!(feed.len(), 1, "the feed has the latest version only (П31)");
    assert_eq!(feed[0]["version"], 2);
    assert_eq!(feed[0]["blob_id"], hex16(body.as_bytes()).as_str());
    assert_eq!(space.open_change(&feed[0]).path, "new name.md");
    assert_eq!(space.fetch_file(&feed[0]), b"same bytes");
}

#[test]
fn a_deletion_is_a_new_version_with_an_open_mark_and_an_encrypted_header() {
    // Р6, О4, П26: the device believes the encrypted header, the server keeps the mark for
    // cleanup; the item stays in the feed.
    let space = fresh_space(&Target::from_env());
    let item = new_item();
    space.commit_ok(&[space.file(&item, 0, "gone.md", b"bye")]);
    let answer = space
        .commit(&[space.deletion(&item, 1, "gone.md")])
        .expect(200)
        .json();
    assert_eq!(answer["items"][0]["version"], 2);
    let feed = space.all_changes(0);
    assert_eq!(feed.len(), 1, "the deletion replaces the entry (П31)");
    assert_eq!(feed[0]["deleted"], true);
    assert_eq!(feed[0]["blob_id"], Value::Null);
    assert!(space.open_change(&feed[0]).deleted);
    let history = space.versions(&item).expect(200).json();
    assert_eq!(
        history["versions"].as_array().unwrap().len(),
        2,
        "the content stays in the history"
    );
}

#[test]
fn a_folder_is_an_item_without_a_body() {
    // Р2, П26: empty folders arrive; `blob_id` is null.
    let space = fresh_space(&Target::from_env());
    let folder = new_item();
    space.commit_ok(&[space.folder(&folder, 0, "Empty folder")]);
    let change = space.all_changes(0).remove(0);
    assert_eq!(change["blob_id"], Value::Null);
    assert_eq!(change["blob_size"], Value::Null);
    assert_eq!(space.open_change(&change).path, "Empty folder");
}

#[test]
fn a_bad_commit_is_a_400_and_changes_nothing() {
    // П26, П2, П8: empty list, a repeated item, bad hex, a short header, a missing field.
    let space = fresh_space(&Target::from_env());
    let item = new_item();
    let good = space.file(&item, 0, "a.md", b"a");
    let entry = |extra: Value| {
        let mut base = good.json.clone();
        for (key, value) in extra.as_object().unwrap() {
            base[key] = value.clone();
        }
        base
    };
    let request = |items: Vec<Value>| json!({ "commit_id": hex16(&random16()), "items": items });

    space
        .post("/commit", request(vec![]))
        .expect_error(400, "bad_request");
    space
        .post(
            "/commit",
            request(vec![good.json.clone(), good.json.clone()]),
        )
        .expect_error(400, "duplicate_item");
    space
        .post(
            "/commit",
            request(vec![entry(json!({ "header": "ZZ".repeat(400) }))]),
        )
        .expect_error(400, "bad_request");
    space
        .post(
            "/commit",
            request(vec![entry(json!({ "header": "ab".repeat(10) }))]),
        )
        .expect_error(400, "bad_request");
    space
        .post(
            "/commit",
            request(vec![entry(json!({ "item_id": "AB".repeat(16) }))]),
        )
        .expect_error(400, "bad_request");
    space
        .post(
            "/commit",
            request(vec![entry(json!({ "base_version": -1 }))]),
        )
        .expect_error(400, "bad_request");
    space
        .post(
            "/commit",
            json!({ "commit_id": "abcd", "items": [good.json.clone()] }),
        )
        .expect_error(400, "bad_request");
    let mut no_base = good.json.clone();
    no_base.as_object_mut().unwrap().remove("base_version");
    space
        .post("/commit", request(vec![no_base]))
        .expect_error(400, "bad_request");
    assert!(space.all_changes(0).is_empty());
}

#[test]
fn the_server_never_decides_by_time() {
    // Р3, С10: a clock that jumps a year changes no version number; only the base counts.
    let target = Target::in_process();
    let control = in_process_or_skip!(target);
    let space = fresh_space(&target);
    let item = new_item();
    let first = space
        .commit(&[space.file(&item, 0, "a.md", b"1")])
        .expect(200)
        .json();
    control.advance(Duration::from_secs(366 * 24 * 3600));
    let second = space
        .commit(&[space.file(&item, 1, "a.md", b"2")])
        .expect(200)
        .json();
    assert_eq!(second["items"][0]["version"], 2);
    assert_eq!(second["seq"], 2);
    let (a, b) = (
        first["committed_ms"].as_i64().unwrap(),
        second["committed_ms"].as_i64().unwrap(),
    );
    assert!(
        b - a >= 365 * 24 * 3600 * 1000,
        "committed_ms follows the server clock: {a} → {b}"
    );
}
