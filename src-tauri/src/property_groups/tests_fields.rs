//! The look is changed field by field: a field that is `None` is not touched (appendix З: З60).
//! Written with the code; the frozen tests keep calling `set_appearance` with both fields.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::json;

use super::testkit::*;
use super::*;

#[test]
fn a_field_that_is_none_is_not_touched_and_the_last_values_win() {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "Метка: x\n");
    set_appearance_fields(&fx.conn, &fx.vault, &note, "Метка", Some("🔥"), Some("А,Б")).unwrap();
    // only the icon: the options stay
    set_appearance_fields(&fx.conn, &fx.vault, &note, "Метка", Some("😀"), None).unwrap();
    assert_eq!(
        fx.props(&note)["Метка"],
        json!({"icon": "😀", "settings": "А,Б"})
    );
    // only the options: the icon stays
    set_appearance_fields(&fx.conn, &fx.vault, &note, "Метка", None, Some("В")).unwrap();
    assert_eq!(
        fx.props(&note)["Метка"],
        json!({"icon": "😀", "settings": "В"})
    );
    // icon, settings, icon: the result has the last of each
    set_appearance_fields(&fx.conn, &fx.vault, &note, "Метка", Some("⭐"), None).unwrap();
    assert_eq!(
        fx.props(&note)["Метка"],
        json!({"icon": "⭐", "settings": "В"})
    );
}

#[test]
fn nothing_at_all_changes_nothing() {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "Метка: x\n");
    set_appearance_fields(&fx.conn, &fx.vault, &note, "Метка", Some("🔥"), None).unwrap();
    let before = fx.snapshot();
    set_appearance_fields(&fx.conn, &fx.vault, &note, "Метка", None, None).unwrap();
    assert_eq!(fx.snapshot(), before);
}
