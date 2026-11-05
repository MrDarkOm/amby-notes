//! Which key of the header a property is, and what the panel and the edits do when the header
//! cannot be trusted (docs/sync-plan.md, appendix З: З1, З24–З27). Red until written.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::testkit::*;
use super::*;

fn header(lines: &str) -> String {
    format!("---\namby-id: {}\n{lines}---\nТекст\n", id(1))
}

fn found(key: &str, value: &str) -> KeyMatch {
    KeyMatch::Found {
        key: key.to_string(),
        value: value.to_string(),
        complex: false,
    }
}

// ----- З1, З24: the matching of a name to a key -----

#[test]
fn the_exact_key_is_found_with_its_value() {
    // З1
    assert_eq!(
        match_key(&header("Статус: Готово\n"), "Статус", None),
        found("Статус", "Готово")
    );
    assert_eq!(
        match_key(&header("Автор: x\n"), "Статус", None),
        KeyMatch::Missing
    );
    assert_eq!(
        match_key("Просто текст", "Статус", None),
        KeyMatch::Missing,
        "no header at all"
    );
}

#[test]
fn the_only_key_that_differs_in_ascii_case_is_found_with_its_own_spelling() {
    // З1, З24
    assert_eq!(
        match_key(&header("status: x\n"), "Status", None),
        found("status", "x")
    );
    assert_eq!(
        match_key(&header("STATUS: x\n"), "Status", None),
        found("STATUS", "x")
    );
}

#[test]
fn an_exact_key_wins_over_keys_that_differ_in_case() {
    // З1: «сначала точное совпадение»
    assert_eq!(
        match_key(&header("Status: a\nstatus: b\n"), "Status", None),
        found("Status", "a")
    );
}

#[test]
fn several_keys_that_differ_only_in_case_are_ambiguous() {
    // З1: shown empty with a warning, nothing is written
    let answer = match_key(&header("STATUS: a\nstatus: b\n"), "Status", None);
    let KeyMatch::Ambiguous { mut keys } = answer else {
        panic!("{answer:?}")
    };
    keys.sort();
    assert_eq!(keys, vec!["STATUS".to_string(), "status".to_string()]);
}

#[test]
fn only_ascii_letters_fold_case() {
    // З1, З24: «Статус» and «статус» are different keys
    assert_eq!(
        match_key(&header("статус: x\n"), "Статус", None),
        KeyMatch::Missing
    );
}

#[test]
fn a_header_written_in_nfd_matches_a_name_in_nfc_and_keeps_its_spelling() {
    // З24: macOS writes NFD; the bytes of the header are never changed by matching
    let nfc = "Ёж"; // U+0401 U+0436
    let nfd = "Е\u{308}ж"; // U+0415 U+0308 U+0436
    assert_ne!(nfc, nfd);
    assert_eq!(
        match_key(&header(&format!("{nfd}: v\n")), nfc, None),
        found(nfd, "v")
    );
    assert_eq!(
        match_key(&header(&format!("{nfc}: v\n")), nfd, None),
        found(nfc, "v")
    );
}

#[test]
fn keys_that_yaml_does_not_read_as_strings_are_never_matched() {
    // З24: numbers and booleans as keys are ordinary lines of the header
    assert_eq!(
        match_key(&header("1: a\ntrue: b\n2.5: c\n"), "1", None),
        KeyMatch::Missing
    );
    assert_eq!(
        match_key(&header("1: a\ntrue: b\n2.5: c\n"), "true", None),
        KeyMatch::Missing
    );
    assert_eq!(
        match_key(&header("1: a\ntrue: b\n2.5: c\n"), "2.5", None),
        KeyMatch::Missing
    );
    assert_eq!(
        match_key(&header("\"1\": a\n"), "1", None),
        found("1", "a"),
        "a quoted key is a string"
    );
}

#[test]
fn keys_of_amby_are_never_matched() {
    // З24
    assert_eq!(
        match_key(&header("amby-title: T\n"), "amby-title", None),
        KeyMatch::Missing
    );
    assert_eq!(match_key(&header(""), "amby-id", None), KeyMatch::Missing);
    assert_eq!(
        match_key(&header("AMBY-views: v\n"), "AMBY-views", None),
        KeyMatch::Missing
    );
}

#[test]
fn previous_name_is_used_only_when_the_new_name_is_not_in_the_header() {
    // З29
    assert_eq!(
        match_key(&header("Старое: v\n"), "Новое", Some("Старое")),
        found("Старое", "v")
    );
    assert_eq!(
        match_key(
            &header("Новое: new\nСтарое: old\n"),
            "Новое",
            Some("Старое")
        ),
        found("Новое", "new"),
        "both keys: `name` wins"
    );
    assert_eq!(
        match_key(&header(""), "Новое", Some("Старое")),
        KeyMatch::Missing
    );
}

#[test]
fn a_value_that_cannot_be_rewritten_without_loss_is_complex() {
    // З26: multiline, block string, anchor
    for lines in [
        "Описание: |\n  первая\n  вторая\n",
        "Описание: >\n  первая\n  вторая\n",
        "Описание: &якорь значение\n",
        "Описание: \"первая\n  вторая\"\n",
    ] {
        let answer = match_key(&header(lines), "Описание", None);
        assert!(
            matches!(answer, KeyMatch::Found { complex: true, .. }),
            "{lines:?} → {answer:?}"
        );
    }
    assert!(matches!(
        match_key(&header("Метки: [a, b]\n"), "Метки", None),
        KeyMatch::Found { complex: false, .. }
    ));
}

#[test]
fn a_header_that_cannot_be_read_is_unreadable_for_matching() {
    // З25
    for text in [
        "---\namby-id: X\nA: b\n".to_string(),
        "---\n: : :\n  - [\n---\nТекст\n".to_string(),
        "---\n- a\n- b\n---\nТекст\n".to_string(),
        "---\namby-id: X\nA: 1\nA: 2\n---\nТекст\n".to_string(),
    ] {
        assert_eq!(
            match_key(&text, "A", None),
            KeyMatch::HeaderUnreadable,
            "{text:?}"
        );
    }
}

// ----- З25: the panel does not guess when the header or the identity is bad -----

struct Case {
    label: &'static str,
    setup: fn(&Fx, &str),
}

const CASES: [Case; 7] = [
    Case {
        label: "unterminated header",
        setup: |fx, id| {
            fx.note_raw(
                id,
                "N.md",
                &format!("---\namby-id: {id}\nЗаказчик: Иван\nТекст\n"),
            )
        },
    },
    Case {
        label: "invalid yaml",
        setup: |fx, id| {
            fx.note_raw(
                id,
                "N.md",
                &format!("---\namby-id: {id}\n: : :\n  - [\n---\nТекст\n"),
            )
        },
    },
    Case {
        label: "root is not a mapping",
        setup: |fx, id| fx.note_raw(id, "N.md", "---\n- a\n- b\n---\nТекст\n"),
    },
    Case {
        label: "repeated key",
        setup: |fx, id| {
            fx.note_raw(
                id,
                "N.md",
                &format!("---\namby-id: {id}\nЗаказчик: 1\nЗаказчик: 2\n---\nТекст\n"),
            )
        },
    },
    Case {
        label: "no amby-id",
        setup: |fx, id| fx.note_raw(id, "N.md", "---\nЗаказчик: Иван\n---\nТекст\n"),
    },
    Case {
        label: "duplicate amby-id",
        setup: |fx, id| {
            fx.note(id, "N.md", "Заказчик: Иван\n");
            fx.make_duplicate_id(id)
        },
    },
    Case {
        label: "file missing",
        setup: |fx, id| {
            fx.note(id, "N.md", "Заказчик: Иван\n");
            std::fs::remove_file(fx.vault.join("N.md")).unwrap()
        },
    },
];

#[test]
fn when_the_header_or_the_identity_is_bad_nothing_is_sleeping_nothing_is_offered_and_nothing_is_written(
) {
    // З25: one typo in the header must not show every record grey and offer to delete it
    for case in CASES {
        let fx = fx();
        let note = id(1);
        fx.note(&note, "N.md", "Заказчик: Иван\n");
        create_property(&fx.conn, &fx.vault, &note, design("Заказчик"), "Иван").unwrap();
        (case.setup)(&fx, &note);
        let before = fx.snapshot();
        let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
        assert!(shown.unreadable, "{}", case.label);
        assert!(
            shown.dormant.is_empty(),
            "{}: no sleeping records",
            case.label
        );
        assert!(shown.rename_hint.is_none(), "{}: no hint", case.label);
        let rename = RenameHint {
            old_name: "Заказчик".into(),
            new_name: "Клиент".into(),
        };
        let name = "Заказчик";
        let results = [
            create_property(&fx.conn, &fx.vault, &note, design("Автор"), "x").is_err(),
            rename_property(&fx.conn, &fx.vault, &note, name, "Клиент").is_err(),
            set_value(&fx.conn, &fx.vault, &note, name, "x").is_err(),
            change_type(&fx.conn, &fx.vault, &note, name, "number").is_err(),
            set_appearance(&fx.conn, &fx.vault, &note, name, "🔥", "").is_err(),
            reorder(&fx.conn, &fx.vault, &note, &[name.to_string()]).is_err(),
            delete_property(&fx.conn, &fx.vault, &note, name).is_err(),
            restore_dormant(&fx.conn, &fx.vault, &note, name).is_err(),
            purge_dormant(&fx.conn, &fx.vault, &note, name).is_err(),
            accept_rename_hint(&fx.conn, &fx.vault, &note, &rename).is_err(),
            dismiss_rename_hint(&fx.conn, &fx.vault, &note, &rename).is_err(),
        ];
        assert!(
            results.iter().all(|refused| *refused),
            "{}: {results:?}",
            case.label
        );
        assert_eq!(
            fx.snapshot(),
            before,
            "{}: not a byte was written",
            case.label
        );
    }
}

#[test]
fn ambiguous_keys_show_the_property_empty_with_a_warning_and_write_nothing() {
    // З1
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    create_property(&fx.conn, &fx.vault, &note, design("Status2"), "x").unwrap();
    fx.note(&note, "N.md", "STATUS2: a\nstatus2: b\n");
    let before = fx.snapshot();
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert!(shown.warnings.contains(&PanelWarning::AmbiguousKey {
        name: "Status2".into()
    }));
    assert!(shown.dormant.is_empty(), "not a sleeping record");
    let status = shown
        .active
        .iter()
        .find(|p| p.name == "Status2")
        .expect("the property is shown");
    assert_eq!(status.value, "");
    assert!(set_value(&fx.conn, &fx.vault, &note, "Status2", "z").is_err());
    assert_eq!(fx.snapshot(), before);
}

#[test]
fn a_value_is_written_into_the_found_spelling_and_makes_no_second_key() {
    // З24: the old upsert wrote under the name of the record and made a second key
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "STATUS2: old\nАвтор: я\n");
    put_entry(
        &fx.conn,
        &fx.vault,
        &note,
        Some(entry_of(&note, &[("Status2", "1")])),
    )
    .unwrap();
    set_value(&fx.conn, &fx.vault, &note, "Status2", "new").unwrap();
    let text = fx.read("N.md");
    assert!(text.contains("STATUS2: new"), "{text}");
    assert!(!text.contains("Status2:"), "{text}");
    assert!(text.contains("Автор: я"), "the other lines are untouched");
}

#[test]
fn a_value_in_an_nfd_key_is_written_into_that_same_key() {
    // З24
    let fx = fx();
    let note = id(1);
    let nfd = "Е\u{308}ж";
    fx.note(&note, "N.md", &format!("{nfd}: старое\n"));
    put_entry(
        &fx.conn,
        &fx.vault,
        &note,
        Some(entry_of(&note, &[("Ёж", "1")])),
    )
    .unwrap();
    set_value(&fx.conn, &fx.vault, &note, "Ёж", "новое").unwrap();
    assert_eq!(
        fx.read("N.md"),
        format!("---\namby-id: {}\n{nfd}: новое\n---\nТекст\n", note)
    );
}

#[test]
fn bom_and_line_endings_of_the_note_survive_a_value_edit() {
    // З1: the same lossless writer as now
    let fx = fx();
    let note = id(1);
    fx.note_raw(
        &note,
        "N.md",
        &format!("\u{feff}---\r\namby-id: {note}\r\nЗаказчик: Идея\r\n---\r\nТекст\r\n"),
    );
    create_property(&fx.conn, &fx.vault, &note, design("Заказчик"), "Идея").unwrap();
    set_value(&fx.conn, &fx.vault, &note, "Заказчик", "Готово").unwrap();
    assert_eq!(
        fx.read("N.md"),
        format!("\u{feff}---\r\namby-id: {note}\r\nЗаказчик: Готово\r\n---\r\nТекст\r\n")
    );
}

#[test]
fn the_name_of_a_property_may_not_start_with_amby() {
    // З24: refused on create and on rename; no write
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    create_property(&fx.conn, &fx.vault, &note, design("Заказчик"), "").unwrap();
    let before = fx.snapshot();
    for name in ["amby-test", "AMBY-views", "amby-"] {
        assert!(
            create_property(&fx.conn, &fx.vault, &note, design(name), "").is_err(),
            "{name}"
        );
        assert!(
            rename_property(&fx.conn, &fx.vault, &note, "Заказчик", name).is_err(),
            "{name}"
        );
    }
    assert_eq!(fx.snapshot(), before);
}

// ----- З26: values that cannot be rewritten -----

#[test]
fn a_complex_value_is_read_only_and_its_edits_and_rename_are_refused_before_any_write() {
    // З26
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "Описание: |\n  первая\n  вторая\n");
    put_entry(
        &fx.conn,
        &fx.vault,
        &note,
        Some(entry_of(&note, &[("Описание", "1")])),
    )
    .unwrap();
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert!(shown.active[0].read_only);
    let before = fx.snapshot();
    assert!(set_value(&fx.conn, &fx.vault, &note, "Описание", "x").is_err());
    assert!(rename_property(&fx.conn, &fx.vault, &note, "Описание", "Другое").is_err());
    assert_eq!(fx.snapshot(), before);
    assert!(
        fx.files_under(".amby/property-ops/").is_empty(),
        "no journal either"
    );
}

#[test]
fn a_type_change_that_cannot_convert_the_value_keeps_the_value_and_says_so() {
    // З26: text «abc» to a checkbox
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    create_property(&fx.conn, &fx.vault, &note, design("Флаг"), "abc").unwrap();
    let before = fx.read("N.md");
    change_type(&fx.conn, &fx.vault, &note, "Флаг", "checkbox").unwrap();
    assert_eq!(fx.read("N.md"), before, "the header is not rewritten");
    assert_eq!(fx.props(&note)["Флаг"]["propertyType"], "checkbox");
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(shown.active[0].value, "abc");
    assert!(shown.active[0].type_mismatch);
}

#[test]
fn a_type_change_with_a_reversible_conversion_rewrites_the_value() {
    // З26
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    create_property(&fx.conn, &fx.vault, &note, design("Счёт"), "5").unwrap();
    change_type(&fx.conn, &fx.vault, &note, "Счёт", "number").unwrap();
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(shown.active[0].value, "5");
    assert!(!shown.active[0].type_mismatch);
    assert!(fx.read("N.md").contains("Счёт: 5\n"), "{}", fx.read("N.md"));
}

// ----- З27: databases -----

#[test]
fn backup_and_clear_copies_the_line_to_property_backups_before_removing_it() {
    // З27
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    create_property(
        &fx.conn,
        &fx.vault,
        &note,
        design_typed("Заказчик", "select", "А,Б"),
        "А",
    )
    .unwrap();
    let rel = backup_and_clear(&fx.conn, &fx.vault, &note).unwrap();
    assert!(
        rel.starts_with(&format!(".amby/property-backups/{note}/")) && rel.ends_with(".json"),
        "{rel}"
    );
    let copy: serde_json::Value = serde_json::from_slice(&fx.bytes(&rel).unwrap()).unwrap();
    assert_eq!(copy["noteId"], note.as_str());
    assert!(
        copy.to_string().contains("Заказчик") && copy.to_string().contains("select"),
        "the differences are in the copy"
    );
    assert!(read_entry(&fx.vault, &note).unwrap().is_none());
    assert!(
        fx.read("N.md").contains("Заказчик: А"),
        "the keys of the header are not touched"
    );
    assert!(
        backup_and_clear(&fx.conn, &fx.vault, &note).is_err(),
        "nothing left to back up"
    );
}

#[test]
fn a_failed_write_after_the_backup_leaves_the_line_and_the_copy() {
    // З27, З34: the copy is first; losing the file write loses nothing
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    create_property(&fx.conn, &fx.vault, &note, design("Заказчик"), "А").unwrap();
    let result = with_failing_write(1, false, || backup_and_clear(&fx.conn, &fx.vault, &note));
    assert!(result.is_err());
    assert!(fx.line(&note).is_some(), "the line is still in the file");
    assert_eq!(
        fx.files_under(&format!(".amby/property-backups/{note}/"))
            .len(),
        1
    );
}

#[test]
fn a_leftover_record_on_a_database_page_is_not_applied_to_the_keys_of_the_database() {
    // З27: the page's header keys of the database belong to the database
    let fx = fx();
    let note = id(1);
    fx.note(
        &note,
        "База.md",
        "amby-database: tasks\namby-views: v\nЗаказчик: Иван\n",
    );
    put_entry(
        &fx.conn,
        &fx.vault,
        &note,
        Some(entry_of(&note, &[("amby-database", "1")])),
    )
    .unwrap();
    let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
    assert!(shown.active.iter().all(|p| !p.key.starts_with("amby-")));
    let report = inspect(&fx.conn, &fx.vault).unwrap();
    assert!(report
        .reserved_names
        .contains(&(note, "amby-database".to_string())));
}
