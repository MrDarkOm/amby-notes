//! Identity of a note, deletion of a note and the inspection (docs/sync-plan.md, appendix З: З10,
//! З11, З12, З34, З35). Red until written.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::testkit::*;
use super::*;
use crate::recycle_bin;

fn with_status() -> (Fx, String) {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    create_property(&fx.conn, &fx.vault, &note, design("Заказчик"), "Готово").unwrap();
    (fx, note)
}

// ----- З34: deleting a note never removes its record -----

#[test]
fn moving_a_note_to_the_vault_trash_keeps_its_record_and_restoring_returns_the_properties() {
    // З34 (files.deleteMode = vault)
    let (fx, note) = with_status();
    let group_before = fx.group_bytes(&note);
    let panel_before = panel(&fx.conn, &fx.vault, &note).unwrap();
    recycle_bin::move_to_trash(&fx.vault, &fx.vault.join("N.md")).unwrap();
    assert_eq!(fx.group_bytes(&note), group_before, "the record stays");
    let entry = recycle_bin::list(&fx.vault).into_iter().next().unwrap();
    recycle_bin::restore(&fx.vault, &entry.id).unwrap();
    assert_eq!(fx.group_bytes(&note), group_before);
    assert_eq!(panel(&fx.conn, &fx.vault, &note).unwrap(), panel_before);
}

#[test]
fn deleting_a_note_for_good_keeps_the_record_and_the_inspection_shows_it_without_a_note() {
    // З34 (permanent), З10
    let (fx, note) = with_status();
    let group_before = fx.group_bytes(&note);
    recycle_bin::delete_permanently(&fx.vault, &fx.vault.join("N.md")).unwrap();
    fx.conn
        .execute("DELETE FROM notes WHERE id = ?1", [&note])
        .unwrap();
    assert_eq!(fx.group_bytes(&note), group_before);
    assert_eq!(inspect(&fx.conn, &fx.vault).unwrap().orphans, vec![note]);
}

#[test]
fn deleting_an_orphan_record_keeps_a_copy_first() {
    // З10, З34
    let (fx, note) = with_status();
    fx.conn
        .execute("DELETE FROM notes WHERE id = ?1", [&note])
        .unwrap();
    let result = with_failing_write(1, false, || delete_orphan(&fx.conn, &fx.vault, &note));
    assert!(result.is_err());
    assert_eq!(fx.prop_names(&note), vec!["Заказчик"]);
    assert_eq!(
        fx.files_under(&format!(".amby/property-backups/{note}/"))
            .len(),
        1,
        "the copy comes first"
    );
    delete_orphan(&fx.conn, &fx.vault, &note).unwrap();
    assert!(read_entry(&fx.vault, &note).unwrap().is_none());
    let copies = fx.files_under(&format!(".amby/property-backups/{note}/"));
    assert!(copies.iter().any(|c| fx.read(c).contains("Заказчик")));
}

#[test]
fn the_inspection_lists_what_needs_a_human_and_changes_nothing() {
    // З10: sleeping designs, records without a note, ambiguous keys, names that start with `amby-`
    let fx = fx();
    let (a, b) = ids_in_different_groups();
    fx.note(&a, "A.md", "");
    let sleeper = create_property(&fx.conn, &fx.vault, &a, design("Спит"), "x").unwrap();
    create_property(&fx.conn, &fx.vault, &a, design("Two"), "x").unwrap();
    fx.note(&a, "A.md", "TWO: 1\ntwo: 2\n");
    let orphan = id(77);
    put_entry(
        &fx.conn,
        &fx.vault,
        &orphan,
        Some(entry_of(&orphan, &[("Сирота", "📌")])),
    )
    .unwrap();
    put_entry(
        &fx.conn,
        &fx.vault,
        &b,
        Some(entry_of(&b, &[("amby-secret", "📌")])),
    )
    .unwrap();
    fx.note(&b, "B.md", "");
    let before = fx.snapshot();
    let report = inspect(&fx.conn, &fx.vault).unwrap();
    assert!(
        report.dormant.contains(&(a.clone(), "Спит".to_string())),
        "{report:?}"
    );
    assert!(report.orphans.contains(&orphan));
    assert!(report.ambiguous.contains(&(a.clone(), "Two".to_string())));
    assert!(report
        .reserved_names
        .contains(&(b, "amby-secret".to_string())));
    assert_eq!(fx.snapshot(), before, "nothing is deleted silently");
    let _ = sleeper;
}

// ----- З11, З35: a note changed its amby-id -----

/// A record under `old`, and a note at `N.md` that now has `new_id`; the old id is nowhere.
fn id_changed(old: &str, new_id: &str) -> Fx {
    let fx = fx();
    fx.note(old, "N.md", "");
    create_property(&fx.conn, &fx.vault, old, design("Заказчик"), "Готово").unwrap();
    fx.note(new_id, "N.md", "Заказчик: Готово\n");
    fx.conn
        .execute("DELETE FROM notes WHERE id = ?1", [old])
        .unwrap();
    fx
}

#[test]
fn a_new_id_at_the_same_path_with_the_old_id_nowhere_is_offered_and_nothing_changes_until_consent()
{
    // З11, З35
    let (old, new_id) = ids_in_different_groups();
    let fx = id_changed(&old, &new_id);
    let before = fx.snapshot();
    assert_eq!(
        rebind_offers(&fx.conn, &fx.vault).unwrap(),
        vec![RebindOffer {
            old_id: old.clone(),
            new_id: new_id.clone(),
            path: "N.md".into()
        }]
    );
    assert_eq!(fx.snapshot(), before, "an offer writes nothing");
}

#[test]
fn no_offer_when_the_old_id_is_still_somewhere_or_the_new_id_has_another_record() {
    // З11, З35
    let (old, new_id) = ids_in_different_groups();
    // the old id still belongs to another note
    let fx = id_changed(&old, &new_id);
    fx.note(&old, "Elsewhere.md", "");
    assert!(rebind_offers(&fx.conn, &fx.vault).unwrap().is_empty());
    // the new id already has a different record
    let fx = id_changed(&old, &new_id);
    put_entry(
        &fx.conn,
        &fx.vault,
        &new_id,
        Some(entry_of(&new_id, &[("Чужое", "📌")])),
    )
    .unwrap();
    assert!(rebind_offers(&fx.conn, &fx.vault).unwrap().is_empty());
    // the new id has a record equal to the old one apart from the hint: still offered
    let fx = id_changed(&old, &new_id);
    let mut same = read_entry(&fx.vault, &old).unwrap().unwrap();
    same.id = new_id.clone();
    same.hint = Some(Hint {
        path: "Другое.md".into(),
    });
    put_entry(&fx.conn, &fx.vault, &new_id, Some(same)).unwrap();
    assert_eq!(rebind_offers(&fx.conn, &fx.vault).unwrap().len(), 1);
}

#[test]
fn consent_moves_the_record_to_the_new_id_possibly_into_another_group() {
    // З11, З35, З55: the whole line moves, a copy of the old one, then the old one is removed
    let (old, new_id) = ids_in_different_groups();
    let fx = id_changed(&old, &new_id);
    let old_designs = fx.props(&old);
    rebind(&fx.conn, &fx.vault, &old, &new_id).unwrap();
    assert_eq!(fx.props(&new_id), old_designs);
    assert!(read_entry(&fx.vault, &old).unwrap().is_none());
    assert!(!fx
        .files_under(&format!(".amby/property-backups/{old}/"))
        .is_empty());
    assert!(rebind_offers(&fx.conn, &fx.vault).unwrap().is_empty());
    let shown = panel(&fx.conn, &fx.vault, &new_id).unwrap();
    assert_eq!(shown.active[0].value, "Готово");
}

#[test]
fn a_crash_at_any_write_of_a_rebind_is_finished_by_a_repeat_without_loss() {
    // З35: «Повтор после сбоя: новая уже равна старой — только удаление старой»
    let (old, new_id) = ids_in_different_groups();
    for (n, after) in (1..=6).flat_map(|n| [(n, false), (n, true)]) {
        let fx = id_changed(&old, &new_id);
        let wanted = fx.props(&old);
        let _ = with_failing_write(n, after, || rebind(&fx.conn, &fx.vault, &old, &new_id));
        // whatever happened, the properties exist under at least one of the ids
        assert!(
            fx.props(&old) == wanted || fx.props(&new_id) == wanted,
            "crash at {n}/{after}: the record is lost"
        );
        rebind(&fx.conn, &fx.vault, &old, &new_id).unwrap();
        assert_eq!(fx.props(&new_id), wanted, "crash at {n}/{after}");
        assert!(
            read_entry(&fx.vault, &old).unwrap().is_none(),
            "crash at {n}/{after}"
        );
        assert!(!fx
            .files_under(&format!(".amby/property-backups/{old}/"))
            .is_empty());
    }
}

#[test]
fn rebinding_onto_an_id_with_a_different_record_is_refused() {
    // З35: only the inspection then
    let (old, new_id) = ids_in_different_groups();
    let fx = id_changed(&old, &new_id);
    put_entry(
        &fx.conn,
        &fx.vault,
        &new_id,
        Some(entry_of(&new_id, &[("Чужое", "📌")])),
    )
    .unwrap();
    let before = fx.snapshot();
    assert!(rebind(&fx.conn, &fx.vault, &old, &new_id).is_err());
    assert_eq!(fx.snapshot(), before);
}

#[test]
fn a_duplicate_id_blocks_the_edits_of_the_note_until_it_is_unique() {
    // З12
    let (fx, note) = with_status();
    fx.make_duplicate_id(&note);
    let before = fx.snapshot();
    assert!(set_appearance(&fx.conn, &fx.vault, &note, "Заказчик", "🔥", "").is_err());
    assert!(create_property(&fx.conn, &fx.vault, &note, design("Автор"), "").is_err());
    assert_eq!(fx.snapshot(), before);
}
