//! Edits of an old version of Amby on another computer, carried over after the migration
//! (docs/sync-plan.md, appendix З: З22, З36, З37). Red until written.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::{json, Value};

use super::legacy::*;
use super::migration::{run, Context, Decisions};
use super::testkit::*;
use super::*;

fn old_prop(id: &str, name: &str, icon: &str, value: &str) -> Value {
    json!({"id": id, "name": name, "icon": icon, "propertyType": "text", "value": value, "settings": ""})
}

fn old_full(id: &str, name: &str, ty: &str, value: &str, settings: &str) -> Value {
    json!({"id": id, "name": name, "icon": "📌", "propertyType": ty, "value": value, "settings": settings})
}

fn write_old(fx: &Fx, notes: &[(&str, Vec<Value>)]) {
    let map: serde_json::Map<String, Value> = notes
        .iter()
        .map(|(id, props)| (id.to_string(), json!(props)))
        .collect();
    fx.write(
        ".amby/properties.json",
        &(serde_json::to_string_pretty(&json!({"version": 1, "notes": map})).unwrap() + "\n"),
    );
}

/// Notes 1, 2, 3 with one property each, migrated.
fn migrated() -> Fx {
    let fx = fx_old();
    for n in 1..=3 {
        fx.note(&id(n), &format!("n{n}.md"), "Заказчик: Готово\n");
    }
    write_old(
        &fx,
        &[
            (&id(1), vec![old_prop("P1", "Заказчик", "📌", "Готово")]),
            (&id(2), vec![old_prop("P2", "Заказчик", "📌", "Готово")]),
            (&id(3), vec![old_prop("P3", "Заказчик", "📌", "Готово")]),
        ],
    );
    run(
        &fx.conn,
        &fx.vault,
        &Decisions {
            confirmed: true,
            ..Decisions::default()
        },
        &Context::default(),
    )
    .unwrap();
    fx
}

fn icon_of(fx: &Fx, note: &str) -> String {
    fx.props(note)["Заказчик"]["icon"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn right_after_the_migration_there_is_nothing_to_carry_and_the_old_file_is_unchanged() {
    // З22, З36
    let fx = migrated();
    assert!(!properties_json_changed(&fx.vault).unwrap());
    let report = check_old_version_edits(&fx.conn, &fx.vault).unwrap();
    assert_eq!(report, LegacyReport::default());
    assert_eq!(report.hint_text(), None);
}

#[test]
fn an_edit_of_an_old_version_is_carried_to_the_group_without_values_and_the_owner_is_told() {
    // З22, З36: the list comes from the old record, without `value`; the note is not touched
    let fx = migrated();
    let note_before = fx.bytes("n1.md");
    write_old(
        &fx,
        &[
            (
                &id(1),
                vec![
                    old_prop("P1", "Заказчик", "🔥", "ЧУЖОЕ"),
                    old_prop("P9", "Новое", "⭐", "v"),
                ],
            ),
            (&id(2), vec![old_prop("P2", "Заказчик", "📌", "Готово")]),
            (&id(3), vec![old_prop("P3", "Заказчик", "📌", "Готово")]),
        ],
    );
    assert!(properties_json_changed(&fx.vault).unwrap());
    let report = check_old_version_edits(&fx.conn, &fx.vault).unwrap();
    assert_eq!(report.transferred, vec![id(1)]);
    assert!(report.conflicts.is_empty());
    assert_eq!(icon_of(&fx, &id(1)), "🔥");
    let mut carried = fx.prop_names(&id(1));
    carried.sort();
    assert_eq!(
        carried,
        vec!["Заказчик", "Новое"],
        "a set: the order of the line means nothing"
    );
    let text = String::from_utf8(fx.group_bytes(&id(1)).unwrap()).unwrap();
    assert!(
        !text.contains("ЧУЖОЕ") && !text.contains("value"),
        "values are never carried"
    );
    assert_eq!(
        fx.bytes("n1.md"),
        note_before,
        "the header keeps its value: the old value is not brought back"
    );
    assert!(report.hint_text().unwrap().starts_with(
        "Свойства, изменённые старой версией Amby на другом устройстве, перенесены: 1"
    ));
    assert!(
        !properties_json_changed(&fx.vault).unwrap(),
        "the new hash is remembered"
    );
}

#[test]
fn a_change_of_only_a_value_in_the_old_file_carries_nothing() {
    // З36: the hash of the old record is taken without `value`
    let fx = migrated();
    write_old(
        &fx,
        &[
            (
                &id(1),
                vec![old_prop("P1", "Заказчик", "📌", "СОВСЕМ ДРУГОЕ")],
            ),
            (&id(2), vec![old_prop("P2", "Заказчик", "📌", "Готово")]),
            (&id(3), vec![old_prop("P3", "Заказчик", "📌", "Готово")]),
        ],
    );
    let before = fx.snapshot();
    let report = check_old_version_edits(&fx.conn, &fx.vault).unwrap();
    assert!(report.transferred.is_empty() && report.conflicts.is_empty());
    assert_eq!(
        changed_paths(&before, &fx.snapshot())
            .iter()
            .filter(|p| p.starts_with(".amby/properties/"))
            .count(),
        0
    );
}

#[test]
fn the_same_difference_is_not_carried_a_second_time_over_newer_local_edits() {
    // З36: this is why the marks exist instead of a copy of the file
    let fx = migrated();
    write_old(
        &fx,
        &[
            (&id(1), vec![old_prop("P1", "Заказчик", "🔥", "Готово")]),
            (&id(2), vec![old_prop("P2", "Заказчик", "📌", "Готово")]),
            (&id(3), vec![old_prop("P3", "Заказчик", "📌", "Готово")]),
        ],
    );
    check_old_version_edits(&fx.conn, &fx.vault).unwrap();
    set_appearance(&fx.conn, &fx.vault, &id(1), "Заказчик", "⭐", "").unwrap();
    // the same old file is looked at again
    let again = check_old_version_edits(&fx.conn, &fx.vault).unwrap();
    assert_eq!(again, LegacyReport::default());
    assert_eq!(icon_of(&fx, &id(1)), "⭐");
}

#[test]
fn a_computer_without_the_local_memo_does_not_carry_the_same_difference_again() {
    // З36: the mark travels with the record, so the second device needs no copy of the file
    let fx = migrated();
    write_old(
        &fx,
        &[
            (&id(1), vec![old_prop("P1", "Заказчик", "🔥", "Готово")]),
            (&id(2), vec![old_prop("P2", "Заказчик", "📌", "Готово")]),
            (&id(3), vec![old_prop("P3", "Заказчик", "📌", "Готово")]),
        ],
    );
    check_old_version_edits(&fx.conn, &fx.vault).unwrap();
    set_appearance(&fx.conn, &fx.vault, &id(1), "Заказчик", "⭐", "").unwrap();
    let second = fx.copy_to_second_device(&[".amby/migrations/"]);
    let before = second.snapshot();
    let report = check_old_version_edits(&second.conn, &second.vault).unwrap();
    assert_eq!(report, LegacyReport::default());
    assert_eq!(
        changed_paths(&before, &second.snapshot())
            .iter()
            .filter(|p| p.starts_with(".amby/properties/"))
            .count(),
        0
    );
}

#[test]
fn an_edit_here_and_an_edit_there_of_one_note_is_a_conflict_with_two_choices() {
    // З22, З.7-3, З36
    for choice in [LegacyChoice::KeepHere, LegacyChoice::TakeOld] {
        let fx = migrated();
        set_appearance(&fx.conn, &fx.vault, &id(1), "Заказчик", "⭐", "").unwrap();
        write_old(
            &fx,
            &[
                (&id(1), vec![old_prop("P1", "Заказчик", "🔥", "Готово")]),
                (&id(2), vec![old_prop("P2", "Заказчик", "📌", "Готово")]),
                (&id(3), vec![old_prop("P3", "Заказчик", "📌", "Готово")]),
            ],
        );
        let before = fx.group_bytes(&id(1));
        let report = check_old_version_edits(&fx.conn, &fx.vault).unwrap();
        assert_eq!(report.conflicts, vec![LegacyConflict { note_id: id(1) }]);
        assert!(report.transferred.is_empty());
        assert_eq!(
            fx.group_bytes(&id(1)),
            before,
            "nothing is decided for the owner"
        );
        resolve_conflict(&fx.conn, &fx.vault, &id(1), choice).unwrap();
        let expected = if choice == LegacyChoice::KeepHere {
            "⭐"
        } else {
            "🔥"
        };
        assert_eq!(icon_of(&fx, &id(1)), expected);
        assert_eq!(
            check_old_version_edits(&fx.conn, &fx.vault).unwrap(),
            LegacyReport::default(),
            "{choice:?}: the mark is refreshed, no second question"
        );
    }
}

#[test]
fn a_property_deleted_by_the_old_version_is_deleted_here_and_a_property_deleted_here_stays_deleted()
{
    // З53: no tombstone line; the mark in `legacy_<x>.jsonl` is what stops the revival
    let fx = migrated();
    // here: the owner deletes the only property of note 2
    delete_property(&fx.conn, &fx.vault, &id(2), "Заказчик").unwrap();
    assert!(
        read_entry(&fx.vault, &id(2)).unwrap().is_none(),
        "no empty line"
    );
    assert!(
        read_mark(&fx.vault, &id(2)).unwrap().is_some(),
        "the mark stays"
    );
    assert_eq!(
        check_old_version_edits(&fx.conn, &fx.vault).unwrap(),
        LegacyReport::default(),
        "properties.json still has it: it must not come back"
    );
    assert!(read_entry(&fx.vault, &id(2)).unwrap().is_none());
    // there: the old version removes the whole record of note 3
    write_old(
        &fx,
        &[
            (&id(1), vec![old_prop("P1", "Заказчик", "📌", "Готово")]),
            (&id(2), vec![old_prop("P2", "Заказчик", "📌", "Готово")]),
        ],
    );
    let report = check_old_version_edits(&fx.conn, &fx.vault).unwrap();
    assert_eq!(report.transferred, vec![id(3)]);
    assert!(fx.line(&id(3)).is_none());
}

#[test]
fn a_note_added_by_the_old_version_after_the_migration_is_carried_or_is_a_conflict() {
    // З36: no mark and an old record: no entry — carry; an entry — conflict
    let fx = migrated();
    fx.note(&id(4), "n4.md", "");
    fx.note(&id(5), "n5.md", "");
    create_property(&fx.conn, &fx.vault, &id(5), design("Своё"), "x").unwrap();
    write_old(
        &fx,
        &[
            (&id(1), vec![old_prop("P1", "Заказчик", "📌", "Готово")]),
            (&id(2), vec![old_prop("P2", "Заказчик", "📌", "Готово")]),
            (&id(3), vec![old_prop("P3", "Заказчик", "📌", "Готово")]),
            (&id(4), vec![old_prop("P4", "Чужое", "📌", "v")]),
            (&id(5), vec![old_prop("P5", "Чужое", "📌", "v")]),
        ],
    );
    let report = check_old_version_edits(&fx.conn, &fx.vault).unwrap();
    assert_eq!(report.transferred, vec![id(4)]);
    assert_eq!(report.conflicts, vec![LegacyConflict { note_id: id(5) }]);
    assert_eq!(fx.prop_names(&id(4)), vec!["Чужое"]);
}

#[test]
fn the_new_version_does_not_read_the_old_file_for_anything_but_the_check() {
    // З22: broken or missing `properties.json` does not disturb the panel or the cache
    let fx = migrated();
    fx.write(".amby/properties.json", "garbage");
    let shown = panel(&fx.conn, &fx.vault, &id(1)).unwrap();
    assert_eq!(shown.active.len(), 1);
    rebuild_cache(&fx.conn, &fx.vault).unwrap();
    assert_eq!(
        fx.read(".amby/properties.json"),
        "garbage",
        "and it is never written"
    );
}

#[test]
fn the_sync_screen_warns_with_the_sentence_of_the_owner_while_an_old_version_writes() {
    // З22, З37, З.10-2
    let fx = migrated();
    assert_eq!(sync_screen_warning(&fx.vault).unwrap(), None);
    write_old(
        &fx,
        &[(&id(1), vec![old_prop("P1", "Заказчик", "🔥", "Готово")])],
    );
    let warning = sync_screen_warning(&fx.vault)
        .unwrap()
        .expect("the file changed");
    assert!(warning.contains(OLD_VERSION_WARNING), "{warning}");
    assert_eq!(
        OLD_VERSION_WARNING,
        "На устройствах со старой версией Amby не меняйте свойства — она может вернуть прежние значения"
    );
}

#[test]
fn the_marks_hold_the_hashes_and_a_note_without_a_line_has_a_mark_with_32_zeros() {
    // З53: `entry` — BLAKE3 of the old record without `value`; `record` — BLAKE3 of the canonical
    // line without `hint` and `dismissedRenames`, or 32 zeros (64 hex) when there is no line
    let (_, names) = crate::property_template::all()
        .into_iter()
        .find(|(p, _)| p.property_type == "select")
        .unwrap();
    let name = names[0].1.clone();
    let found = crate::property_template::lookup(&name).unwrap();
    let fx = fx_old();
    fx.note(&id(1), "n1.md", "Заказчик: Готово\n");
    fx.note(&id(2), "n2.md", &format!("{name}: x\n"));
    write_old(
        &fx,
        &[
            (&id(1), vec![old_prop("P1", "Заказчик", "📌", "Готово")]),
            (
                &id(2),
                vec![old_full(
                    "P2",
                    &name,
                    &found.property_type,
                    "x",
                    &found.settings,
                )],
            ),
        ],
    );
    let mut template_icon = old_full("P2", &name, &found.property_type, "x", &found.settings);
    template_icon["icon"] = serde_json::json!(found.icon);
    write_old(
        &fx,
        &[
            (&id(1), vec![old_prop("P1", "Заказчик", "📌", "Готово")]),
            (&id(2), vec![template_icon]),
        ],
    );
    run(
        &fx.conn,
        &fx.vault,
        &Decisions {
            confirmed: true,
            ..Decisions::default()
        },
        &Context::default(),
    )
    .unwrap();
    let with_line = read_mark(&fx.vault, &id(1))
        .unwrap()
        .expect("a mark for every migrated note");
    let without_line = read_mark(&fx.vault, &id(2))
        .unwrap()
        .expect("also for a note with nothing to store");
    for hash in [&with_line.entry, &with_line.record, &without_line.entry] {
        assert!(
            hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()),
            "{hash}"
        );
    }
    assert_eq!(without_line.record, "0".repeat(64));
    assert_ne!(with_line.record, "0".repeat(64));
    assert!(
        fx.line(&id(2)).is_none(),
        "everything is as in the template: no line"
    );
}
