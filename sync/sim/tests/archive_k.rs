//! Appendix К (docs/sync-plan.md): the archive `.amby/archive/` and its records
//! `.amby/archive/.meta/` are synchronised like ordinary files (К1, К8), a move to the archive is a
//! rename that arrives on the other device as an archived file (К1), and two computers that each
//! migrated their own old trash into the same archive path bind when the bytes are equal (К10,
//! Д15) and make an ordinary conflict when they differ (К10, Р7). Written before the code (раздел
//! 6): the real engine only, red until `is_excluded_path` keeps the archive. The mini-engine has
//! its own rules and is not part of this appendix.
#![allow(clippy::unwrap_used, clippy::expect_used)]

#[macro_use]
mod common;
use common::*;

fn k1_a_move_to_the_archive_arrives_as_an_archived_file(_b: EngineBuilder) {
    // К1: "перенос в архив — это переименование, на другом компьютере файл тоже оказывается в
    // архиве": the same record of the server, no trash, no copy, no conflict.
    let w = pair_with_a(Engine::boxed);
    let (item, _) = w.item_at("Notes/a.md");
    w.dev(0)
        .fs
        .user_rename("Notes/a.md", ".amby/archive/Notes/a.md");
    w.save(
        0,
        ".amby/archive/.meta/r1.json",
        r#"{"path":"Notes/a.md","archivedAtMs":1700000000000}"#,
    );
    w.pass(0);
    w.pass(1);
    assert_eq!(
        w.read(1, ".amby/archive/Notes/a.md").as_deref(),
        Some("base")
    );
    assert!(
        !w.dev(1).fs.exists("Notes/a.md"),
        "it left its place on the other computer too"
    );
    assert_eq!(
        w.read(1, ".amby/archive/.meta/r1.json").as_deref(),
        Some(r#"{"path":"Notes/a.md","archivedAtMs":1700000000000}"#),
        "К8: the record travels with the archive"
    );
    assert_eq!(
        w.item_at(".amby/archive/Notes/a.md").0,
        item,
        "a rename of the same record, not a deletion and a new file"
    );
    assert!(
        w.dev(1).fs.trash().is_empty(),
        "К3: the archived file is not a deletion"
    );
    assert!(w.sets(0).is_empty() && w.sets(1).is_empty());
    w.finish(true);
}

fn k1_a_folder_moved_to_the_archive_arrives_whole(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    for i in 0..4 {
        w.save(0, &format!("Proj/sub/f{i}.md"), &format!("file {i}"));
    }
    w.pass(0);
    w.pass(1);
    w.dev(0).fs.user_rename("Proj", ".amby/archive/Proj");
    w.pass(0);
    w.pass(1);
    for i in 0..4 {
        assert_eq!(
            w.read(1, &format!(".amby/archive/Proj/sub/f{i}.md"))
                .as_deref(),
            Some(format!("file {i}").as_str())
        );
    }
    assert!(!w.dev(1).fs.exists("Proj"));
    assert!(w.dev(1).fs.trash().is_empty());
    w.finish(true);
}

fn k1_a_restore_from_the_archive_is_a_rename_back(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.dev(0)
        .fs
        .user_rename("Notes/a.md", ".amby/archive/Notes/a.md");
    w.pass(0);
    w.pass(1);
    w.dev(1)
        .fs
        .user_rename(".amby/archive/Notes/a.md", "Notes/a.md");
    w.pass(1);
    w.pass(0);
    assert_eq!(w.read(0, "Notes/a.md").as_deref(), Some("base"));
    assert!(!w.dev(0).fs.exists(".amby/archive/Notes/a.md"));
    assert!(w.dev(0).fs.trash().is_empty());
    w.finish(true);
}

fn k8_the_records_of_the_archive_are_ordinary_synchronised_files(_b: EngineBuilder) {
    let w = pair_with_a(Engine::boxed);
    w.save(
        0,
        ".amby/archive/.meta/r1.json",
        r#"{"path":"x.md","archivedAtMs":1}"#,
    );
    w.pass(0);
    assert!(w.server_files().contains_key(".amby/archive/.meta/r1.json"));
    w.pass(1);
    assert_eq!(
        w.read(1, ".amby/archive/.meta/r1.json").as_deref(),
        Some(r#"{"path":"x.md","archivedAtMs":1}"#)
    );
    // A record edited on one computer (the app rewrites it, keeping unknown fields) travels too.
    w.save(
        1,
        ".amby/archive/.meta/r1.json",
        r#"{"path":"x.md","archivedAtMs":1,"future":true}"#,
    );
    w.pass(1);
    w.pass(0);
    assert_eq!(
        w.read(0, ".amby/archive/.meta/r1.json").as_deref(),
        Some(r#"{"path":"x.md","archivedAtMs":1,"future":true}"#)
    );
    w.finish(true);
}

fn k10_two_computers_with_the_same_file_at_one_archive_path_bind_and_write_nothing(
    _b: EngineBuilder,
) {
    // К10, Д15: "один и тот же путь и хэш — ничего не пишется".
    let w = pair_with_a(Engine::boxed);
    w.save(0, ".amby/archive/Notes/gone.md", "the same bytes");
    w.save(1, ".amby/archive/Notes/gone.md", "the same bytes");
    w.pass(0);
    assert!(
        w.server_files().contains_key(".amby/archive/Notes/gone.md"),
        "the first computer sent it as a new file of the archive"
    );
    let items = w.server_item_count();
    let head = w.server_head();
    let report = w.pass(1);
    assert_eq!(
        report.downloaded, 0,
        "nothing is downloaded: the file is already there"
    );
    assert_eq!(report.uploaded, 0, "nothing is sent");
    assert_eq!(w.server_item_count(), items, "no second record");
    assert_eq!(w.server_head(), head, "nothing is committed");
    assert!(w.sets(0).is_empty() && w.sets(1).is_empty(), "no conflict");
    assert!(
        disk_changes(&w, 1).iter().all(|event| match event {
            FsEvent::Publish { path, .. } => path != ".amby/archive/Notes/gone.md",
            _ => true,
        }),
        "the file of the second computer is not rewritten"
    );
    for d in 0..2 {
        assert_eq!(
            w.read(d, ".amby/archive/Notes/gone.md").as_deref(),
            Some("the same bytes")
        );
    }
    w.pass(0);
    w.finish(true);
}

fn k10_two_computers_with_different_files_at_one_archive_path_make_an_ordinary_conflict(
    _b: EngineBuilder,
) {
    // К10, Р7: "разные — обычный конфликт, ничего не теряется": the path stays with the one that
    // reached the server first, the other version lies in the set of conflicts on both computers.
    let w = pair_with_a(Engine::boxed);
    w.save(0, ".amby/archive/Notes/gone.md", "from the first");
    w.save(1, ".amby/archive/Notes/gone.md", "from the second");
    w.pass(0);
    w.pass(1);
    w.pass(0);
    w.settle_ok();
    for d in 0..2 {
        assert_eq!(
            w.read(d, ".amby/archive/Notes/gone.md").as_deref(),
            Some("from the first"),
            "device {d}: the path stays with the first"
        );
        let texts = w.texts(d);
        assert!(
            texts.values().any(|text| text == "from the second"),
            "device {d}: the other version is kept somewhere: {texts:?}"
        );
        assert_eq!(
            w.others(d, ".amby/archive/Notes/gone.md"),
            vec!["from the second".to_string()],
            "device {d}: one ordinary conflict set"
        );
    }
    w.finish(false);
}

real_only!(
    k1_a_move_to_the_archive_arrives_as_an_archived_file,
    k1_a_folder_moved_to_the_archive_arrives_whole,
    k1_a_restore_from_the_archive_is_a_rename_back,
    k8_the_records_of_the_archive_are_ordinary_synchronised_files,
    k10_two_computers_with_the_same_file_at_one_archive_path_bind_and_write_nothing,
    k10_two_computers_with_different_files_at_one_archive_path_make_an_ordinary_conflict,
);
