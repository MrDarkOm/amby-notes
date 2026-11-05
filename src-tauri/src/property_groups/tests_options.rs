//! Options of a select (docs/sync-plan.md, З62): the new form of `settings` is JSON, the old one a
//! comma list; a value outside the options is judged by either form. Written with the code.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::header::{options_of, outside_options, same_settings};
use crate::property_template::lookup;

#[test]
fn both_forms_give_the_same_options() {
    assert_eq!(
        options_of(r#"{"options":["А, Б","В"],"default":"В"}"#),
        vec!["А, Б", "В"]
    );
    assert_eq!(
        options_of("Идея, В работе ,Готово"),
        vec!["Идея", "В работе", "Готово"]
    );
    assert!(options_of("").is_empty());
}

#[test]
fn a_value_is_outside_the_options_by_either_form() {
    assert!(outside_options("Г", "select", r#"{"options":["А","Б"]}"#));
    assert!(!outside_options("Б", "select", r#"{"options":["А","Б"]}"#));
    assert!(!outside_options("Б", "select", "А,Б"));
    assert!(!outside_options("что угодно", "text", "А,Б"));
}

#[test]
fn the_same_options_in_the_two_forms_are_not_a_difference() {
    assert!(same_settings(
        "Идея,Готово",
        r#"{"options":["Идея","Готово"]}"#
    ));
    assert!(!same_settings(
        "Идея,Готово",
        r#"{"options":["Идея","Готово"],"default":"Идея"}"#
    ));
}

#[test]
fn the_template_keeps_its_options_in_the_new_form() {
    let status = lookup("Status").unwrap();
    assert!(status.settings.starts_with('{'), "{}", status.settings);
    assert_eq!(
        options_of(&status.settings),
        vec!["Idea", "In progress", "Done"]
    );
}
