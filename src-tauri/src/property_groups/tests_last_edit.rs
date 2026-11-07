//! Every edit of the line of a note stamps the time of the edit (docs/sync-plan.md, З70), so that
//! sync keeps the later of two edits made on two computers. Red until written.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::files::set_edit_clock;
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

fn edited(fx: &Fx, note: &str) -> Option<u64> {
    fx.lines(note)
        .into_iter()
        .find(|line| line["id"] == note)
        .and_then(|line| line.get("edited").and_then(serde_json::Value::as_u64))
}

#[test]
fn an_edit_of_the_look_stamps_the_time_of_the_edit() {
    let (fx, note) = with_status();
    set_edit_clock(Some(1_700_000_000_123));
    set_appearance(&fx.conn, &fx.vault, &note, NAME, "🔥", "x").unwrap();
    set_edit_clock(None);
    assert_eq!(edited(&fx, &note), Some(1_700_000_000_123));
}

#[test]
fn a_write_that_changes_nothing_keeps_the_time_and_the_bytes() {
    // З8, З70: nothing is written when nothing changes, the time of the last edit stays
    let (fx, note) = with_status();
    set_edit_clock(Some(1_000));
    set_appearance(&fx.conn, &fx.vault, &note, NAME, "🔥", "x").unwrap();
    let before = fx.group_bytes(&note);
    set_edit_clock(Some(2_000));
    set_appearance(&fx.conn, &fx.vault, &note, NAME, "🔥", "x").unwrap();
    set_edit_clock(None);
    assert_eq!(fx.group_bytes(&note), before);
    assert_eq!(edited(&fx, &note), Some(1_000));
}

#[test]
fn the_next_edit_moves_the_time_forward() {
    let (fx, note) = with_status();
    set_edit_clock(Some(1_000));
    set_appearance(&fx.conn, &fx.vault, &note, NAME, "🔥", "x").unwrap();
    set_edit_clock(Some(5_000));
    set_appearance(&fx.conn, &fx.vault, &note, NAME, "📝", "x").unwrap();
    set_edit_clock(None);
    assert_eq!(edited(&fx, &note), Some(5_000));
}

#[test]
fn the_time_alone_does_not_keep_a_line() {
    // З4, З47: a record with nothing left is removed, its time does not keep it
    let (fx, note) = with_status();
    set_edit_clock(Some(1_000));
    set_appearance(&fx.conn, &fx.vault, &note, NAME, "🔥", "x").unwrap();
    put_entry(&fx.conn, &fx.vault, &note, None).unwrap();
    set_edit_clock(None);
    assert!(fx.lines(&note).iter().all(|line| line["id"] != note));
}

#[test]
fn the_mark_of_an_old_version_does_not_count_the_time() {
    // З53, З70: `record` ignores `edited` like `hint`, so a line only restamped is not "changed"
    let plain = entry_of("A", &[(NAME, "🔥")]);
    let mut stamped = plain.clone();
    stamped
        .extra
        .insert("edited".to_string(), serde_json::json!(42));
    assert_eq!(
        legacy::record_hash(Some(&stamped)),
        legacy::record_hash(Some(&plain))
    );
}
