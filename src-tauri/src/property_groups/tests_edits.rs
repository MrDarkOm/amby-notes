//! Edits that touch the header and the group: the order of the two writes, a crash at every
//! write, the journal and who finishes it (docs/sync-plan.md, appendix З: З9, З28, З29). Red until
//! written.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::testkit::*;
use super::*;

fn with_status() -> (Fx, String, Design) {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    let made = create_property(&fx.conn, &fx.vault, &note, design("Статус"), "Готово").unwrap();
    (fx, note, made)
}

fn header_has(fx: &Fx, key: &str) -> bool {
    fx.read("N.md")
        .lines()
        .any(|line| line.starts_with(&format!("{key}:")))
}

fn names(fx: &Fx, note: &str) -> Vec<String> {
    fx.designs(note)
        .iter()
        .map(|d| d["name"].as_str().unwrap().to_string())
        .collect()
}

fn ops_files(fx: &Fx) -> Vec<String> {
    fx.files_under(".amby/property-ops/")
}

/// Every position of a crash: the n-th write fails before the rename or just after it.
fn every_crash() -> Vec<(u64, bool)> {
    (1..=8).flat_map(|n| [(n, false), (n, true)]).collect()
}

// ----- ordinary edits -----

#[test]
fn only_the_design_is_written_when_only_the_design_changes_and_only_the_note_when_only_the_value() {
    // З9
    let (fx, note, made) = with_status();
    let before = fx.snapshot();
    set_appearance(&fx.conn, &fx.vault, &note, &made.id, "🔥", "x").unwrap();
    assert_eq!(
        changed_paths(&before, &fx.snapshot()),
        vec![fx.group_rel(&note)]
    );
    let before = fx.snapshot();
    set_value(&fx.conn, &fx.vault, &note, &made.id, "Идея").unwrap();
    assert_eq!(
        changed_paths(&before, &fx.snapshot()),
        vec!["N.md".to_string()]
    );
    let before = fx.snapshot();
    reorder(&fx.conn, &fx.vault, &note, std::slice::from_ref(&made.id)).unwrap();
    assert!(
        changed_paths(&before, &fx.snapshot()).is_empty(),
        "same order: nothing"
    );
}

#[test]
fn a_finished_rename_renames_the_key_and_the_design_and_leaves_no_trace() {
    // З9, З28
    let (fx, note, made) = with_status();
    rename_property(&fx.conn, &fx.vault, &note, &made.id, "Состояние").unwrap();
    assert_eq!(names(&fx, &note), vec!["Состояние"]);
    assert!(fx.designs(&note)[0].get("previousName").is_none());
    assert!(header_has(&fx, "Состояние") && !header_has(&fx, "Статус"));
    assert!(fx.read("N.md").contains("Состояние: Готово"));
    assert_eq!(fx.designs(&note)[0]["id"], made.id.as_str(), "the id stays");
    assert!(ops_files(&fx).is_empty(), "the journal is removed");
}

#[test]
fn creation_puts_the_key_into_the_header_and_the_design_into_the_group() {
    let (fx, note, _) = with_status();
    let made = create_property(&fx.conn, &fx.vault, &note, design("Автор"), "я").unwrap();
    assert!(fx.read("N.md").contains("Автор: я"));
    assert_eq!(
        names(&fx, &note),
        vec!["Статус", "Автор"],
        "appended to the order"
    );
    assert!(!made.id.is_empty());
    assert!(ops_files(&fx).is_empty());
}

#[test]
fn a_name_is_unique_in_a_note_apart_from_the_ascii_case() {
    // З2: «Status» and «STATUS» are one name; «Статус» and «статус» are two
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    create_property(&fx.conn, &fx.vault, &note, design("Status"), "x").unwrap();
    let before = fx.snapshot();
    assert!(create_property(&fx.conn, &fx.vault, &note, design("STATUS"), "").is_err());
    assert_eq!(fx.snapshot(), before);
    create_property(&fx.conn, &fx.vault, &note, design("Статус"), "").unwrap();
    create_property(&fx.conn, &fx.vault, &note, design("статус"), "").unwrap();
    assert_eq!(names(&fx, &note), vec!["Status", "Статус", "статус"]);
}

// ----- З28: refusal before the first write -----

#[test]
fn a_rename_that_cannot_be_done_without_loss_is_refused_before_anything_is_written() {
    // З28 (а): ambiguous key, no journal, no group write
    let (fx, note, made) = with_status();
    fx.note(&note, "N.md", "STATUS: a\nstatus: b\n");
    let before = fx.snapshot();
    assert!(rename_property(&fx.conn, &fx.vault, &note, &made.id, "Другое").is_err());
    assert_eq!(fx.snapshot(), before);
    assert!(ops_files(&fx).is_empty());
}

#[test]
fn the_journal_is_a_local_file_per_operation_and_lives_only_while_the_operation_does() {
    // З28 (б): `.amby/property-ops/<ULID>.json`
    let (fx, note, made) = with_status();
    let mut seen = false;
    for (n, after) in every_crash() {
        let (fx, note, made) = with_status();
        let result = with_failing_write(n, after, || {
            rename_property(&fx.conn, &fx.vault, &note, &made.id, "Состояние")
        });
        if result.is_err() {
            let files = ops_files(&fx);
            assert!(files.len() <= 1, "one journal at most: {files:?}");
            if let Some(file) = files.first() {
                seen = true;
                assert!(file.ends_with(".json") && file.starts_with(".amby/property-ops/"));
            }
        }
    }
    assert!(seen, "a crash in the middle of a rename leaves its journal");
    let _ = (fx, note, made);
}

// ----- З9, З28: a crash at every write -----

#[test]
fn a_crash_at_any_write_of_a_rename_loses_nothing_never_makes_a_sleeping_design_and_is_finished_later(
) {
    // З9, З28, З29
    for (n, after) in every_crash() {
        let (fx, note, made) = with_status();
        let _ = with_failing_write(n, after, || {
            rename_property(&fx.conn, &fx.vault, &note, &made.id, "Состояние")
        });
        let label = format!("crash at write {n} (after publish: {after})");
        // the state at the moment of the crash
        let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
        assert!(
            shown.dormant.is_empty(),
            "{label}: a sleeping design appeared"
        );
        assert!(shown.rename_hint.is_none(), "{label}: a hint appeared");
        assert_eq!(shown.active.len(), 1, "{label}");
        assert_eq!(shown.active[0].design.id, made.id, "{label}");
        assert_eq!(
            shown.active[0].value, "Готово",
            "{label}: the value is lost"
        );
        // the next start finishes it
        recover_operations(&fx.conn, &fx.vault).unwrap();
        let old = header_has(&fx, "Статус");
        let new = header_has(&fx, "Состояние");
        assert!(
            old != new,
            "{label}: exactly one key in the header (old {old}, new {new})"
        );
        assert_eq!(
            names(&fx, &note),
            vec![if new {
                "Состояние"
            } else {
                "Статус"
            }],
            "{label}"
        );
        assert!(
            fx.designs(&note)[0].get("previousName").is_none(),
            "{label}"
        );
        assert!(ops_files(&fx).is_empty(), "{label}: journal left");
        let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
        assert!(
            shown.dormant.is_empty() && shown.active[0].value == "Готово",
            "{label}"
        );
        // a second recovery changes nothing
        let snap = fx.snapshot();
        recover_operations(&fx.conn, &fx.vault).unwrap();
        assert_eq!(fx.snapshot(), snap, "{label}: not idempotent");
    }
}

#[test]
fn a_crash_at_any_write_of_a_creation_leaves_an_ordinary_key_and_never_a_sleeping_design() {
    // З28: the key first, then the record
    for (n, after) in every_crash() {
        let (fx, note, _) = with_status();
        let _ = with_failing_write(n, after, || {
            create_property(&fx.conn, &fx.vault, &note, design("Автор"), "я")
        });
        let label = format!("crash at write {n} (after publish: {after})");
        recover_operations(&fx.conn, &fx.vault).unwrap();
        let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
        assert!(shown.dormant.is_empty(), "{label}");
        if names(&fx, &note).contains(&"Автор".to_string()) {
            assert!(header_has(&fx, "Автор"), "{label}: a design without a key");
        }
        assert!(ops_files(&fx).is_empty(), "{label}");
    }
}

#[test]
fn a_crash_at_any_write_of_a_deletion_leaves_the_design_visible_never_a_key_without_a_design() {
    // З28: the key leaves the header first, then the record; a crash shows the design grey
    for (n, after) in every_crash() {
        let (fx, note, made) = with_status();
        let _ = with_failing_write(n, after, || {
            delete_property(&fx.conn, &fx.vault, &note, &made.id)
        });
        let label = format!("crash at write {n} (after publish: {after})");
        let key = header_has(&fx, "Статус");
        let design_kept = !fx.designs(&note).is_empty();
        assert!(
            !(key && !design_kept),
            "{label}: the key stayed, the design is gone"
        );
        recover_operations(&fx.conn, &fx.vault).unwrap();
        let key = header_has(&fx, "Статус");
        let design_kept = !fx.designs(&note).is_empty();
        assert!(!(key && !design_kept), "{label}: after recovery");
        assert!(ops_files(&fx).is_empty(), "{label}");
    }
}

#[test]
fn a_crash_at_any_write_of_a_type_change_never_loses_the_value() {
    // З26, З28: the group first, then the value
    for (n, after) in every_crash() {
        let (fx, note, _) = with_status();
        let made = create_property(&fx.conn, &fx.vault, &note, design("Счёт"), "5").unwrap();
        let _ = with_failing_write(n, after, || {
            change_type(&fx.conn, &fx.vault, &note, &made.id, "number")
        });
        let label = format!("crash at write {n} (after publish: {after})");
        recover_operations(&fx.conn, &fx.vault).unwrap();
        let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
        let counted = shown
            .active
            .iter()
            .find(|p| p.design.id == made.id)
            .expect(&label);
        assert_eq!(counted.value, "5", "{label}");
        assert!(shown.dormant.is_empty(), "{label}");
    }
}

// ----- З29: who finishes -----

/// A fixture where a rename stopped after the first step: the group holds `previousName`, the
/// header still has the old key.
fn stopped_after_the_group() -> (Fx, String, Design) {
    for (n, after) in every_crash() {
        let (fx, note, made) = with_status();
        let _ = with_failing_write(n, after, || {
            rename_property(&fx.conn, &fx.vault, &note, &made.id, "Состояние")
        });
        let has_previous = fx
            .designs(&note)
            .first()
            .is_some_and(|d| d.get("previousName").is_some());
        if has_previous && header_has(&fx, "Статус") && !header_has(&fx, "Состояние")
        {
            return (fx, note, made);
        }
    }
    panic!("no crash left the rename between its first and second step");
}

#[test]
fn the_group_between_the_steps_names_both_names() {
    // З9: `name` is the new one, `previousName` the old one
    let (fx, note, _) = stopped_after_the_group();
    let design = &fx.designs(&note)[0];
    assert_eq!(design["name"], "Состояние");
    assert_eq!(design["previousName"], "Статус");
}

#[test]
fn recovery_rolls_back_when_only_the_old_key_is_in_the_header() {
    // З29: step 2 was not done: `name := previousName`
    let (fx, note, _) = stopped_after_the_group();
    let report = recover_operations(&fx.conn, &fx.vault).unwrap();
    assert_eq!(report.rolled_back, vec![note.clone()]);
    assert_eq!(names(&fx, &note), vec!["Статус"]);
    assert!(fx.designs(&note)[0].get("previousName").is_none());
    assert!(ops_files(&fx).is_empty());
}

#[test]
fn recovery_completes_when_the_new_key_is_in_the_header() {
    // З29: the key `name` is there: remove `previousName`
    let (fx, note, _) = stopped_after_the_group();
    fx.note(&note, "N.md", "Состояние: Готово\n");
    let report = recover_operations(&fx.conn, &fx.vault).unwrap();
    assert_eq!(report.completed, vec![note.clone()]);
    assert_eq!(names(&fx, &note), vec!["Состояние"]);
    assert!(fx.designs(&note)[0].get("previousName").is_none());
}

#[test]
fn recovery_leaves_a_header_that_changed_in_another_way_and_shows_it_in_the_inspection() {
    // З29, З10
    let (fx, note, _) = stopped_after_the_group();
    fx.note(&note, "N.md", "Совсем другое: x\n");
    let before = fx.snapshot();
    let report = recover_operations(&fx.conn, &fx.vault).unwrap();
    assert_eq!(report.left_for_inspection, vec![note.clone()]);
    assert_eq!(
        changed_paths(&before, &fx.snapshot())
            .iter()
            .filter(|p| p.starts_with(".amby/properties/"))
            .count(),
        0
    );
    assert!(inspect(&fx.conn, &fx.vault)
        .unwrap()
        .unfinished_operations
        .contains(&note));
}

#[test]
fn another_device_with_a_previous_name_in_a_synchronised_group_only_reads() {
    // З29: the header may not have arrived yet
    let (fx, note, _) = stopped_after_the_group();
    let second = fx.copy_to_second_device(&[".amby/property-ops/"]);
    let before = second.snapshot();
    let report = recover_operations(&second.conn, &second.vault).unwrap();
    assert_eq!(report, RecoverReport::default());
    assert_eq!(
        second.snapshot(),
        before,
        "nothing is finished by a device that did not begin"
    );
    let shown = panel(&second.conn, &second.vault, &note).unwrap();
    assert!(shown.dormant.is_empty());
    assert_eq!(
        shown.active[0].key, "Статус",
        "read by `previousName` because `name` is not in the header"
    );
    assert_eq!(shown.active[0].value, "Готово");
}

#[test]
fn with_both_keys_in_the_header_the_name_key_is_read() {
    // З29: «Чтение по previousName — только если ключа name в шапке нет»
    let (fx, note, _) = stopped_after_the_group();
    fx.note(&note, "N.md", "Статус: старое\nСостояние: новое\n");
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(shown.active[0].key, "Состояние");
    assert_eq!(shown.active[0].value, "новое");
}

#[test]
fn opening_a_vault_never_walks_all_the_groups() {
    // З29: the recovery reads its own journal; with none it reads no group
    let (fx, note, _) = with_status();
    // a broken group of another note must not matter to a recovery that has no journal
    let mut broken = fx.group_rel(&id(900));
    if broken == fx.group_rel(&note) {
        broken = fx.group_rel(&id(901));
    }
    fx.write(&broken, "not-json");
    assert!(recover_operations(&fx.conn, &fx.vault).is_ok());
}
