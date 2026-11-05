//! «Взять значение из старого файла» after a rename in Amby: the old file knows the property by the
//! name it had, the header by the name it has now (appendix З: З58). Written with the code.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::json;

use super::migration::{run, take_file_value_as, Context};
use super::testkit::*;
use super::*;

fn diverged() -> Fx {
    let fx = fx_old();
    fx.note(&id(1), "n.md", "Заказчик: Б\n");
    fx.write(
        ".amby/properties.json",
        &serde_json::to_string(&json!({"version": 1, "notes": {id(1): [{
            "id": "P", "name": "Заказчик", "icon": "📌", "propertyType": "text",
            "value": "А", "settings": ""
        }]}}))
        .unwrap(),
    );
    run(&fx.conn, &fx.vault, &Context::default()).unwrap();
    fx
}

#[test]
fn the_value_goes_to_the_key_the_property_has_now() {
    let fx = diverged();
    rename_property(&fx.conn, &fx.vault, &id(1), "Заказчик", "Клиент").unwrap();
    take_file_value_as(&fx.conn, &fx.vault, &id(1), "Заказчик", "Клиент").unwrap();
    let text = fx.read("n.md");
    assert!(text.contains("Клиент: А"), "{text}");
    assert!(!text.contains("Заказчик"), "{text}");
}

#[test]
fn a_property_that_is_gone_from_the_note_writes_nothing() {
    let fx = diverged();
    delete_property(&fx.conn, &fx.vault, &id(1), "Заказчик").unwrap();
    let before = fx.snapshot();
    assert!(take_file_value_as(&fx.conn, &fx.vault, &id(1), "Заказчик", "Заказчик").is_err());
    assert_eq!(fx.snapshot(), before);
}
