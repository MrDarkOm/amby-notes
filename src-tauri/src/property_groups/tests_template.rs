//! The template of basic properties and the order (docs/sync-plan.md, appendix З, З.11: З45, З46,
//! З47). Red until written.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::json;

use super::testkit::*;
use super::*;
use crate::property_template::{all, lookup};

/// The first basic property of type `select` and one of its names.
fn a_select() -> (crate::property_template::TemplateProperty, String) {
    let (property, names) = all()
        .into_iter()
        .find(|(p, _)| p.property_type == "select")
        .expect("the template has a select");
    (property, names[0].1.clone())
}

// ----- З45: the template -----

#[test]
fn a_basic_property_is_found_by_its_name_in_every_language_of_the_interface() {
    // З45: «Статус» in Russian and «Status» in English are one property; the options come in the
    // language of the name that matched
    let ru = lookup("Статус").expect("«Статус» is a basic property");
    let en = lookup("Status").expect("«Status» is a basic property");
    assert_eq!(
        (ru.property_type.as_str(), ru.icon.as_str()),
        (en.property_type.as_str(), en.icon.as_str())
    );
    assert!(
        ru.settings
            .chars()
            .any(|c| ('а'..='я').contains(&c.to_lowercase().next().unwrap()))
            || ru.settings.is_empty()
    );
    assert!(en.settings.is_ascii());
    assert_ne!(ru.settings, en.settings);
}

#[test]
fn the_name_is_compared_after_nfc_exactly_and_then_without_ascii_case() {
    // З45, З24
    assert_eq!(lookup("status"), lookup("Status"));
    assert_eq!(lookup("STATUS"), lookup("Status"));
    assert!(lookup("статус").is_none(), "only ASCII letters fold case");
    assert!(lookup("Совсем неизвестное имя").is_none());
}

#[test]
fn every_name_of_every_basic_property_finds_that_property() {
    // З45
    let everything = all();
    assert!(
        everything.len() >= 4,
        "«Статус», «Приоритет», «Дата», «Теги» at least"
    );
    for (property, names) in everything {
        assert!(!names.is_empty());
        for (language, name) in names {
            let found = lookup(&name).unwrap_or_else(|| panic!("{language}: {name}"));
            assert_eq!(found.property_type, property.property_type, "{name}");
            assert_eq!(found.icon, property.icon, "{name}");
        }
    }
}

// ----- З46: how the panel builds a property -----

#[test]
fn a_key_of_the_template_gets_its_type_icon_and_options_with_no_record_and_no_file() {
    // З46, З47
    let fx = fx();
    let note = id(1);
    let (template, name) = a_select();
    fx.note(&note, "N.md", &format!("{name}: Значение\n"));
    let before = fx.snapshot();
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    let p = &shown.active[0];
    assert_eq!(p.name, name);
    assert!(p.from_template && !p.has_record);
    assert_eq!(p.property_type, template.property_type);
    assert_eq!(p.icon, template.icon);
    assert_eq!(p.settings, lookup(&name).unwrap().settings);
    assert_eq!(
        fx.snapshot(),
        before,
        "nothing is stored for a note that follows the template"
    );
    assert!(fx
        .files_under(".amby/properties/")
        .iter()
        .all(|f| f.ends_with("layout.json")));
}

#[test]
fn a_key_that_is_not_in_the_template_is_text_without_an_icon() {
    // З45, З46
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "Заказчик: Иван\namby-title: Название\n");
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(shown.active.len(), 1, "the keys of Amby are not properties");
    let p = &shown.active[0];
    assert_eq!(
        (
            p.property_type.as_str(),
            p.icon.as_str(),
            p.settings.as_str()
        ),
        ("text", "", "")
    );
    assert!(!p.from_template && !p.has_record);
}

#[test]
fn a_value_outside_the_options_is_shown_as_it_is_with_a_mark_and_the_header_is_not_rewritten() {
    // З45: values are never rewritten because of the template
    let fx = fx();
    let note = id(1);
    let (_, name) = a_select();
    fx.note(&note, "N.md", &format!("{name}: Нет такого варианта\n"));
    let before = fx.bytes("N.md");
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(shown.active[0].value, "Нет такого варианта");
    assert!(shown.active[0].outside_options);
    assert_eq!(fx.bytes("N.md"), before);
}

#[test]
fn the_differences_are_laid_over_the_template() {
    // З46
    let fx = fx();
    let note = id(1);
    let (template, name) = a_select();
    fx.note(&note, "N.md", &format!("{name}: x\n"));
    put_entry(
        &fx.conn,
        &fx.vault,
        &note,
        Some(NoteEntry {
            id: note.clone(),
            props: [(
                name.clone(),
                Diff {
                    icon: Some("🔥".into()),
                    settings: Some("Один,Два".into()),
                    ..Diff::default()
                },
            )]
            .into(),
            ..NoteEntry::default()
        }),
    )
    .unwrap();
    let p = &panel(&fx.conn, &fx.vault, &note).unwrap().active[0];
    assert_eq!((p.icon.as_str(), p.settings.as_str()), ("🔥", "Один,Два"));
    assert_eq!(
        p.property_type, template.property_type,
        "what the record does not say comes from the template"
    );
    assert!(p.from_template && p.has_record);
}

#[test]
fn a_template_property_whose_key_is_gone_just_disappears_and_does_not_sleep() {
    // З46
    let fx = fx();
    let note = id(1);
    let (_, name) = a_select();
    fx.note(&note, "N.md", &format!("{name}: x\n"));
    fx.note(&note, "N.md", "");
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert!(shown.active.is_empty() && shown.dormant.is_empty());
}

// ----- З47: only differences -----

#[test]
fn a_difference_equal_to_the_template_is_not_written_and_going_back_removes_the_line() {
    // З47
    let fx = fx();
    let note = id(1);
    let (template, name) = a_select();
    fx.note(&note, "N.md", &format!("{name}: x\n"));
    let settings = lookup(&name).unwrap().settings;
    set_appearance(&fx.conn, &fx.vault, &note, &name, &template.icon, &settings).unwrap();
    assert!(
        fx.line(&note).is_none(),
        "equal to the template: nothing to write"
    );
    set_appearance(&fx.conn, &fx.vault, &note, &name, "🔥", &settings).unwrap();
    assert_eq!(
        fx.props(&note)[&name],
        json!({"icon": "🔥"}),
        "only the field that differs"
    );
    set_appearance(&fx.conn, &fx.vault, &note, &name, &template.icon, &settings).unwrap();
    assert!(
        fx.line(&note).is_none() && !fx.exists(&fx.group_rel(&note)),
        "the property left, the line left, the file left"
    );
}

#[test]
fn a_type_change_of_a_basic_property_writes_the_type_alone() {
    // З47
    let fx = fx();
    let note = id(1);
    let (template, name) = a_select();
    fx.note(&note, "N.md", &format!("{name}: 5\n"));
    let other = if template.property_type == "number" {
        "text"
    } else {
        "number"
    };
    change_type(&fx.conn, &fx.vault, &note, &name, other).unwrap();
    assert_eq!(fx.props(&note)[&name], json!({"propertyType": other}));
}

#[test]
fn the_order_is_written_only_after_the_user_moves_something() {
    // З47
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    for name in ["Один", "Два", "Три"] {
        create_property(&fx.conn, &fx.vault, &note, design(name), "x").unwrap();
    }
    assert!(
        fx.line(&note).unwrap().get("order").is_none(),
        "no order for a note in header order"
    );
    let moved = ["Три".to_string(), "Один".to_string(), "Два".to_string()];
    reorder(&fx.conn, &fx.vault, &note, &moved).unwrap();
    assert_eq!(
        fx.line(&note).unwrap()["order"],
        json!(["Три", "Один", "Два"])
    );
    let names: Vec<String> = panel(&fx.conn, &fx.vault, &note)
        .unwrap()
        .active
        .iter()
        .map(|p| p.name.clone())
        .collect();
    assert_eq!(names, moved);
    reorder(
        &fx.conn,
        &fx.vault,
        &note,
        &["Один".to_string(), "Два".to_string(), "Три".to_string()],
    )
    .unwrap();
    assert!(
        fx.line(&note).unwrap().get("order").is_none(),
        "back to the order of the header"
    );
}

#[test]
fn names_missing_from_the_order_follow_in_header_order_and_dead_names_are_dropped_by_a_real_write()
{
    // З47
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "Один: 1\nДва: 2\nТри: 3\n");
    fx.write(
        &fx.group_rel(&note),
        &format!("{{\"version\":1}}\n{{\"id\":\"{note}\",\"order\":[\"Нет такого\",\"Три\"],\"props\":{{\"Два\":{{\"icon\":\"2\"}}}}}}\n"),
    );
    let names: Vec<String> = panel(&fx.conn, &fx.vault, &note)
        .unwrap()
        .active
        .iter()
        .map(|p| p.name.clone())
        .collect();
    assert_eq!(names, vec!["Три", "Один", "Два"]);
    set_appearance(&fx.conn, &fx.vault, &note, "Два", "🔥", "").unwrap();
    assert_eq!(
        fx.line(&note).unwrap()["order"],
        json!(["Три"]),
        "the name that is nowhere is gone"
    );
}

#[test]
fn a_name_is_unique_in_a_note_after_nfc_apart_from_the_ascii_case() {
    // З47
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    create_property(&fx.conn, &fx.vault, &note, design("Status2"), "x").unwrap();
    let before = fx.snapshot();
    assert!(create_property(&fx.conn, &fx.vault, &note, design("STATUS2"), "").is_err());
    assert_eq!(fx.snapshot(), before);
    create_property(&fx.conn, &fx.vault, &note, design("Заказчик"), "").unwrap();
    create_property(&fx.conn, &fx.vault, &note, design("заказчик"), "").unwrap();
}
