//! The icons of the basic properties are icons of the Lucide set of the application, written as
//! `amby-icon:<name>:` with no colour (docs/sync-plan.md, З61). Written with the code.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::json;

use super::migration::{run, Context};
use super::testkit::*;
use super::*;
use crate::property_template::lookup;

#[test]
fn the_basic_properties_have_the_icons_of_the_plan() {
    for (name, icon) in [
        ("Статус", "amby-icon:circle-chevron-down:"),
        ("Priority", "amby-icon:flag:"),
        ("Дата", "amby-icon:calendar-days:"),
        ("Tags", "amby-icon:list:"),
    ] {
        assert_eq!(lookup(name).unwrap().icon, icon, "{name}");
    }
}

#[test]
fn an_emoji_of_a_person_still_wins_and_is_a_difference_from_the_new_template() {
    // the old record gave «Статус» the icon 📌: that was a choice, so it is carried
    let fx = fx_old();
    fx.note(&id(1), "n.md", "Статус: Готово\n");
    let found = lookup("Статус").unwrap();
    fx.write(
        ".amby/properties.json",
        &serde_json::to_string(&json!({"version": 1, "notes": {id(1): [{
            "id": "P", "name": "Статус", "icon": "📌", "propertyType": found.property_type,
            "value": "Готово", "settings": found.settings
        }]}}))
        .unwrap(),
    );
    run(&fx.conn, &fx.vault, &Context::default()).unwrap();
    assert_eq!(fx.props(&id(1))["Статус"], json!({"icon": "📌"}));
    let shown = panel(&fx.conn, &fx.vault, &id(1)).unwrap();
    assert_eq!(shown.active[0].icon, "📌");
}
