//! Appendix Т, Т4 (finding Б2): the engine splits what it sends into commits of at most
//! `min(max_commit_items, 1000)` entries **and** at most 1 MiB of request JSON, so that another
//! device can read every page of the feed (the client reads 4 MiB per answer, 96 MiB for the feed
//! after Т5). The server's feed shows what the engine sent: entries grouped by `seq` are the
//! commits; the size is estimated from the entry as the feed shows it. Real engine only (the
//! mini-engine has no folders and no limits).
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

use amby_sync_core::crypto::header::ItemKind;
use serde_json::Value;
use std::collections::BTreeMap;

const MIB: usize = 1024 * 1024;
/// Per entry of a commit request besides the hex of the header: the keys, `item_id`, `blob_id`,
/// `base_version`, `deleted` and the separators (the sum is about 150 bytes; this is generous).
const OVERHEAD: usize = 200;

/// The commits of the server from `since`: entries grouped by `seq`, in feed order, each with its
/// estimated request size (the hex of the header and the fixed fields of the request).
fn commits_since(w: &World, since: u64) -> BTreeMap<u64, Vec<(Value, usize)>> {
    let mut out: BTreeMap<u64, Vec<(Value, usize)>> = BTreeMap::new();
    for entry in w.space(0).all_changes(since) {
        let size = entry["header"].as_str().unwrap().len() + OVERHEAD;
        out.entry(entry["seq"].as_u64().unwrap())
            .or_default()
            .push((entry, size));
    }
    out
}

fn assert_commit_limits(commits: &BTreeMap<u64, Vec<(Value, usize)>>) {
    for (seq, entries) in commits {
        let total: usize = entries.iter().map(|(_, size)| size).sum::<usize>() + 100;
        assert!(
            entries.len() <= 1000,
            "commit {seq} has {} entries (at most 1000)",
            entries.len()
        );
        assert!(
            total <= MIB,
            "commit {seq} is about {total} bytes of JSON (at most 1 MiB)"
        );
    }
}

fn world_of_two() -> World {
    let w = World::new(Engine::boxed, WorldOptions::new(2).isolated());
    // The server of the suite lowers the JSON limit to 2 MiB; the default of a real server is
    // 64 MiB (the setting this finding is about). With the default, an engine that sends one
    // huge commit succeeds in sending it and the test shows the commit itself, instead of an
    // upload that stalls on a refused request.
    w.control()
        .restart_with(|config| config.max_json_bytes = 64 * MIB);
    w
}

fn content(i: usize) -> String {
    format!("file number {i}")
}

fn t4_the_first_upload_of_6000_files_is_split_and_the_other_device_gets_every_byte(
    _b: EngineBuilder,
) {
    // Т4: 6 000 small files: every commit ≤ 1 000 entries and ≤ 1 MiB; device 2 gets all of them.
    let w = world_of_two();
    for i in 0..6000 {
        w.save(0, &format!("Big/d{:02}/f{i:04}.md", i % 40), &content(i));
    }
    w.pass(0);
    let commits = commits_since(&w, 0);
    assert_commit_limits(&commits);
    let entries: usize = commits.values().map(Vec::len).sum();
    assert!(entries >= 6000, "everything must reach the server");
    assert!(commits.len() >= 6, "6 000 entries need at least 6 commits");
    w.pass(1);
    for i in 0..6000 {
        let path = format!("Big/d{:02}/f{i:04}.md", i % 40);
        assert_eq!(
            w.read(1, &path).as_deref(),
            Some(content(i).as_str()),
            "{path} on the second device"
        );
    }
}

fn t4_long_paths_make_commits_smaller_but_never_over_1_mib(_b: EngineBuilder) {
    // Т4: paths of ~1 500 bytes make the headers large; the number of entries per commit goes
    // down (under 1 000) and the size stays under 1 MiB.
    let w = world_of_two();
    let dir = (0..6)
        .map(|n| format!("{n}{}", "d".repeat(244)))
        .collect::<Vec<_>>()
        .join("/");
    for i in 0..1500 {
        w.save(0, &format!("{dir}/f{i:04}.md"), &content(i));
    }
    w.pass(0);
    let commits = commits_since(&w, 0);
    assert_commit_limits(&commits);
    let most = commits.values().map(Vec::len).max().unwrap();
    assert!(
        most < 1000,
        "long paths must lower the entries per commit, the largest has {most}"
    );
    assert!(commits.len() >= 4, "got {} commits", commits.len());
    w.pass(1);
    for i in (0..1500).step_by(97) {
        assert_eq!(
            w.read(1, &format!("{dir}/f{i:04}.md")).as_deref(),
            Some(content(i).as_str())
        );
    }
}

fn t4_a_rename_of_a_folder_with_2500_files_arrives_whole_and_the_folder_goes_first(
    _b: EngineBuilder,
) {
    // Т4, Д18, Д50: several commits in the limits; the folder record before the files by path;
    // the other device ends with every file at the new path, none at the old one.
    let w = world_of_two();
    for i in 0..2500 {
        w.save(0, &format!("Proj/sub/f{i:04}.md"), &content(i));
    }
    w.pass(0);
    w.pass(1);
    let head = w.server_head();
    w.dev(0).fs.user_rename("Proj", "Archive/Proj");
    w.pass(0);
    let commits = commits_since(&w, head);
    assert_commit_limits(&commits);
    assert!(commits.len() >= 3, "2 500 files need at least 3 commits");
    // The first record under the new folder is the folder itself.
    let space = w.space(0);
    let moved: Vec<_> = commits
        .values()
        .flatten()
        .map(|(entry, _)| space.open_change(entry))
        .filter(|header| header.path.starts_with("Archive/Proj"))
        .collect();
    assert!(moved.len() >= 2501, "renamed records: {}", moved.len());
    assert_eq!(moved[0].kind, ItemKind::Folder);
    assert_eq!(moved[0].path, "Archive/Proj");
    w.pass(1);
    for i in 0..2500 {
        let path = format!("Archive/Proj/sub/f{i:04}.md");
        assert_eq!(w.read(1, &path).as_deref(), Some(content(i).as_str()));
    }
    assert!(!w.dev(1).fs.exists("Proj"), "the old folder is gone");
}

real_only!(
    t4_the_first_upload_of_6000_files_is_split_and_the_other_device_gets_every_byte,
    t4_long_paths_make_commits_smaller_but_never_over_1_mib,
    t4_a_rename_of_a_folder_with_2500_files_arrives_whole_and_the_folder_goes_first,
);
