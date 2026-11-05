//! Migration from `properties.json` to the groups (docs/sync-plan.md, appendix З: З19–З22, З38–З42).
//! Red until written.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::migration::*;
use super::testkit::*;
use super::*;

fn old_prop(id: &str, name: &str, ty: &str, value: &str, settings: &str) -> Value {
    json!({"id": id, "name": name, "icon": "📌", "propertyType": ty, "value": value, "settings": settings})
}

fn write_old_file(fx: &Fx, notes: &[(&str, Vec<Value>)]) {
    let map: serde_json::Map<String, Value> = notes
        .iter()
        .map(|(id, props)| (id.to_string(), json!(props)))
        .collect();
    let mut text = serde_json::to_string_pretty(&json!({"version": 1, "notes": map})).unwrap();
    text.push('\n');
    fx.write(".amby/properties.json", &text);
}

fn plain_context() -> Context {
    Context::default()
}

const N_SAME: u32 = 1;
const N_DIFF: u32 = 2;
const N_NOKEY: u32 = 3;
const N_BROKEN: u32 = 4;
const N_NOID: u32 = 5;
const N_DUP: u32 = 6;
const N_ORPHAN: u32 = 7;
const N_EMPTYKEY: u32 = 8;

/// A vault before the migration with one note for each case of the report.
fn old_vault() -> Fx {
    let fx = fx_old();
    fx.note(&id(N_SAME), "same.md", "Заказчик: Готово\n");
    fx.note(&id(N_DIFF), "diff.md", "Заказчик: Б\n");
    fx.note(&id(N_NOKEY), "nokey.md", "");
    fx.note_raw(
        &id(N_BROKEN),
        "broken.md",
        &format!(
            "---\namby-id: {}\nЗаказчик: Готово\nТекст без закрытия\n",
            id(N_BROKEN)
        ),
    );
    fx.note_raw(
        &id(N_NOID),
        "noid.md",
        "---\nЗаказчик: Готово\n---\nТекст\n",
    );
    fx.note(&id(N_DUP), "dup.md", "Заказчик: Готово\n");
    fx.make_duplicate_id(&id(N_DUP));
    fx.note(&id(N_EMPTYKEY), "emptykey.md", "");
    write_old_file(
        &fx,
        &[
            (
                &id(N_SAME),
                vec![old_prop(
                    "P1",
                    "Заказчик",
                    "select",
                    "Готово",
                    "Идея,Готово",
                )],
            ),
            (
                &id(N_DIFF),
                vec![old_prop("P2", "Заказчик", "select", "А", "А,Б")],
            ),
            (
                &id(N_NOKEY),
                vec![old_prop("P3", "Автор", "text", "Иван", "")],
            ),
            (
                &id(N_BROKEN),
                vec![old_prop("P4", "Заказчик", "text", "Готово", "")],
            ),
            (
                &id(N_NOID),
                vec![old_prop("P5", "Заказчик", "text", "Готово", "")],
            ),
            (
                &id(N_DUP),
                vec![old_prop("P6", "Заказчик", "text", "Готово", "")],
            ),
            (
                &id(N_ORPHAN),
                vec![old_prop("P7", "Сирота", "text", "x", "")],
            ),
            (
                &id(N_EMPTYKEY),
                vec![old_prop("P8", "Пусто", "text", "", "")],
            ),
        ],
    );
    fx
}

fn migrated_files(snapshot: &BTreeMap<String, Vec<u8>>) -> BTreeMap<String, Vec<u8>> {
    snapshot
        .iter()
        .filter(|(path, _)| {
            !path.starts_with(".amby/migrations/") && !path.starts_with(".amby/history/")
        })
        .map(|(p, b)| (p.clone(), b.clone()))
        .collect()
}

// ----- З19: the dry run -----

#[test]
fn the_dry_run_writes_not_a_single_file() {
    // З19: no group, no layout, no journal, no `.amby/migrations`, no change in any note
    let fx = old_vault();
    let before = fx.snapshot();
    let (report, writes) = count_writes(|| preview(&fx.conn, &fx.vault));
    report.unwrap();
    assert_eq!(writes, 0);
    assert_eq!(fx.snapshot(), before);
    assert!(!fx.exists(".amby/migrations") && !fx.exists(".amby/properties"));
}

#[test]
fn the_report_counts_and_names_every_case() {
    // З19, З20, З25
    let fx = old_vault();
    let r = preview(&fx.conn, &fx.vault).unwrap();
    assert_eq!((r.notes, r.properties), (8, 8));
    assert!(
        r.same >= 1,
        "the matching value of the first note is counted"
    );
    assert_eq!(
        r.mismatches,
        vec![Mismatch {
            note_id: id(N_DIFF),
            name: "Заказчик".into(),
            file_value: "А".into(),
            header_value: "Б".into(),
        }]
    );
    assert_eq!(
        r.missing_keys,
        vec![MissingKey {
            note_id: id(N_NOKEY),
            name: "Автор".into(),
            file_value: "Иван".into(),
        }]
    );
    let mut untouchable = r.untouchable.clone();
    untouchable.sort_by_key(|(note, _)| note.clone());
    assert_eq!(
        untouchable,
        vec![
            (id(N_BROKEN), Untouchable::MalformedHeader),
            (id(N_NOID), Untouchable::NoId),
            (id(N_DUP), Untouchable::DuplicateId),
        ]
    );
    assert_eq!(r.orphans, vec![id(N_ORPHAN)]);
    assert_eq!(r.header_edits, 1, "only the missing key writes a header");
    assert!(
        r.warnings.iter().any(|w| w.contains(OLD_VERSION_WARNING)),
        "{:?}",
        r.warnings
    );
}

#[test]
fn a_value_equal_by_the_meaning_of_yaml_is_the_same_value() {
    // З40: lists, flags, numbers and empty values must not all land in «расходится»
    let cases: [(&str, &str, &str); 12] = [
        ("checkbox", "true", "Флаг: true\n"),
        ("checkbox", "false", "Флаг: false\n"),
        ("number", "5", "Счёт: 5\n"),
        ("list", "a, b", "Метки: [a, b]\n"),
        ("list", "a, b", "Метки:\n  - a\n  - b\n"),
        ("text", "", "Пусто:\n"),
        ("text", "", "Пусто: \"\"\n"),
        ("text", "", "Пусто: null\n"),
        ("text", "x", "Имя: x\n"),
        ("text", "x", "Имя: \"x\"\n"),
        ("list", "", "Метки: []\n"),
        ("text", "", ""),
    ];
    for (ty, value, line) in cases {
        let fx = fx_old();
        let key = line
            .split(':')
            .next()
            .filter(|k| !k.is_empty())
            .unwrap_or("Имя");
        fx.note(&id(1), "n.md", line);
        write_old_file(&fx, &[(&id(1), vec![old_prop("P", key, ty, value, "")])]);
        let r = preview(&fx.conn, &fx.vault).unwrap();
        assert!(
            r.mismatches.is_empty(),
            "{ty} {value:?} vs {line:?}: {:?}",
            r.mismatches
        );
        if !line.is_empty() {
            assert_eq!(r.same, 1, "{ty} {value:?} vs {line:?} is the same value");
        }
        assert!(
            r.missing_keys.is_empty() || line.is_empty(),
            "{ty} {value:?} vs {line:?}"
        );
    }
    // a real difference is still one
    let fx = fx_old();
    fx.note(&id(1), "n.md", "Флаг: false\n");
    write_old_file(
        &fx,
        &[(&id(1), vec![old_prop("P", "Флаг", "checkbox", "true", "")])],
    );
    assert_eq!(preview(&fx.conn, &fx.vault).unwrap().mismatches.len(), 1);
}

#[test]
fn an_unreadable_old_file_or_another_version_starts_nothing() {
    // З41
    for content in ["not-json", "{\"version\":2,\"notes\":{}}"] {
        let fx = old_vault();
        fx.write(".amby/properties.json", content);
        let before = fx.snapshot();
        assert!(preview(&fx.conn, &fx.vault).is_err(), "{content}");
        assert!(
            run(&fx.conn, &fx.vault, &plain_context()).is_err(),
            "{content}"
        );
        assert_eq!(fx.snapshot(), before, "{content}");
    }
}

// ----- З20, З21, З22, З39: the run -----

#[test]
fn the_vault_is_migrated_by_itself_at_the_first_opening_with_no_question() {
    // З57: no confirmation — the opening decides; groups, layout and the outcome appear
    let fx = old_vault();
    assert_eq!(storage_mode(&fx.vault).unwrap(), StorageMode::Legacy);
    let OpenOutcome::Migrated(outcome) = open_vault(&fx.conn, &fx.vault, &plain_context()).unwrap()
    else {
        panic!("the opening must migrate");
    };
    assert_eq!(storage_mode(&fx.vault).unwrap(), StorageMode::Groups);
    assert!(outcome.groups_written > 0 && !outcome.migration_id.is_empty());
    assert!(fx.exists(".amby/properties/layout.json"));
    assert!(
        fx.read("nokey.md").contains("Автор: Иван"),
        "the report of З19 was applied (З20)"
    );
    // a second opening has nothing to do and writes nothing
    let before = fx.snapshot();
    assert_eq!(
        open_vault(&fx.conn, &fx.vault, &plain_context()).unwrap(),
        OpenOutcome::AlreadyGroups
    );
    assert_eq!(fx.snapshot(), before);
}

#[test]
fn the_opening_does_not_migrate_where_the_conditions_of_the_sync_say_no() {
    // З57, З38: sync on and no successful pass — the properties wait, read only; `layout.json`
    // came from the server — no migration of our own
    let fx = old_vault();
    let before = fx.snapshot();
    let waiting = Context {
        sync_enabled: true,
        last_pass_ok: false,
        ..Context::default()
    };
    assert_eq!(
        open_vault(&fx.conn, &fx.vault, &waiting).unwrap(),
        OpenOutcome::ReadOnly(ReadOnlyReason::WaitingForSync)
    );
    assert_eq!(fx.snapshot(), before);
    let shown = panel(&fx.conn, &fx.vault, &id(N_SAME)).unwrap();
    assert!(
        shown.read_only,
        "З57: for the time of the migration the properties are for reading only"
    );
    assert!(create_property(&fx.conn, &fx.vault, &id(N_SAME), design("Автор"), "x").is_err());
    assert_eq!(fx.snapshot(), before);
    let arrived = Context {
        sync_enabled: true,
        last_pass_ok: true,
        layout_came_from_server: true,
        ..Context::default()
    };
    assert_eq!(
        open_vault(&fx.conn, &fx.vault, &arrived).unwrap(),
        OpenOutcome::ArrivedFromServer
    );
    assert_eq!(fx.snapshot(), before);
    let ready = Context {
        sync_enabled: true,
        last_pass_ok: true,
        ..Context::default()
    };
    assert!(matches!(
        open_vault(&fx.conn, &fx.vault, &ready).unwrap(),
        OpenOutcome::Migrated(_)
    ));
}

#[test]
fn a_crash_at_any_write_of_the_opening_is_finished_by_the_next_opening() {
    // З57, З41: the repeat goes by the journal and gives the bytes of an uninterrupted run
    let reference = old_vault();
    open_vault(&reference.conn, &reference.vault, &plain_context()).unwrap();
    let expected = migrated_files(&reference.snapshot());
    let mut crashed = false;
    for (n, after) in (1..=14).flat_map(|n| [(n, false), (n, true)]) {
        let fx = old_vault();
        let result = with_failing_write(n, after, || {
            open_vault(&fx.conn, &fx.vault, &plain_context())
        });
        if result.is_err() {
            crashed = true;
            assert!(
                !fx.exists(".amby/properties/layout.json"),
                "crash at {n}/{after}: the layout is last"
            );
            assert!(matches!(
                open_vault(&fx.conn, &fx.vault, &plain_context()).unwrap(),
                OpenOutcome::Migrated(_)
            ));
        }
        assert_eq!(
            migrated_files(&fx.snapshot()),
            expected,
            "crash at {n}/{after}"
        );
    }
    assert!(crashed);
}

#[test]
fn an_unreadable_old_file_leaves_the_properties_read_only_and_writes_nothing() {
    // З59: unreadable or another version — no migration, no layout, no edits
    for content in ["not-json", "{\"version\":2,\"notes\":{}}"] {
        let fx = old_vault();
        fx.write(".amby/properties.json", content);
        let before = fx.snapshot();
        assert_eq!(
            open_vault(&fx.conn, &fx.vault, &plain_context()).unwrap(),
            OpenOutcome::ReadOnly(ReadOnlyReason::UnreadableOldFile),
            "{content}"
        );
        assert_eq!(fx.snapshot(), before, "{content}: not a byte was written");
        assert_eq!(storage_mode(&fx.vault).unwrap(), StorageMode::Legacy);
        let shown = panel(&fx.conn, &fx.vault, &id(N_SAME)).unwrap();
        assert!(shown.read_only, "{content}");
        assert!(
            shown.active.iter().any(|p| p.name == "Заказчик"),
            "{content}: the keys of the header are shown"
        );
        let note = id(N_SAME);
        let refused = [
            create_property(&fx.conn, &fx.vault, &note, design("Автор"), "x").is_err(),
            set_value(&fx.conn, &fx.vault, &note, "Заказчик", "x").is_err(),
            rename_property(&fx.conn, &fx.vault, &note, "Заказчик", "Клиент").is_err(),
            set_appearance(&fx.conn, &fx.vault, &note, "Заказчик", "🔥", "").is_err(),
            delete_property(&fx.conn, &fx.vault, &note, "Заказчик").is_err(),
        ];
        assert!(refused.iter().all(|r| *r), "{content}: {refused:?}");
        assert_eq!(fx.snapshot(), before, "{content}");
    }
}

#[test]
fn a_run_applies_every_decision_of_the_report() {
    // З20, З21, З22, З39
    let fx = old_vault();
    let old_file = fx.bytes(".amby/properties.json").unwrap();
    let before = fx.snapshot();
    let outcome = run(&fx.conn, &fx.vault, &plain_context()).unwrap();
    // matching: the value is not carried and the header stays
    assert_eq!(fx.bytes("same.md"), before.get("same.md").cloned());
    // the missing key with a value is written into the header
    assert!(fx.read("nokey.md").contains("Автор: Иван"));
    assert_eq!(outcome.headers_written, vec![id(N_NOKEY)]);
    // a diverging value: the header wins by default
    assert_eq!(fx.bytes("diff.md"), before.get("diff.md").cloned());
    // the damaged, the id-less and the duplicate notes are not touched, their designs are carried
    for rel in ["broken.md", "noid.md", "dup.md", "emptykey.md"] {
        assert_eq!(fx.bytes(rel), before.get(rel).cloned(), "{rel}");
    }
    for (note, name) in [
        (N_BROKEN, "Заказчик"),
        (N_NOID, "Заказчик"),
        (N_DUP, "Заказчик"),
        (N_ORPHAN, "Сирота"),
        (N_EMPTYKEY, "Пусто"),
        (N_SAME, "Заказчик"),
    ] {
        assert!(
            fx.prop_names(&id(note)).contains(&name.to_string()),
            "the differences of {name} of note {note} were carried"
        );
    }
    // only differences are carried: type, settings, icon — no value, no id of the property
    let d = fx.props(&id(N_SAME))["Заказчик"].clone();
    assert_eq!(
        (
            d["propertyType"].as_str(),
            d["settings"].as_str(),
            d["icon"].as_str()
        ),
        (Some("select"), Some("Идея,Готово"), Some("📌"))
    );
    assert!(d.get("value").is_none() && d.get("id").is_none());
    let text = String::from_utf8(fx.group_bytes(&id(N_SAME)).unwrap()).unwrap();
    assert!(
        !text.contains("\"P1\"") && !text.contains("value"),
        "{text}"
    );
    // the old file is neither deleted nor changed
    assert_eq!(fx.bytes(".amby/properties.json"), Some(old_file));
    // the layout is there and the vault is in the new format
    assert_eq!(storage_mode(&fx.vault).unwrap(), StorageMode::Groups);
    assert!(outcome.groups_written > 0);
}

#[test]
fn the_outcome_lists_the_notes_whose_values_differed_and_the_header_value_is_kept() {
    // З58: «Расходились значения у N заметок, оставлены значения из шапки»
    let fx = old_vault();
    let outcome = run(&fx.conn, &fx.vault, &plain_context()).unwrap();
    assert_eq!(outcome.diverged.len(), 1);
    assert_eq!(outcome.diverged[0].note_id, id(N_DIFF));
    assert_eq!(
        (
            outcome.diverged[0].file_value.as_str(),
            outcome.diverged[0].header_value.as_str()
        ),
        ("А", "Б")
    );
    assert!(
        fx.read("diff.md").contains("Заказчик: Б"),
        "the header wins"
    );
}

#[test]
fn take_the_value_from_the_old_file_is_an_ordinary_edit_of_the_value_and_nothing_else() {
    // З58, З1
    let fx = old_vault();
    run(&fx.conn, &fx.vault, &plain_context()).unwrap();
    let before = fx.snapshot();
    take_file_value(&fx.conn, &fx.vault, &id(N_DIFF), "Заказчик").unwrap();
    assert!(
        fx.read("diff.md").contains("Заказчик: А"),
        "{}",
        fx.read("diff.md")
    );
    assert_eq!(
        changed_paths(&before, &fx.snapshot()),
        vec!["diff.md".to_string()],
        "only the note"
    );
    let after = fx.snapshot();
    assert!(take_file_value(&fx.conn, &fx.vault, &id(N_DIFF), "Нет такого").is_err());
    assert_eq!(fx.snapshot(), after);
}

#[test]
fn copies_and_the_journal_are_made_before_the_first_change() {
    // З21, З41: `.amby/migrations/<id>/` holds `properties.json` and every edited note as they were
    let fx = old_vault();
    let old_file = fx.bytes(".amby/properties.json").unwrap();
    let old_note = fx.bytes("nokey.md").unwrap();
    let outcome = run(&fx.conn, &fx.vault, &plain_context()).unwrap();
    let prefix = format!(".amby/migrations/{}/", outcome.migration_id);
    let files = fx
        .snapshot()
        .into_iter()
        .filter(|(p, _)| p.starts_with(&prefix))
        .collect::<Vec<_>>();
    assert!(
        files.iter().any(|(_, b)| *b == old_file),
        "a copy of properties.json"
    );
    assert!(
        files.iter().any(|(_, b)| *b == old_note),
        "a copy of the note whose header was edited"
    );
    assert!(
        files.len() >= 3,
        "also the journal: {:?}",
        files.iter().map(|f| &f.0).collect::<Vec<_>>()
    );
    assert!(
        !files.iter().any(|(p, _)| p.contains("same.md")),
        "a note whose header is not edited has no copy"
    );
}

#[test]
fn an_empty_migration_writes_the_layout() {
    // З41: no `properties.json` — nothing to carry; the layout is written before the first group
    let fx = fx_old();
    fx.note(&id(1), "n.md", "");
    let outcome = run(&fx.conn, &fx.vault, &plain_context()).unwrap();
    assert_eq!(outcome.groups_written, 0);
    assert_eq!(storage_mode(&fx.vault).unwrap(), StorageMode::Groups);
    assert!(fx
        .files_under(".amby/properties/")
        .iter()
        .all(|p| p.ends_with("layout.json")));
}

#[test]
fn two_computers_that_migrate_the_same_vault_write_the_same_bytes() {
    // З39: the files and the layout, apart from `hint` (which never conflicts, З31)
    let a = old_vault();
    let b = a.copy_to_second_device(&[]);
    run(&a.conn, &a.vault, &plain_context()).unwrap();
    run(&b.conn, &b.vault, &plain_context()).unwrap();
    let strip = |fx: &Fx| -> BTreeMap<String, Vec<Value>> {
        fx.files_under(".amby/properties/")
            .into_iter()
            .filter(|p| p.ends_with(".jsonl"))
            .map(|path| {
                let text = String::from_utf8(fx.bytes(&path).unwrap()).unwrap();
                let lines = text
                    .lines()
                    .map(|l| {
                        let mut v: Value = serde_json::from_str(l).unwrap();
                        if let Some(o) = v.as_object_mut() {
                            o.remove("hint");
                        }
                        v
                    })
                    .collect();
                (path, lines)
            })
            .collect()
    };
    assert_eq!(strip(&a), strip(&b));
    assert_eq!(
        a.bytes(".amby/properties/layout.json"),
        b.bytes(".amby/properties/layout.json")
    );
}

#[test]
fn the_migration_is_not_started_where_it_would_be_wrong() {
    // З38: with sync on — only after a successful pass; if `layout.json` came from the server —
    // another device migrated, so none of our own
    let fx = old_vault();
    let before = fx.snapshot();
    let sync_not_ok = Context {
        sync_enabled: true,
        last_pass_ok: false,
        ..Context::default()
    };
    assert!(run(&fx.conn, &fx.vault, &sync_not_ok).is_err());
    let from_server = Context {
        sync_enabled: true,
        last_pass_ok: true,
        layout_came_from_server: true,
        arrived_template: None,
    };
    assert!(run(&fx.conn, &fx.vault, &from_server).is_err());
    assert_eq!(fx.snapshot(), before);
    let sync_ok = Context {
        sync_enabled: true,
        last_pass_ok: true,
        layout_came_from_server: false,
        arrived_template: None,
    };
    assert!(run(&fx.conn, &fx.vault, &sync_ok).is_ok());
}

// ----- З21, З41: a crash at every write, and the repeat -----

#[test]
fn a_crash_at_any_write_is_finished_by_the_journal_and_the_result_equals_an_uninterrupted_run() {
    // З21, З41
    let reference = old_vault();
    run(&reference.conn, &reference.vault, &plain_context()).unwrap();
    let expected = migrated_files(&reference.snapshot());
    let mut crashed_at_least_once = false;
    for (n, after) in (1..=14).flat_map(|n| [(n, false), (n, true)]) {
        let fx = old_vault();
        let old_file = fx.bytes(".amby/properties.json");
        let result = with_failing_write(n, after, || run(&fx.conn, &fx.vault, &plain_context()));
        let label = format!("crash at write {n} (after publish: {after})");
        assert_eq!(
            fx.bytes(".amby/properties.json"),
            old_file,
            "{label}: the old file is never changed"
        );
        if result.is_err() {
            crashed_at_least_once = true;
            assert!(
                !fx.exists(".amby/properties/layout.json"),
                "{label}: the layout is the mark of the end and goes last"
            );
            assert_eq!(
                storage_mode(&fx.vault).unwrap(),
                StorageMode::Legacy,
                "{label}"
            );
            if resume(&fx.conn, &fx.vault).is_err() {
                run(&fx.conn, &fx.vault, &plain_context()).unwrap();
            }
        }
        assert_eq!(migrated_files(&fx.snapshot()), expected, "{label}");
    }
    assert!(crashed_at_least_once);
}

#[test]
fn a_note_edited_between_the_crash_and_the_repeat_is_not_touched() {
    // З41: neither «до» nor «после» — leave it and put it in the outcome
    for (n, after) in (1..=14).flat_map(|n| [(n, false), (n, true)]) {
        let fx = old_vault();
        let result = with_failing_write(n, after, || run(&fx.conn, &fx.vault, &plain_context()));
        let in_the_middle = result.is_err()
            && !fx.exists(".amby/properties/layout.json")
            && !fx.read("nokey.md").contains("Автор")
            && !fx.files_under(".amby/migrations/").is_empty();
        if !in_the_middle {
            continue;
        }
        fx.note(&id(N_NOKEY), "nokey.md", "Другое: пока вы не смотрели\n");
        let edited = fx.bytes("nokey.md");
        let outcome = resume(&fx.conn, &fx.vault).unwrap();
        assert_eq!(fx.bytes("nokey.md"), edited);
        assert_eq!(outcome.skipped_changed, vec![id(N_NOKEY)]);
        assert_eq!(storage_mode(&fx.vault).unwrap(), StorageMode::Groups);
        return;
    }
    panic!("no crash stopped the run before the header of the note was written");
}

// ----- З42: rollback -----

#[test]
fn a_rollback_of_an_unfinished_migration_removes_only_the_groups_it_wrote_and_returns_the_headers()
{
    // З42
    let reference = old_vault();
    let original = reference.snapshot();
    for (n, after) in (1..=14).flat_map(|n| [(n, false), (n, true)]) {
        let fx = old_vault();
        let result = with_failing_write(n, after, || run(&fx.conn, &fx.vault, &plain_context()));
        if result.is_ok() || fx.files_under(".amby/migrations/").is_empty() {
            continue;
        }
        // a group of the user's own, which the migration did not write, must stay
        let report = rollback(&fx.conn, &fx.vault, &migration_id_of(&fx)).unwrap();
        assert!(
            report.not_restored.is_empty(),
            "nothing was edited since: {report:?}"
        );
        assert_eq!(
            migrated_files(&fx.snapshot()),
            migrated_files(&original),
            "crash at {n}/{after}: the vault is as before"
        );
        assert_eq!(storage_mode(&fx.vault).unwrap(), StorageMode::Legacy);
        return;
    }
    panic!("no crash left a journal");
}

fn migration_id_of(fx: &Fx) -> String {
    fx.files_under(".amby/migrations/")
        .first()
        .and_then(|p| p.split('/').nth(2))
        .unwrap()
        .to_string()
}

#[test]
fn a_rollback_after_the_end_restores_only_unchanged_headers_and_moves_groups_to_the_trash() {
    // З42: manual action of the inspection
    let fx = old_vault();
    let original_nokey = fx.bytes("nokey.md").unwrap();
    let outcome = run(&fx.conn, &fx.vault, &plain_context()).unwrap();
    assert_ne!(fx.bytes("nokey.md").unwrap(), original_nokey);
    let old_file = fx.bytes(".amby/properties.json");
    let report = rollback(&fx.conn, &fx.vault, &outcome.migration_id).unwrap();
    assert_eq!(report.headers_restored, vec![id(N_NOKEY)]);
    assert_eq!(fx.bytes("nokey.md").unwrap(), original_nokey);
    assert!(report.groups_removed > 0);
    assert!(
        fx.files_under(".amby/properties/").is_empty(),
        "the groups are gone from the folder"
    );
    assert!(
        !fx.files_under(".amby/trash/").is_empty(),
        "…but not deleted: in the trash of the vault"
    );
    assert_eq!(fx.bytes(".amby/properties.json"), old_file);
    assert_eq!(storage_mode(&fx.vault).unwrap(), StorageMode::Legacy);
}

#[test]
fn a_header_edited_after_the_migration_is_not_given_back_by_a_rollback() {
    // З42: «шапка возвращается только если не менялась после миграции»
    let fx = old_vault();
    let outcome = run(&fx.conn, &fx.vault, &plain_context()).unwrap();
    fx.note(
        &id(N_NOKEY),
        "nokey.md",
        "Автор: Иван\nЕщё: добавлено после\n",
    );
    let edited = fx.bytes("nokey.md");
    let report = rollback(&fx.conn, &fx.vault, &outcome.migration_id).unwrap();
    assert_eq!(report.not_restored, vec![id(N_NOKEY)]);
    assert!(report.headers_restored.is_empty());
    assert_eq!(fx.bytes("nokey.md"), edited);
}

// ----- З54: differences from the template, the order, the number of the template -----

/// A vault with one note whose header has the given lines, and an old `properties.json` for it.
fn one_note(header: &str, props: Vec<Value>) -> Fx {
    let fx = fx_old();
    fx.note(&id(1), "n.md", header);
    write_old_file(&fx, &[(&id(1), props)]);
    fx
}

#[test]
fn a_property_equal_to_the_template_gives_no_line_in_any_language() {
    // З54: «свойство, совпавшее с шаблоном полностью, строки не даёт»; the options are compared in
    // the language of the name that matched
    let (template, names) = crate::property_template::all()
        .into_iter()
        .find(|(p, _)| p.property_type == "select")
        .unwrap();
    for (_, name) in names {
        let found = crate::property_template::lookup(&name).unwrap();
        let fx = one_note(
            &format!("{name}: x\n"),
            vec![old_prop(
                "P",
                &name,
                &found.property_type,
                "x",
                &found.settings,
            )],
        );
        let mut old = old_prop("P", &name, &found.property_type, "x", &found.settings);
        old["icon"] = serde_json::json!(template.icon);
        write_old_file(&fx, &[(&id(1), vec![old])]);
        run(&fx.conn, &fx.vault, &plain_context()).unwrap();
        assert!(
            fx.line(&id(1)).is_none(),
            "{name}: nothing differs from the template"
        );
        assert!(
            fx.files_under(".amby/properties/")
                .iter()
                .all(|f| !f.contains("/prop_")),
            "{name}: no file of differences"
        );
        assert!(
            read_mark(&fx.vault, &id(1)).unwrap().is_some(),
            "{name}: the migrated note has its mark (З53)"
        );
    }
}

#[test]
fn only_the_fields_that_differ_from_the_template_are_carried() {
    // З54, З47
    let (template, names) = crate::property_template::all()
        .into_iter()
        .find(|(p, _)| p.property_type == "select")
        .unwrap();
    let name = names[0].1.clone();
    let found = crate::property_template::lookup(&name).unwrap();
    let mut old = old_prop("P", &name, &found.property_type, "x", &found.settings);
    old["icon"] = serde_json::json!("🔥");
    let fx = one_note(&format!("{name}: x\n"), vec![old]);
    run(&fx.conn, &fx.vault, &plain_context()).unwrap();
    assert_eq!(fx.props(&id(1))[&name], serde_json::json!({"icon": "🔥"}));
    let _ = template;
}

#[test]
fn the_order_is_carried_only_when_it_differs_from_the_order_of_the_header() {
    // З54, З47
    let props = vec![
        old_prop("P1", "Один", "text", "1", ""),
        old_prop("P2", "Два", "text", "2", ""),
    ];
    let same = one_note("Один: 1\nДва: 2\n", props.clone());
    run(&same.conn, &same.vault, &plain_context()).unwrap();
    assert!(same.line(&id(1)).unwrap().get("order").is_none());
    let moved = one_note("Два: 2\nОдин: 1\n", props);
    run(&moved.conn, &moved.vault, &plain_context()).unwrap();
    assert_eq!(
        moved.line(&id(1)).unwrap()["order"],
        serde_json::json!(["Один", "Два"])
    );
}

#[test]
fn the_layout_records_the_number_of_the_template() {
    // З48, З54
    let fx = one_note("Один: 1\n", vec![old_prop("P1", "Один", "text", "1", "")]);
    run(&fx.conn, &fx.vault, &plain_context()).unwrap();
    let layout: Value = serde_json::from_str(&fx.read(".amby/properties/layout.json")).unwrap();
    assert_eq!(
        layout["template"],
        crate::property_template::TEMPLATE_VERSION
    );
    assert_eq!(
        (layout["groups"].as_u64(), layout["version"].as_u64()),
        (Some(16), Some(1))
    );
}

#[test]
fn a_migration_under_an_older_template_than_the_arrived_layout_does_not_start() {
    // З54: two computers with different template numbers must not migrate one vault apart
    let fx = old_vault();
    let before = fx.snapshot();
    let newer = Context {
        arrived_template: Some(crate::property_template::TEMPLATE_VERSION + 1),
        ..Context::default()
    };
    assert!(run(&fx.conn, &fx.vault, &newer).is_err());
    assert_eq!(fx.snapshot(), before);
    let equal = Context {
        arrived_template: Some(crate::property_template::TEMPLATE_VERSION),
        ..Context::default()
    };
    assert!(run(&fx.conn, &fx.vault, &equal).is_ok());
}
