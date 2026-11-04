//! Sleeping designs and the hint about a rename outside Amby (docs/sync-plan.md, appendix З: З3,
//! З3а, З34, З37, З44). Red until written.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::testkit::*;
use super::*;

/// A note with one property «Статус» = «Готово»; returns the fixture, the note id, the property.
fn with_status() -> (Fx, String, Design) {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    let made = create_property(&fx.conn, &fx.vault, &note, design("Статус"), "Готово").unwrap();
    (fx, note, made)
}

/// The owner edits the header in another program: the lines after `amby-id`.
fn edit_header_outside(fx: &Fx, note: &str, lines: &str) {
    fx.write(
        "N.md",
        &format!("---\namby-id: {note}\n{lines}---\nТекст\n"),
    );
}

// ----- З3: a design without a key sleeps -----

#[test]
fn a_design_whose_key_is_gone_sleeps_below_the_active_ones_and_nothing_is_written() {
    // З3, З8
    let (fx, note, made) = with_status();
    create_property(&fx.conn, &fx.vault, &note, design("Автор"), "я").unwrap();
    edit_header_outside(&fx, &note, "Автор: я\n");
    let before = fx.snapshot();
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(shown.active.len(), 1);
    assert_eq!(shown.active[0].design.name, "Автор");
    assert_eq!(shown.dormant.len(), 1);
    assert_eq!(shown.dormant[0].id, made.id);
    assert_eq!(fx.snapshot(), before, "the record is not touched");
}

#[test]
fn a_key_without_a_design_is_an_ordinary_line_of_the_header() {
    // З3
    let (fx, note, _) = with_status();
    edit_header_outside(&fx, &note, "Статус: Готово\nМетка: x\n");
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(shown.plain, vec![("Метка".to_string(), "x".to_string())]);
}

#[test]
fn a_sleeping_design_wakes_when_the_key_returns() {
    // З3: deleted in Obsidian and brought back — the design is whole
    let (fx, note, made) = with_status();
    edit_header_outside(&fx, &note, "");
    assert_eq!(panel(&fx.conn, &fx.vault, &note).unwrap().dormant.len(), 1);
    edit_header_outside(&fx, &note, "Статус: Новое\n");
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert!(shown.dormant.is_empty());
    assert_eq!(shown.active[0].design.id, made.id);
    assert_eq!(shown.active[0].value, "Новое");
}

#[test]
fn bring_back_adds_the_key_with_an_empty_value_and_wakes_the_design() {
    // З3 «Вернуть»
    let (fx, note, made) = with_status();
    edit_header_outside(&fx, &note, "");
    restore_dormant(&fx.conn, &fx.vault, &note, &made.id).unwrap();
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert!(shown.dormant.is_empty());
    assert_eq!(shown.active[0].value, "");
    assert!(fx.read("N.md").contains("Статус:"));
    assert_eq!(fx.designs(&note).len(), 1, "the record is the same");
}

#[test]
fn delete_for_good_keeps_a_copy_in_property_backups_before_the_record_goes() {
    // З3, З34
    let (fx, note, made) = with_status();
    edit_header_outside(&fx, &note, "");
    purge_dormant(&fx.conn, &fx.vault, &note, &made.id).unwrap();
    assert!(read_entry(&fx.vault, &note).unwrap().is_none());
    let copies = fx.files_under(&format!(".amby/property-backups/{note}/"));
    assert_eq!(copies.len(), 1);
    assert!(fx.read(&copies[0]).contains(&made.id));
}

#[test]
fn the_copy_of_a_purged_design_exists_even_when_the_group_write_fails() {
    // З34: the order is copy, then removal
    let (fx, note, made) = with_status();
    edit_header_outside(&fx, &note, "");
    let result = with_failing_write(1, false, || {
        purge_dormant(&fx.conn, &fx.vault, &note, &made.id)
    });
    assert!(result.is_err());
    assert_eq!(fx.designs(&note).len(), 1);
    assert_eq!(
        fx.files_under(&format!(".amby/property-backups/{note}/"))
            .len(),
        1
    );
}

// ----- З3а: a rename outside Amby -----

#[test]
fn a_renamed_key_with_the_same_value_offers_to_carry_the_design_over() {
    // З3а: «Похоже, «Статус» переименовали в «Состояние»…»
    let (fx, note, _) = with_status();
    edit_header_outside(&fx, &note, "Состояние: Готово\n");
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(
        shown.rename_hint,
        Some(RenameHint {
            old_name: "Статус".into(),
            new_name: "Состояние".into()
        })
    );
    assert_eq!(
        shown.dormant.len(),
        1,
        "until the owner answers, both are visible"
    );
    assert_eq!(shown.plain.len(), 1);
}

#[test]
fn no_hint_without_a_value_or_with_another_value_or_with_more_than_one_pair() {
    // З3а, З44
    for (lines, label) in [
        ("Состояние: Другое\n", "another value"),
        ("Состояние:\n", "empty value"),
        ("Состояние: Готово\nПоложение: Готово\n", "two new keys"),
    ] {
        let (fx, note, _) = with_status();
        edit_header_outside(&fx, &note, lines);
        let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
        assert!(shown.rename_hint.is_none(), "{label}");
        assert_eq!(shown.dormant.len(), 1, "{label}: the old design is grey");
    }
    // two sleeping designs with the same last value and one new key
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    create_property(&fx.conn, &fx.vault, &note, design("Один"), "Готово").unwrap();
    create_property(&fx.conn, &fx.vault, &note, design("Два"), "Готово").unwrap();
    edit_header_outside(&fx, &note, "Три: Готово\n");
    assert!(panel(&fx.conn, &fx.vault, &note)
        .unwrap()
        .rename_hint
        .is_none());
}

#[test]
fn accepting_the_hint_renames_the_design_in_the_group_and_does_not_touch_the_header() {
    // З3а: one write of a group
    let (fx, note, made) = with_status();
    edit_header_outside(&fx, &note, "Состояние: Готово\n");
    let before = fx.snapshot();
    let hint = panel(&fx.conn, &fx.vault, &note)
        .unwrap()
        .rename_hint
        .unwrap();
    accept_rename_hint(&fx.conn, &fx.vault, &note, &hint).unwrap();
    assert_eq!(
        changed_paths(&before, &fx.snapshot()),
        vec![fx.group_rel(&note)],
        "one group is written, the note is not"
    );
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert!(shown.dormant.is_empty() && shown.rename_hint.is_none());
    assert_eq!(shown.active[0].design.id, made.id);
    assert_eq!(shown.active[0].design.name, "Состояние");
    assert_eq!(shown.active[0].value, "Готово");
}

#[test]
fn refusing_the_hint_is_stored_in_the_record_and_survives_a_rebuild_of_the_cache() {
    // З3а, З44: not only on this computer
    let (fx, note, _) = with_status();
    edit_header_outside(&fx, &note, "Состояние: Готово\n");
    let hint = panel(&fx.conn, &fx.vault, &note)
        .unwrap()
        .rename_hint
        .unwrap();
    dismiss_rename_hint(&fx.conn, &fx.vault, &note, &hint).unwrap();
    assert_eq!(
        fx.group_json(&note)["notes"][&note]["dismissedRenames"],
        serde_json::json!([["Статус", "Состояние"]])
    );
    assert!(panel(&fx.conn, &fx.vault, &note)
        .unwrap()
        .rename_hint
        .is_none());
    fx.conn
        .execute("DELETE FROM note_custom_properties", [])
        .unwrap();
    rebuild_cache(&fx.conn, &fx.vault).unwrap();
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert!(
        shown.rename_hint.is_none(),
        "the refusal is in the group, not in SQLite"
    );
    assert_eq!(shown.dormant.len(), 1, "both are still shown as they are");
}

#[test]
fn a_refused_pair_is_removed_only_by_a_real_write_when_one_of_its_names_is_gone() {
    // З44: not by a read, not while both names exist
    let (fx, note, made) = with_status();
    edit_header_outside(&fx, &note, "Состояние: Готово\n");
    let hint = panel(&fx.conn, &fx.vault, &note)
        .unwrap()
        .rename_hint
        .unwrap();
    dismiss_rename_hint(&fx.conn, &fx.vault, &note, &hint).unwrap();
    // both names still exist: a real write of the note keeps the pair
    set_appearance(&fx.conn, &fx.vault, &note, &made.id, "🔥", "").unwrap();
    assert_eq!(
        fx.group_json(&note)["notes"][&note]["dismissedRenames"],
        serde_json::json!([["Статус", "Состояние"]])
    );
    // the new key disappears from the header: a read does not clean the pair…
    edit_header_outside(&fx, &note, "");
    let before = fx.group_bytes(&note);
    panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(fx.group_bytes(&note), before);
    // …a real write does
    set_appearance(&fx.conn, &fx.vault, &note, &made.id, "⭐", "").unwrap();
    assert!(fx.group_json(&note)["notes"][&note]
        .get("dismissedRenames")
        .is_none());
}
