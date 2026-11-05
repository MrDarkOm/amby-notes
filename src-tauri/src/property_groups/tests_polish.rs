//! A list in the header with no stored type reads as a multi-select whose options are its items
//! (docs/sync-plan.md, З62, З.12): the owner found it as plain text with «- » in front of the lines.
//! Nothing is written to the header or to the groups until the person edits.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::testkit::*;
use super::*;

#[test]
fn a_header_list_with_no_record_is_a_multi_select_of_its_items() {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "Жанр: [\"Фэнтези, тёмное\", Детектив]\n");
    let before = fx.snapshot();
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    let genre = &shown.active[0];
    assert_eq!(genre.property_type, "list");
    assert_eq!(genre.items, vec!["Фэнтези, тёмное", "Детектив"]);
    let settings: serde_json::Value = serde_json::from_str(&genre.settings).unwrap();
    assert_eq!(
        settings["options"],
        serde_json::json!(["Фэнтези, тёмное", "Детектив"]),
        "a value with a comma is one option"
    );
    assert!(!genre.has_record, "reading writes nothing");
    assert_eq!(fx.snapshot(), before, "no byte of the vault changed");
}

#[test]
fn a_block_list_reads_the_same_way() {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "Жанр:\n  - а\n  - б\n");
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(shown.active[0].property_type, "list");
}

#[test]
fn a_text_and_an_empty_list_stay_what_they_were() {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "Автор: я\nПусто: []\n");
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(shown.active[0].property_type, "text");
    assert_eq!(shown.active[1].property_type, "text");
}

#[test]
fn a_type_the_person_chose_wins_over_the_shape_of_the_value() {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "Жанр: [а, б]\n");
    change_type(&fx.conn, &fx.vault, &note, "Жанр", "select").unwrap();
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(shown.active[0].property_type, "select");
}

#[test]
fn the_list_for_the_interface_carries_the_derived_type_and_options() {
    let fx = fx();
    let note = id(1);
    fx.note(
        &note,
        "N.md",
        "Жанр: [\"Фэнтези, тёмное\", Детектив]\nАвтор: я\n",
    );
    let listed = custom_properties(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(listed.len(), 1, "the plain text key stays an ordinary line");
    assert_eq!(listed[0].name, "Жанр");
    assert_eq!(listed[0].property_type, "list");
    assert!(listed[0].settings.contains("Фэнтези, тёмное"));
}

// ----- З63: the colour of an option is a part of `settings` -----

#[test]
fn settings_that_differ_only_in_colours_are_not_the_same() {
    use super::header::same_settings;
    let plain = r#"{"options":["А","Б"]}"#;
    let coloured = r#"{"options":["А","Б"],"colors":{"А":"red"}}"#;
    assert!(
        !same_settings(plain, coloured),
        "a chosen colour is a difference from the template"
    );
    assert!(same_settings(coloured, coloured));
    assert!(
        same_settings(plain, r#"{"options":["А","Б"],"colors":{}}"#),
        "no colour chosen is the same as an empty map"
    );
    assert!(
        !same_settings(coloured, r#"{"options":["А","Б"],"colors":{"А":"blue"}}"#),
        "another colour is another look"
    );
}

#[test]
fn a_colour_of_an_option_survives_a_round_trip_through_the_look() {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "Жанр: [а]\n");
    let settings = r#"{"options":["а","б"],"colors":{"а":"red","нет":"nope"}}"#;
    change_type(&fx.conn, &fx.vault, &note, "Жанр", "list").unwrap();
    set_appearance_fields(&fx.conn, &fx.vault, &note, "Жанр", None, Some(settings)).unwrap();
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(
        shown.active[0].settings, settings,
        "kept as written, unknown parts included"
    );
}
