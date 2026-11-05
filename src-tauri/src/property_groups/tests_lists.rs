//! A multi-select is a YAML list the backend gives as a list of strings, never glued with commas
//! (docs/sync-plan.md, З62): an option may hold a comma, and toggling another option must not split it.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::testkit::*;
use super::*;

#[test]
fn the_panel_gives_the_items_of_a_list_as_they_are_in_the_header() {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "Жанр: [\"Фэнтези, тёмное\", Детектив]\n");
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(shown.active[0].items, vec!["Фэнтези, тёмное", "Детектив"]);
}

#[test]
fn writing_a_list_keeps_an_item_with_a_comma_as_one_item() {
    let fx = fx();
    let note = id(1);
    fx.note(
        &note,
        "N.md",
        "Жанр: [\"Фэнтези, тёмное\", Детектив]\nАвтор: я\n",
    );
    set_list_value(
        &fx.conn,
        &fx.vault,
        &note,
        "Жанр",
        &["Фэнтези, тёмное".to_string()],
    )
    .unwrap();
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(shown.active[0].items, vec!["Фэнтези, тёмное"]);
    assert!(
        fx.read("N.md").contains("Автор: я"),
        "the rest of the header stays"
    );
    // and back to two, in the other order
    set_list_value(
        &fx.conn,
        &fx.vault,
        &note,
        "Жанр",
        &["Детектив".to_string(), "Фэнтези, тёмное".to_string()],
    )
    .unwrap();
    let again = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(again.active[0].items, vec!["Детектив", "Фэнтези, тёмное"]);
}

#[test]
fn a_block_list_is_read_too_and_an_empty_list_is_written_empty() {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "Теги:\n  - а\n  - б\n");
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(shown.active[0].items, vec!["а", "б"]);
    let note2 = id(2);
    fx.note(&note2, "M.md", "Теги: [а]\n");
    set_list_value(&fx.conn, &fx.vault, &note2, "Теги", &[]).unwrap();
    assert!(panel(&fx.conn, &fx.vault, &note2).unwrap().active[0]
        .items
        .is_empty());
}
