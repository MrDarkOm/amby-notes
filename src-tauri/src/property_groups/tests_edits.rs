//! Edits that touch the header and the group: the order of the two writes, a crash at every
//! write, the journal and who finishes it (docs/sync-plan.md, appendix З: З9, З28, З29). Red until
//! written.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::testkit::*;
use super::*;

const NAME: &str = "Заказчик";

fn with_status() -> (Fx, String) {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    create_property(&fx.conn, &fx.vault, &note, design(NAME), "Готово").unwrap();
    (fx, note)
}

fn header_has(fx: &Fx, key: &str) -> bool {
    fx.read("N.md")
        .lines()
        .any(|line| line.starts_with(&format!("{key}:")))
}

/// The order the panel shows (З47): the header's, or `order`.
fn panel_names(fx: &Fx, note: &str) -> Vec<String> {
    panel(&fx.conn, &fx.vault, note)
        .unwrap()
        .active
        .iter()
        .map(|p| p.name.clone())
        .collect()
}

/// The names that have differences in the line: a set, ascending (the order of the line means nothing).
fn names(fx: &Fx, note: &str) -> Vec<String> {
    fx.prop_names(note)
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
    let (fx, note) = with_status();
    let before = fx.snapshot();
    set_appearance(&fx.conn, &fx.vault, &note, NAME, "🔥", "x").unwrap();
    assert_eq!(
        changed_paths(&before, &fx.snapshot()),
        vec![fx.group_rel(&note)]
    );
    let before = fx.snapshot();
    set_value(&fx.conn, &fx.vault, &note, NAME, "Идея").unwrap();
    assert_eq!(
        changed_paths(&before, &fx.snapshot()),
        vec!["N.md".to_string()]
    );
    let before = fx.snapshot();
    reorder(&fx.conn, &fx.vault, &note, &[NAME.to_string()]).unwrap();
    assert!(
        changed_paths(&before, &fx.snapshot()).is_empty(),
        "same order: nothing"
    );
}

#[test]
fn a_finished_rename_renames_the_key_and_the_design_and_leaves_no_trace() {
    // З9, З28
    let (fx, note) = with_status();
    rename_property(&fx.conn, &fx.vault, &note, NAME, "Клиент").unwrap();
    assert_eq!(names(&fx, &note), vec!["Клиент"]);
    assert!(fx
        .props(&note)
        .values()
        .all(|d| d.get("previousName").is_none()));
    assert!(header_has(&fx, "Клиент") && !header_has(&fx, "Заказчик"));
    assert!(fx.read("N.md").contains("Клиент: Готово"));
    assert!(ops_files(&fx).is_empty(), "the journal is removed");
}

#[test]
fn creation_puts_the_key_into_the_header_and_the_design_into_the_group() {
    let (fx, note) = with_status();
    create_property(&fx.conn, &fx.vault, &note, design("Автор"), "я").unwrap();
    assert!(fx.read("N.md").contains("Автор: я"));
    assert_eq!(
        panel_names(&fx, &note),
        vec!["Заказчик", "Автор"],
        "appended to the order of the header"
    );
    assert!(ops_files(&fx).is_empty());
}

#[test]
fn a_name_is_unique_in_a_note_apart_from_the_ascii_case() {
    // З2: «Status» and «STATUS» are one name; «Заказчик» and «статус» are two
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    create_property(&fx.conn, &fx.vault, &note, design("Status"), "x").unwrap();
    let before = fx.snapshot();
    assert!(create_property(&fx.conn, &fx.vault, &note, design("STATUS"), "").is_err());
    assert_eq!(fx.snapshot(), before);
    create_property(&fx.conn, &fx.vault, &note, design("Заказчик"), "").unwrap();
    create_property(&fx.conn, &fx.vault, &note, design("статус"), "").unwrap();
    assert_eq!(
        panel_names(&fx, &note),
        vec!["Status", "Заказчик", "статус"]
    );
}

// ----- З28: refusal before the first write -----

#[test]
fn a_rename_that_cannot_be_done_without_loss_is_refused_before_anything_is_written() {
    // З28 (а): ambiguous key, no journal, no group write
    let (fx, note) = with_status();
    fx.note(&note, "N.md", "STATUS: a\nstatus: b\n");
    let before = fx.snapshot();
    assert!(rename_property(&fx.conn, &fx.vault, &note, NAME, "Другое").is_err());
    assert_eq!(fx.snapshot(), before);
    assert!(ops_files(&fx).is_empty());
}

#[test]
fn the_journal_is_a_local_file_per_operation_and_lives_only_while_the_operation_does() {
    // З28 (б): `.amby/property-ops/<ULID>.json`
    let (fx, note) = with_status();
    let mut seen = false;
    for (n, after) in every_crash() {
        let (fx, note) = with_status();
        let result = with_failing_write(n, after, || {
            rename_property(&fx.conn, &fx.vault, &note, NAME, "Клиент")
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
    let _ = (fx, note);
}

// ----- З9, З28: a crash at every write -----

#[test]
fn a_crash_at_any_write_of_a_rename_loses_nothing_never_makes_a_sleeping_design_and_is_finished_later(
) {
    // З9, З28, З29
    for (n, after) in every_crash() {
        let (fx, note) = with_status();
        let _ = with_failing_write(n, after, || {
            rename_property(&fx.conn, &fx.vault, &note, NAME, "Клиент")
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
        assert!(
            ["Заказчик", "Клиент"].contains(&shown.active[0].name.as_str()),
            "{label}"
        );
        assert_eq!(
            shown.active[0].value, "Готово",
            "{label}: the value is lost"
        );
        // the next start finishes it
        recover_operations(&fx.conn, &fx.vault).unwrap();
        let old = header_has(&fx, "Заказчик");
        let new = header_has(&fx, "Клиент");
        assert!(
            old != new,
            "{label}: exactly one key in the header (old {old}, new {new})"
        );
        assert_eq!(
            names(&fx, &note),
            vec![if new {
                "Клиент"
            } else {
                "Заказчик"
            }],
            "{label}"
        );
        assert!(
            fx.props(&note)
                .values()
                .all(|d| d.get("previousName").is_none()),
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
        let (fx, note) = with_status();
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
        let (fx, note) = with_status();
        let _ = with_failing_write(n, after, || {
            delete_property(&fx.conn, &fx.vault, &note, NAME)
        });
        let label = format!("crash at write {n} (after publish: {after})");
        let key = header_has(&fx, "Заказчик");
        let design_kept = !fx.prop_names(&note).is_empty();
        assert!(
            !(key && !design_kept),
            "{label}: the key stayed, the design is gone"
        );
        recover_operations(&fx.conn, &fx.vault).unwrap();
        let key = header_has(&fx, "Заказчик");
        let design_kept = !fx.prop_names(&note).is_empty();
        assert!(!(key && !design_kept), "{label}: after recovery");
        assert!(ops_files(&fx).is_empty(), "{label}");
    }
}

#[test]
fn a_crash_at_any_write_of_a_type_change_never_loses_the_value() {
    // З26, З28: the group first, then the value
    for (n, after) in every_crash() {
        let (fx, note) = with_status();
        create_property(&fx.conn, &fx.vault, &note, design("Счёт"), "5").unwrap();
        let _ = with_failing_write(n, after, || {
            change_type(&fx.conn, &fx.vault, &note, NAME, "number")
        });
        let label = format!("crash at write {n} (after publish: {after})");
        recover_operations(&fx.conn, &fx.vault).unwrap();
        let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
        let counted = shown
            .active
            .iter()
            .find(|p| p.name == "Счёт")
            .expect(&label);
        assert_eq!(counted.value, "5", "{label}");
        assert!(shown.dormant.is_empty(), "{label}");
    }
}

// ----- З29: who finishes -----

/// A fixture where a rename stopped after the first step: the group holds `previousName`, the
/// header still has the old key.
fn stopped_after_the_group() -> (Fx, String) {
    for (n, after) in every_crash() {
        let (fx, note) = with_status();
        let _ = with_failing_write(n, after, || {
            rename_property(&fx.conn, &fx.vault, &note, NAME, "Клиент")
        });
        let has_previous = fx
            .props(&note)
            .values()
            .any(|d| d.get("previousName").is_some());
        if has_previous && header_has(&fx, "Заказчик") && !header_has(&fx, "Клиент") {
            return (fx, note);
        }
    }
    panic!("no crash left the rename between its first and second step");
}

#[test]
fn the_group_between_the_steps_names_both_names() {
    // З9: `name` is the new one, `previousName` the old one
    let (fx, note) = stopped_after_the_group();
    let props = fx.props(&note);
    assert_eq!(props["Клиент"]["previousName"], "Заказчик");
    assert!(!props.contains_key("Заказчик"));
}

#[test]
fn recovery_rolls_back_when_only_the_old_key_is_in_the_header() {
    // З29: step 2 was not done: `name := previousName`
    let (fx, note) = stopped_after_the_group();
    let report = recover_operations(&fx.conn, &fx.vault).unwrap();
    assert_eq!(report.rolled_back, vec![note.clone()]);
    assert_eq!(names(&fx, &note), vec!["Заказчик"]);
    assert!(fx
        .props(&note)
        .values()
        .all(|d| d.get("previousName").is_none()));
    assert!(ops_files(&fx).is_empty());
}

#[test]
fn recovery_completes_when_the_new_key_is_in_the_header() {
    // З29: the key `name` is there: remove `previousName`
    let (fx, note) = stopped_after_the_group();
    fx.note(&note, "N.md", "Клиент: Готово\n");
    let report = recover_operations(&fx.conn, &fx.vault).unwrap();
    assert_eq!(report.completed, vec![note.clone()]);
    assert_eq!(names(&fx, &note), vec!["Клиент"]);
    assert!(fx
        .props(&note)
        .values()
        .all(|d| d.get("previousName").is_none()));
}

#[test]
fn recovery_leaves_a_header_that_changed_in_another_way_and_shows_it_in_the_inspection() {
    // З29, З10
    let (fx, note) = stopped_after_the_group();
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
    let (fx, note) = stopped_after_the_group();
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
        shown.active[0].key, "Заказчик",
        "read by `previousName` because `name` is not in the header"
    );
    assert_eq!(shown.active[0].value, "Готово");
}

#[test]
fn with_both_keys_in_the_header_the_name_key_is_read() {
    // З29: «Чтение по previousName — только если ключа name в шапке нет»
    let (fx, note) = stopped_after_the_group();
    fx.note(&note, "N.md", "Заказчик: старое\nКлиент: новое\n");
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(shown.active[0].key, "Клиент");
    assert_eq!(shown.active[0].value, "новое");
}

#[test]
fn opening_a_vault_never_walks_all_the_groups() {
    // З29: the recovery reads its own journal; with none it reads no group
    let (fx, note) = with_status();
    // a broken group of another note must not matter to a recovery that has no journal
    let mut broken = fx.group_rel(&id(900));
    if broken == fx.group_rel(&note) {
        broken = fx.group_rel(&id(901));
    }
    fx.write(&broken, "not-json");
    assert!(recover_operations(&fx.conn, &fx.vault).is_ok());
}

// ----- З55: a property with no record -----

#[test]
fn renaming_a_property_with_no_differences_changes_the_key_and_leaves_no_line_behind() {
    // З55: not from the template and no record: only the key of the header changes
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "Метка: x\n");
    let before = fx.snapshot();
    rename_property(&fx.conn, &fx.vault, &note, "Метка", "Тег2").unwrap();
    assert_eq!(
        changed_paths(&before, &fx.snapshot()),
        vec!["N.md".to_string()]
    );
    assert!(fx.read("N.md").contains("Тег2: x") && !fx.read("N.md").contains("Метка"));
    assert!(fx.line(&note).is_none() && ops_files(&fx).is_empty());
}

#[test]
fn a_crash_at_any_write_of_such_a_rename_never_shows_a_sleeping_property_and_leaves_no_line() {
    // З55, З29: the line exists for the time of the operation only
    for (n, after) in every_crash() {
        let fx = fx();
        let note = id(1);
        fx.note(&note, "N.md", "Метка: x\n");
        let _ = with_failing_write(n, after, || {
            rename_property(&fx.conn, &fx.vault, &note, "Метка", "Тег2")
        });
        let label = format!("crash at write {n} (after publish: {after})");
        let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
        assert!(
            shown.dormant.is_empty() && shown.rename_hint.is_none(),
            "{label}"
        );
        assert_eq!(shown.active.len(), 1, "{label}");
        assert_eq!(shown.active[0].value, "x", "{label}");
        recover_operations(&fx.conn, &fx.vault).unwrap();
        assert!(fx.line(&note).is_none(), "{label}: a line stayed");
        assert!(ops_files(&fx).is_empty(), "{label}");
        let (old, new) = (header_has(&fx, "Метка"), header_has(&fx, "Тег2"));
        assert!(old != new, "{label}: exactly one key");
    }
}

#[test]
fn renaming_a_basic_property_moves_its_differences_and_keeps_the_template_out_of_the_line() {
    // З55: «Статус» is in the template; after the rename it is an ordinary property with the look
    // it had
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "Статус: Готово\n");
    rename_property(&fx.conn, &fx.vault, &note, "Статус", "Стадия").unwrap();
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(shown.active[0].name, "Стадия");
    let template = crate::property_template::lookup("Статус").unwrap();
    assert_eq!(shown.active[0].icon, template.icon, "the look it had");
    assert_eq!(shown.active[0].property_type, template.property_type);
    assert!(fx.read("N.md").contains("Стадия: Готово"));
    assert!(fx
        .props(&note)
        .values()
        .all(|d| d.get("previousName").is_none()));
}

// ----- З60: the commands of the new format work by name, one after another -----

#[test]
fn an_icon_then_a_rename_then_an_icon_again_ends_with_the_new_name_and_the_last_icon() {
    // З60: the sequence that failed by hand — every command by the name the panel shows now
    let (fx, note) = with_status();
    set_appearance(&fx.conn, &fx.vault, &note, NAME, "🔥", "").unwrap();
    rename_property(&fx.conn, &fx.vault, &note, NAME, "Клиент").unwrap();
    set_appearance(&fx.conn, &fx.vault, &note, "Клиент", "⭐", "").unwrap();
    assert_eq!(fx.prop_names(&note), vec!["Клиент"], "the old name is gone");
    assert_eq!(fx.props(&note)["Клиент"]["icon"], "⭐");
    assert!(fx.read("N.md").contains("Клиент: Готово") && !fx.read("N.md").contains("Заказчик"));
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(
        (shown.active[0].name.as_str(), shown.active[0].icon.as_str()),
        ("Клиент", "⭐")
    );
    assert!(fx
        .props(&note)
        .values()
        .all(|d| d.get("previousName").is_none()));
    assert!(ops_files(&fx).is_empty());
}

#[test]
fn many_quick_edits_of_one_property_lose_none() {
    // З60: icon, type, value, settings, in turn and many times; the last of each is in the result
    let (fx, note) = with_status();
    for n in 0..20 {
        set_appearance(
            &fx.conn,
            &fx.vault,
            &note,
            NAME,
            &format!("i{n}"),
            &format!("s{n}"),
        )
        .unwrap();
        set_value(&fx.conn, &fx.vault, &note, NAME, &format!("v{n}")).unwrap();
    }
    change_type(&fx.conn, &fx.vault, &note, NAME, "select").unwrap();
    set_appearance(&fx.conn, &fx.vault, &note, NAME, "последняя", "А,Б").unwrap();
    set_value(&fx.conn, &fx.vault, &note, NAME, "А").unwrap();
    let diff = fx.props(&note)[NAME].clone();
    assert_eq!(diff["icon"], "последняя");
    assert_eq!(diff["settings"], "А,Б");
    assert_eq!(diff["propertyType"], "select");
    assert!(
        fx.read("N.md").contains("Заказчик: А\n"),
        "{}",
        fx.read("N.md")
    );
    assert_eq!(fx.lines(&note).len(), 1, "still one line for the note");
}
