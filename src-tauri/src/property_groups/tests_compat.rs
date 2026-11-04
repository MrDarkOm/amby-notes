//! The old id-based contract of the commands on top of the groups (appendix З: З38, З47). Written
//! with the code: the frozen tests of the other files do not reach `compat.rs`.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::testkit::*;
use super::*;
use crate::model::CustomProperty;

fn custom(
    id: &str,
    name: &str,
    icon: &str,
    ty: &str,
    value: &str,
    settings: &str,
) -> CustomProperty {
    CustomProperty {
        id: id.into(),
        name: name.into(),
        icon: icon.into(),
        property_type: ty.into(),
        value: value.into(),
        settings: settings.into(),
    }
}

#[test]
fn a_new_property_is_created_by_an_empty_id_and_the_name_becomes_its_id() {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    let saved = upsert_compat(
        &fx.conn,
        &fx.vault,
        &note,
        custom("", "Заказчик", "📌", "text", "Иван", ""),
    )
    .unwrap();
    assert_eq!(
        (saved.id.as_str(), saved.value.as_str()),
        ("Заказчик", "Иван")
    );
    assert!(fx.read("N.md").contains("Заказчик: Иван"));
    assert_eq!(
        fx.props(&note)["Заказчик"],
        serde_json::json!({"icon": "📌"})
    );
    assert!(!fx.exists(".amby/properties.json"));
}

#[test]
fn one_call_with_a_new_name_type_look_and_value_makes_every_edit_it_needs() {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    upsert_compat(
        &fx.conn,
        &fx.vault,
        &note,
        custom("", "Счёт", "📌", "text", "5", ""),
    )
    .unwrap();
    let saved = upsert_compat(
        &fx.conn,
        &fx.vault,
        &note,
        custom("Счёт", "Сумма", "💰", "number", "7", ""),
    )
    .unwrap();
    assert_eq!(saved.id, "Сумма");
    assert_eq!(
        (
            saved.property_type.as_str(),
            saved.icon.as_str(),
            saved.value.as_str()
        ),
        ("number", "💰", "7")
    );
    let text = fx.read("N.md");
    assert!(
        text.contains("Сумма: 7") && !text.contains("Счёт"),
        "{text}"
    );
    assert!(fx.files_under(".amby/property-ops/").is_empty());
}

#[test]
fn a_key_without_a_record_is_given_one_by_the_first_upsert() {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "Метка: x\n");
    let saved = upsert_compat(
        &fx.conn,
        &fx.vault,
        &note,
        custom("", "Метка", "🔖", "text", "x", ""),
    )
    .unwrap();
    assert_eq!(saved.icon, "🔖");
    assert_eq!(
        fx.read("N.md"),
        format!("---\namby-id: {note}\nМетка: x\n---\nТекст\n")
    );
}

#[test]
fn custom_properties_lists_records_and_basic_properties_but_not_plain_keys() {
    let fx = fx();
    let note = id(1);
    fx.note(
        &note,
        "N.md",
        "Статус: Готово\nПросто: так\nЗаказчик: Иван\n",
    );
    put_entry(
        &fx.conn,
        &fx.vault,
        &note,
        Some(entry_of(&note, &[("Заказчик", "📌")])),
    )
    .unwrap();
    let names: Vec<String> = custom_properties(&fx.conn, &fx.vault, &note)
        .unwrap()
        .into_iter()
        .map(|p| p.name)
        .collect();
    assert_eq!(names, vec!["Статус", "Заказчик"]);
}

#[test]
fn delete_and_reorder_work_by_name() {
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    for name in ["Один", "Два"] {
        upsert_compat(
            &fx.conn,
            &fx.vault,
            &note,
            custom("", name, "📌", "text", "x", ""),
        )
        .unwrap();
    }
    reorder_compat(
        &fx.conn,
        &fx.vault,
        &note,
        &["Два".to_string(), "Один".to_string()],
    )
    .unwrap();
    assert_eq!(
        fx.line(&note).unwrap()["order"],
        serde_json::json!(["Два", "Один"])
    );
    delete_compat(&fx.conn, &fx.vault, &note, "Один").unwrap();
    assert!(!fx.read("N.md").contains("Один"));
    assert_eq!(fx.prop_names(&note), vec!["Два"]);
}

#[test]
fn the_old_store_is_not_written_where_the_layout_is_newer() {
    let fx = fx();
    fx.write(
        ".amby/properties/layout.json",
        r#"{"groups":256,"hash":"blake3-first-byte","template":1,"version":1}"#,
    );
    assert!(ensure_old_store_writable(&fx.vault).is_err());
    assert!(restore_cache_any(&fx.conn, &fx.vault).is_ok());
    assert!(ensure_old_store_writable(&fx_old().vault).is_ok());
}
