//! The move of the old trash into the archive (docs/sync-plan.md, К7, К9; К10 is in
//! `sync/archive_sync_tests.rs`). Written before the code (section 6): red on the `todo!()` stubs
//! of `archive_migration.rs`. The tests look at files on disk and at the answers of the public
//! functions, not at the format of the journal; the one thing they ask of the journal is that it
//! exists in `.amby/migrations/` before the first move and carries a version.

use std::collections::BTreeMap;
use std::fs;

use ulid::Ulid;

use super::*;
use crate::archive::test_support::{copy_dir, Vault};
use crate::archive::{self, ArchiveEntry};
use crate::recycle_bin;

// ----- a vault with an old trash -----

fn trash_id(n: u64) -> String {
    Ulid::from_parts(1_700_000_000_000 + n, u128::from(n)).to_string()
}

enum Payload<'a> {
    File(&'a [u8]),
    Folder(&'a [(&'a str, &'a [u8])]),
    Missing,
}

/// One entry of `.amby/trash/` as the old code wrote it: `<id>.json` and `<id>/<name>`.
fn trash_entry(
    vault: &Vault,
    n: u64,
    original: &str,
    deleted_at_ms: u64,
    payload: Payload<'_>,
) -> String {
    let id = trash_id(n);
    let name = original.rsplit('/').next().unwrap().to_string();
    vault.put(
        &format!(".amby/trash/{id}.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "id": id,
            "originalPath": original,
            "deletedAtMs": deleted_at_ms,
            "name": name,
        }))
        .unwrap()
        .as_slice(),
    );
    match payload {
        Payload::File(bytes) => {
            vault.put(&format!(".amby/trash/{id}/{name}"), bytes);
        }
        Payload::Folder(files) => {
            for (rel, bytes) in files {
                vault.put(&format!(".amby/trash/{id}/{name}/{rel}"), bytes);
            }
        }
        Payload::Missing => {}
    }
    id
}

struct Ids {
    file: String,
    folder: String,
    cyrillic: String,
    service: String,
    no_payload: String,
    broken: String,
    unsafe_path: String,
    occupied: String,
}

/// Eight entries: four that move (a file, a folder, a Russian name, a file whose place in the
/// archive is taken) and four that stay (a service one, one without content, one with a damaged
/// description, one with a path that leads out of the vault). Every payload has its own text, so
/// "nothing lost, nothing copied" is a count.
fn old_trash() -> (Vault, Ids) {
    let vault = Vault::new();
    vault.put(".amby/archive/Notes/b.md", b"B-arrived");
    let ids = Ids {
        file: trash_entry(&vault, 1, "Notes/a.md", 1000, Payload::File(b"A")),
        folder: trash_entry(
            &vault,
            2,
            "Proj",
            2000,
            Payload::Folder(&[("a.md", b"pa"), ("sub/b.md", b"pb")]),
        ),
        cyrillic: trash_entry(
            &vault,
            3,
            "Мир/Черновик.md",
            3000,
            Payload::File("C".as_bytes()),
        ),
        service: trash_entry(
            &vault,
            4,
            ".amby/conflicts/c1/meta.json",
            4000,
            Payload::File(b"S"),
        ),
        no_payload: trash_entry(&vault, 5, "Lost/l.md", 4500, Payload::Missing),
        broken: {
            let id = trash_id(6);
            vault.put(&format!(".amby/trash/{id}.json"), b"{not json");
            vault.put(&format!(".amby/trash/{id}/x.md"), b"Z");
            id
        },
        unsafe_path: trash_entry(&vault, 7, "../escape.md", 4700, Payload::File(b"E")),
        occupied: trash_entry(&vault, 8, "Notes/b.md", 5000, Payload::File(b"B-trash")),
    };
    (vault, ids)
}

const PAYLOADS: [&str; 9] = ["A", "pa", "pb", "C", "S", "Z", "E", "B-trash", "B-arrived"];

fn payload_text(vault: &Vault) -> BTreeMap<String, Vec<u8>> {
    vault
        .files()
        .into_iter()
        .filter(|(path, _)| !path.starts_with(".amby/migrations/"))
        .collect()
}

/// К9: nothing is deleted and nothing is copied: each payload is in exactly one file.
fn assert_each_payload_exactly_once(vault: &Vault, when: &str) {
    let files = vault.files();
    for text in PAYLOADS {
        let found: Vec<&String> = files
            .iter()
            .filter(|(path, bytes)| {
                bytes.as_slice() == text.as_bytes() && !path.starts_with(".amby/migrations/")
            })
            .map(|(path, _)| path)
            .collect();
        assert_eq!(found.len(), 1, "{when}: {text:?} is in {found:?}");
    }
}

fn kept_set(outcome: &Outcome) -> Vec<(String, KeptReason)> {
    let mut kept: Vec<(String, KeptReason)> = outcome
        .kept
        .iter()
        .map(|item| (item.id.clone(), item.reason))
        .collect();
    kept.sort_by(|a, b| a.0.cmp(&b.0));
    kept
}

fn expected_kept(ids: &Ids) -> Vec<(String, KeptReason)> {
    let mut kept = vec![
        (ids.service.clone(), KeptReason::Service),
        (ids.no_payload.clone(), KeptReason::NoPayload),
        (ids.broken.clone(), KeptReason::BrokenManifest),
        (ids.unsafe_path.clone(), KeptReason::UnsafePath),
    ];
    kept.sort_by(|a, b| a.0.cmp(&b.0));
    kept
}

fn entries(vault: &Vault) -> Vec<ArchiveEntry> {
    let mut all = archive::list(&vault.root);
    all.sort_by(|a, b| a.original_path.cmp(&b.original_path));
    all
}

// ----- К9: the preflight -----

#[test]
fn k9_the_preflight_counts_what_would_move_and_writes_nothing() {
    let (vault, ids) = old_trash();
    let before = vault.files();
    let report = preflight(&vault.root).unwrap();
    assert_eq!(vault.files(), before, "К9: a read-only look");
    assert!(!vault.exists(".amby/migrations"));
    assert_eq!(report.to_move, 4);
    let mut kept: Vec<(String, KeptReason)> = report
        .to_keep
        .iter()
        .map(|item| (item.id.clone(), item.reason))
        .collect();
    kept.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(kept, expected_kept(&ids));
    assert_eq!(
        report.bytes,
        (b"A".len() + b"pa".len() + b"pb".len() + "C".len() + b"B-trash".len()) as u64,
        "the bytes of what would move (К9: how much room)"
    );
    assert_eq!(report.entries, 8);
}

// ----- К7: what moves and what stays -----

#[test]
fn k7_the_movable_entries_go_to_the_archive_with_the_time_of_their_deletion() {
    let (vault, ids) = old_trash();
    let outcome = run(&vault.root, &mut NoInterrupt).unwrap();
    assert_eq!(outcome.migrated, 4);
    let archived = vault.archived();
    let get = |path: &str| archived.get(path).map(Vec::as_slice);
    assert_eq!(get("Notes/a.md"), Some(&b"A"[..]));
    assert_eq!(get("Proj/a.md"), Some(&b"pa"[..]));
    assert_eq!(get("Proj/sub/b.md"), Some(&b"pb"[..]));
    assert_eq!(get("Мир/Черновик.md"), Some("C".as_bytes()));
    // К7: "(если там занято — свободное имя рядом)": the file that arrived is not touched.
    assert_eq!(get("Notes/b.md"), Some(&b"B-arrived"[..]));
    assert_eq!(get("Notes/b 2.md"), Some(&b"B-trash"[..]));
    // К7: `archivedAtMs` = the old `deletedAtMs`, one record per file (К8), seen in the list.
    let times: BTreeMap<String, u64> = entries(&vault)
        .into_iter()
        .map(|entry| (entry.original_path, entry.archived_at_ms))
        .collect();
    assert_eq!(times.get("Notes/a.md"), Some(&1000));
    assert_eq!(times.get("Proj/a.md"), Some(&2000));
    assert_eq!(times.get("Proj/sub/b.md"), Some(&2000));
    assert_eq!(times.get("Мир/Черновик.md"), Some(&3000));
    assert_eq!(times.get("Notes/b 2.md"), Some(&5000));
    // The migrated entries are no longer in the old trash.
    let left: Vec<String> = recycle_bin::list(&vault.root)
        .into_iter()
        .map(|e| e.id)
        .collect();
    for moved in [&ids.file, &ids.folder, &ids.cyrillic, &ids.occupied] {
        assert!(!left.contains(moved), "{moved} is still in the trash");
        assert!(
            !vault.exists(&format!(".amby/trash/{moved}")),
            "{moved}: its content is gone from the trash"
        );
    }
    assert_each_payload_exactly_once(&vault, "after the run");
}

#[test]
fn k7_what_cannot_move_stays_where_it_is_with_a_code() {
    let (vault, ids) = old_trash();
    let before = vault.files();
    let outcome = run(&vault.root, &mut NoInterrupt).unwrap();
    assert_eq!(kept_set(&outcome), expected_kept(&ids));
    for kept in [&ids.service, &ids.no_payload, &ids.broken, &ids.unsafe_path] {
        for (path, bytes) in &before {
            if path.starts_with(&format!(".amby/trash/{kept}")) {
                assert_eq!(
                    vault.read(path).as_ref(),
                    Some(bytes),
                    "{path} must stay as it was"
                );
            }
        }
    }
    // The service entry is still listed by the old trash (К5), the archive does not show it.
    assert!(recycle_bin::list(&vault.root)
        .iter()
        .any(|entry| entry.id == ids.service));
    assert!(entries(&vault)
        .iter()
        .all(|entry| !entry.original_path.starts_with(".amby/")));
}

#[test]
fn k7_a_path_that_leads_out_of_the_vault_writes_nothing_outside() {
    let (vault, _) = old_trash();
    run(&vault.root, &mut NoInterrupt).unwrap();
    assert!(!vault.root.parent().unwrap().join("escape.md").exists());
    assert!(!vault.exists(".amby/escape.md"));
    assert!(!vault.exists(".amby/archive/escape.md"));
    assert!(vault
        .archived()
        .values()
        .all(|bytes| bytes.as_slice() != b"E"));
}

#[test]
fn k7_a_migrated_file_can_be_restored_by_the_archive_to_its_old_place() {
    let (vault, _) = old_trash();
    run(&vault.root, &mut NoInterrupt).unwrap();
    let id = entries(&vault)
        .into_iter()
        .find(|entry| entry.original_path == "Notes/a.md")
        .unwrap()
        .id;
    archive::restore(&vault.root, &id).unwrap();
    assert_eq!(vault.read("Notes/a.md").as_deref(), Some(&b"A"[..]));
}

#[test]
fn k7_an_empty_trash_is_a_completed_migration_that_did_nothing() {
    let vault = Vault::new();
    vault.put("Notes/a.md", b"x");
    assert!(!is_completed(&vault.root));
    let outcome = run(&vault.root, &mut NoInterrupt).unwrap();
    assert_eq!(
        outcome,
        Outcome {
            migrated: 0,
            kept: Vec::new()
        }
    );
    assert!(is_completed(&vault.root));
    assert_eq!(vault.read("Notes/a.md").as_deref(), Some(&b"x"[..]));
    assert!(vault.archived().is_empty());
}

// ----- К9: version, marker, outcome, once -----

#[test]
fn k9_the_run_leaves_a_version_a_marker_and_the_outcome() {
    let (vault, _) = old_trash();
    assert!(!is_completed(&vault.root));
    assert_eq!(recorded_outcome(&vault.root), None);
    let outcome = run(&vault.root, &mut NoInterrupt).unwrap();
    assert!(is_completed(&vault.root));
    assert_eq!(recorded_outcome(&vault.root), Some(outcome));
    // К9: "версия перехода в .amby/migrations/".
    let migrations: Vec<(String, Vec<u8>)> = vault
        .files()
        .into_iter()
        .filter(|(path, _)| path.starts_with(".amby/migrations/"))
        .collect();
    assert!(!migrations.is_empty(), "nothing in .amby/migrations/");
    let versioned = migrations.iter().any(|(_, bytes)| {
        serde_json::from_slice::<serde_json::Value>(bytes)
            .ok()
            .is_some_and(|value| {
                value["version"].as_u64() == Some(u64::from(MIGRATION_VERSION))
                    && value.to_string().contains(MIGRATION_KIND)
            })
    });
    assert!(
        versioned,
        "no record with the version and the kind: {migrations:?}"
    );
}

#[test]
fn k9_a_second_run_does_nothing_and_later_trash_entries_stay_in_the_trash() {
    // К9 (completion), К5: what the system trash could not take later is service, not archive.
    let (vault, _) = old_trash();
    run(&vault.root, &mut NoInterrupt).unwrap();
    let late = vault.put("Later/gone.md", b"fell back to the trash");
    recycle_bin::move_exact_to_trash(&vault.root, &late).unwrap();
    let before = vault.files();
    let again = run(&vault.root, &mut NoInterrupt).unwrap();
    assert_eq!(again.migrated, 4, "the recorded outcome of the one run");
    assert_eq!(vault.files(), before, "nothing is touched by a repeat");
    assert!(recycle_bin::list(&vault.root)
        .iter()
        .any(|entry| entry.original_path == "Later/gone.md"));
}

// ----- К9: a crash at every step, then a repeat -----

/// Stops the run at the `limit`-th place (counting from 0) and counts the places it passed.
struct CrashAt<'a> {
    limit: usize,
    seen: usize,
    first_move_checked: bool,
    vault: &'a Vault,
}

impl Interrupt for CrashAt<'_> {
    fn at(&mut self, point: &Point) -> bool {
        if matches!(point, Point::BeforeMove(_)) && !self.first_move_checked {
            self.first_move_checked = true;
            assert!(
                self.vault
                    .files()
                    .keys()
                    .any(|path| path.starts_with(".amby/migrations/")),
                "К9: the journal is written before the first move"
            );
        }
        let stop = self.seen == self.limit;
        self.seen += 1;
        stop
    }
}

#[test]
fn k9_a_run_interrupted_at_any_step_loses_nothing_and_a_repeat_ends_as_an_uninterrupted_run() {
    let (clean, ids) = old_trash();
    // The reference: the same start, no interruption.
    let reference = Vault::new();
    fs::remove_dir_all(&reference.root).unwrap();
    copy_dir(&clean.root, &reference.root);
    let expected_outcome = run(&reference.root, &mut NoInterrupt).unwrap();
    let expected_files = payload_text(&reference);
    let expected_entries: Vec<(String, u64)> = entries(&reference)
        .into_iter()
        .map(|entry| (entry.original_path, entry.archived_at_ms))
        .collect();
    let expected_metas = reference.metas();

    let mut points_seen = 0;
    for limit in 0..400 {
        let vault = Vault::new();
        fs::remove_dir_all(&vault.root).unwrap();
        copy_dir(&clean.root, &vault.root);
        let mut crash = CrashAt {
            limit,
            seen: 0,
            first_move_checked: false,
            vault: &vault,
        };
        match run(&vault.root, &mut crash) {
            Err(RunError::Interrupted) => {}
            Ok(_) => {
                points_seen = crash.seen;
                break;
            }
            Err(other) => panic!("limit {limit}: {other:?}"),
        }
        assert_each_payload_exactly_once(&vault, &format!("crash at place {limit}"));
        // The repeat resumes (or, when the journal never got written, starts again).
        let resumed = run(&vault.root, &mut NoInterrupt)
            .unwrap_or_else(|error| panic!("limit {limit}: the repeat failed: {error:?}"));
        assert_eq!(resumed.migrated, expected_outcome.migrated, "limit {limit}");
        assert_eq!(kept_set(&resumed), expected_kept(&ids), "limit {limit}");
        assert!(is_completed(&vault.root), "limit {limit}");
        // The ids of the records differ between runs, so the files are compared without them.
        let strip = |mut map: BTreeMap<String, Vec<u8>>| {
            map.retain(|path, _| !path.starts_with(".amby/archive/.meta/"));
            map
        };
        assert_eq!(
            strip(payload_text(&vault)),
            strip(expected_files.clone()),
            "limit {limit}: the files differ from an uninterrupted run"
        );
        let resumed_entries: Vec<(String, u64)> = entries(&vault)
            .into_iter()
            .map(|entry| (entry.original_path, entry.archived_at_ms))
            .collect();
        assert_eq!(resumed_entries, expected_entries, "limit {limit}");
        assert_eq!(
            vault.metas(),
            expected_metas,
            "limit {limit}: no record twice, none lost"
        );
        assert_each_payload_exactly_once(&vault, &format!("after the repeat of {limit}"));
    }
    assert!(
        points_seen >= 4,
        "the run must offer a place to stop for every entry: saw {points_seen}"
    );
}

#[test]
fn k9_a_crash_between_the_move_and_its_record_is_mended_by_the_repeat() {
    // The sharpest place: the file is in the archive, its record is not written.
    let (vault, _) = old_trash();
    struct AtFirstAfterMove(bool);
    impl Interrupt for AtFirstAfterMove {
        fn at(&mut self, point: &Point) -> bool {
            if matches!(point, Point::AfterMove(_)) && !self.0 {
                self.0 = true;
                return true;
            }
            false
        }
    }
    assert_eq!(
        run(&vault.root, &mut AtFirstAfterMove(false)),
        Err(RunError::Interrupted)
    );
    run(&vault.root, &mut NoInterrupt).unwrap();
    let times: BTreeMap<String, u64> = entries(&vault)
        .into_iter()
        .map(|entry| (entry.original_path, entry.archived_at_ms))
        .collect();
    assert_eq!(
        times.get("Notes/a.md"),
        Some(&1000),
        "the time is the old deletion time, not now"
    );
    assert_each_payload_exactly_once(&vault, "after the mended run");
}

// ----- К9: the rollback -----

#[test]
fn k9_a_rollback_puts_every_entry_back_as_it_was() {
    let (vault, _) = old_trash();
    let before = payload_text(&vault);
    let listed_before: Vec<(String, String, u64)> = recycle_bin::list(&vault.root)
        .into_iter()
        .map(|e| (e.id, e.original_path, e.deleted_at_ms))
        .collect();
    run(&vault.root, &mut NoInterrupt).unwrap();
    let report = rollback(&vault.root).unwrap();
    assert_eq!(report.reverted, 4);
    assert!(report.skipped.is_empty());
    assert_eq!(
        payload_text(&vault),
        before,
        "the vault is as before the migration"
    );
    let listed_after: Vec<(String, String, u64)> = recycle_bin::list(&vault.root)
        .into_iter()
        .map(|e| (e.id, e.original_path, e.deleted_at_ms))
        .collect();
    assert_eq!(listed_after, listed_before);
    assert!(!is_completed(&vault.root));
    assert!(
        vault.metas().is_empty(),
        "the records of the moved files are gone with them"
    );
    assert_each_payload_exactly_once(&vault, "after the rollback");
}

#[test]
fn k9_a_rollback_of_an_interrupted_run_also_restores_the_start() {
    let (vault, _) = old_trash();
    let before = payload_text(&vault);
    struct AtSecondAfterMove(usize);
    impl Interrupt for AtSecondAfterMove {
        fn at(&mut self, point: &Point) -> bool {
            if matches!(point, Point::AfterMove(_)) {
                self.0 += 1;
                return self.0 == 2;
            }
            false
        }
    }
    assert_eq!(
        run(&vault.root, &mut AtSecondAfterMove(0)),
        Err(RunError::Interrupted)
    );
    rollback(&vault.root).unwrap();
    assert_eq!(payload_text(&vault), before);
    assert_each_payload_exactly_once(&vault, "after the rollback of a half run");
}

#[test]
fn k9_a_rollback_leaves_alone_a_file_the_person_has_restored_since() {
    let (vault, _) = old_trash();
    run(&vault.root, &mut NoInterrupt).unwrap();
    let id = entries(&vault)
        .into_iter()
        .find(|entry| entry.original_path == "Notes/a.md")
        .unwrap()
        .id;
    archive::restore(&vault.root, &id).unwrap();
    let report = rollback(&vault.root).unwrap();
    assert_eq!(report.reverted, 3);
    assert_eq!(report.skipped.len(), 1);
    assert_eq!(
        vault.read("Notes/a.md").as_deref(),
        Some(&b"A"[..]),
        "the restored file is where the person put it"
    );
    assert_each_payload_exactly_once(&vault, "after the rollback");
}

// ----- К11 (д), (ж) -----

#[test]
fn k11d_the_old_descriptions_of_the_migrated_entries_are_kept_under_the_migrations_folder() {
    // К11 (д): "лежат в `.amby/migrations/<версия>/` вместе с журналом — нужны откату".
    let (vault, ids) = old_trash();
    run(&vault.root, &mut NoInterrupt).unwrap();
    let files = vault.files();
    for moved in [&ids.file, &ids.folder, &ids.cyrillic, &ids.occupied] {
        let kept = files.iter().any(|(path, bytes)| {
            path.starts_with(".amby/migrations/")
                && serde_json::from_slice::<serde_json::Value>(bytes)
                    .ok()
                    .is_some_and(|value| value["id"].as_str() == Some(moved.as_str()))
        });
        assert!(
            kept,
            "the description of {moved} is not kept under .amby/migrations/"
        );
    }
}

#[test]
fn k11g_opening_a_vault_runs_the_migration_before_anything_else() {
    // К11 (ж): at the opening of the vault, on every vault.
    let (vault, _) = old_trash();
    let context = crate::vault_context::VaultContext::new();
    context
        .activate(vault.root.to_str().unwrap(), |_| Ok(()), |_, _| ())
        .unwrap();
    assert!(is_completed(&vault.root));
    assert_eq!(
        vault.read(".amby/archive/Notes/a.md").as_deref(),
        Some(&b"A"[..])
    );
    assert_each_payload_exactly_once(&vault, "after the opening");
}
