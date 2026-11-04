//! The files on disk: 16 files of JSON Lines, one line per note, only the differences from the
//! template (docs/sync-plan.md, appendix З with З.11: З1, З2, З4, З6–З8, З23, З47–З51, З53). Red
//! until `property_groups` is written: its bodies are `todo!()` today.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::{json, Value};

use super::testkit::*;
use super::*;

fn first_hex_digit(id: &str) -> String {
    format!(
        "{:x}",
        amby_sync_core::crypto::primitives::blake3_hash(id.as_bytes())[0] >> 4
    )
}

/// Three ids in one group, ascending by bytes.
fn three_in_one_group() -> [String; 3] {
    let first = id(1);
    let mut same: Vec<String> = (2..)
        .map(id)
        .filter(|c| group_of_id(c) == group_of_id(&first))
        .take(2)
        .collect();
    same.push(first);
    same.sort();
    [same[0].clone(), same[1].clone(), same[2].clone()]
}

fn group_of_id(id: &str) -> String {
    amby_sync_core::engine::props_groups::group_of(id)
}

#[test]
fn the_file_of_a_note_is_prop_x_jsonl_with_x_the_first_hex_digit_of_blake3_of_its_id() {
    // З48: 16 files; nothing else is created besides the layout
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Note.md", "");
    create_property(&fx.conn, &fx.vault, &note, design("Заказчик"), "Иван").unwrap();
    let expected = format!(".amby/properties/prop_{}.jsonl", first_hex_digit(&note));
    assert_eq!(group_path(&fx.vault, &note), fx.vault.join(&expected));
    assert_eq!(
        legacy_path(&fx.vault, &note),
        fx.vault.join(format!(
            ".amby/properties/legacy_{}.jsonl",
            first_hex_digit(&note)
        ))
    );
    let mut files = fx.files_under(".amby/properties/");
    files.sort();
    let mut want = vec![".amby/properties/layout.json".to_string(), expected];
    want.sort();
    assert_eq!(files, want);
    assert!(
        !fx.exists(".amby/properties.json"),
        "the old file is not created (З22)"
    );
}

#[test]
fn the_layout_decides_where_the_properties_live() {
    // З6, З38, З48
    assert_eq!(storage_mode(&fx().vault).unwrap(), StorageMode::Groups);
    assert_eq!(storage_mode(&fx_old().vault).unwrap(), StorageMode::Legacy);
}

#[test]
fn another_layout_makes_the_properties_read_only_and_writes_nothing() {
    // З48: a version we do not know or another number of groups or another hash
    for layout in [
        r#"{"groups":16,"hash":"blake3-first-hex","template":1,"version":2}"#,
        r#"{"groups":256,"hash":"blake3-first-hex","template":1,"version":1}"#,
        r#"{"groups":16,"hash":"blake3-first-byte","template":1,"version":1}"#,
    ] {
        let fx = fx();
        fx.write(".amby/properties/layout.json", layout);
        let note = id(1);
        fx.note(&note, "Note.md", "Заказчик: Иван\n");
        let before = fx.snapshot();
        assert_eq!(
            storage_mode(&fx.vault).unwrap(),
            StorageMode::Newer,
            "{layout}"
        );
        assert!(
            create_property(&fx.conn, &fx.vault, &note, design("Автор"), "").is_err(),
            "{layout}"
        );
        assert!(put_entry(
            &fx.conn,
            &fx.vault,
            &note,
            Some(entry_of(&note, &[("А", "1")]))
        )
        .is_err());
        assert!(panel(&fx.conn, &fx.vault, &note)
            .unwrap()
            .warnings
            .contains(&PanelWarning::FormatNewer));
        assert_eq!(fx.snapshot(), before, "{layout}: nothing was written");
    }
}

#[test]
fn the_value_is_never_stored_and_no_property_has_an_id() {
    // З1, З47: the header is the only source of a value; the property is known by its name
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Note.md", "");
    create_property(
        &fx.conn,
        &fx.vault,
        &note,
        design("Заказчик"),
        "Секретное значение",
    )
    .unwrap();
    let text = String::from_utf8(fx.group_bytes(&note).unwrap()).unwrap();
    assert!(
        !text.contains("value") && !text.contains("Секретное"),
        "{text}"
    );
    let line = fx.line(&note).unwrap();
    assert!(line["props"]["Заказчик"].get("id").is_none(), "{line}");
    assert!(fx.read("Note.md").contains("Заказчик: Секретное значение"));
}

#[test]
fn only_differences_are_written_and_the_line_is_canonical_bytes() {
    // З47, З49: icon only — a type of plain text and empty settings equal the default
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Note.md", "");
    create_property(&fx.conn, &fx.vault, &note, design("Заказчик"), "Иван").unwrap();
    let text = String::from_utf8(fx.group_bytes(&note).unwrap()).unwrap();
    assert_eq!(
        text,
        format!(
            "{{\"version\":1}}\n{{\"hint\":{{\"path\":\"Note.md\"}},\"id\":\"{note}\",\"props\":{{\"Заказчик\":{{\"icon\":\"📌\"}}}}}}\n"
        )
    );
}

#[test]
fn canonical_line_is_compact_with_ascending_keys_at_every_level() {
    // З49
    let entry = NoteEntry {
        id: "01JC00000000000000000A0001".into(),
        hint: Some(Hint {
            path: "Папка/Заметка.md".into(),
        }),
        props: [(
            "Заказчик".to_string(),
            Diff {
                icon: Some("i".into()),
                property_type: Some("t".into()),
                settings: Some("s".into()),
                previous_name: Some("p".into()),
                extra: Default::default(),
            },
        )]
        .into(),
        order: vec!["Б".into(), "А".into()],
        dismissed_renames: vec![["x".into(), "y".into()]],
        extra: Default::default(),
    };
    assert_eq!(
        canonical_line(&entry),
        "{\"dismissedRenames\":[[\"x\",\"y\"]],\"hint\":{\"path\":\"Папка/Заметка.md\"},\"id\":\"01JC00000000000000000A0001\",\"order\":[\"Б\",\"А\"],\"props\":{\"Заказчик\":{\"icon\":\"i\",\"previousName\":\"p\",\"propertyType\":\"t\",\"settings\":\"s\"}}}"
    );
}

#[test]
fn the_first_line_is_the_version_and_the_lines_are_sorted_by_id() {
    // З48
    let fx = fx();
    let [a, b, c] = three_in_one_group();
    for (note, rel) in [(&c, "C.md"), (&a, "A.md"), (&b, "B.md")] {
        fx.note(note, rel, "");
        create_property(&fx.conn, &fx.vault, note, design("Заказчик"), "x").unwrap();
    }
    let text = String::from_utf8(fx.group_bytes(&a).unwrap()).unwrap();
    assert!(text.starts_with("{\"version\":1}\n"));
    let ids: Vec<String> = fx
        .lines(&a)
        .iter()
        .map(|l| l["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, vec![a.clone(), b.clone(), c.clone()]);
    for l in text.lines().skip(1) {
        let v: Value = serde_json::from_str(l).unwrap();
        assert_eq!(
            l,
            serde_json::to_string(&v).unwrap(),
            "compact, ascending keys"
        );
    }
}

#[test]
fn an_edit_replaces_only_the_line_of_its_note_and_copies_the_others_byte_for_byte() {
    // З50: no re-parse, no rebuild of the lines of other notes
    let fx = fx();
    let [a, b, c] = three_in_one_group();
    fx.note(&b, "B.md", "");
    let spaced = |id: &str| {
        format!("{{ \"id\": \"{id}\", \"props\": {{ \"Один\": {{ \"icon\": \"1\" }} }}, \"zz\": [ 1,  2 ] }}\n")
    };
    fx.write(
        &fx.group_rel(&a),
        &format!("{{ \"version\": 1 }}\n{}{}", spaced(&a), spaced(&c)),
    );
    let before = String::from_utf8(fx.group_bytes(&a).unwrap()).unwrap();
    put_entry(&fx.conn, &fx.vault, &b, Some(entry_of(&b, &[("Два", "2")]))).unwrap();
    let after = String::from_utf8(fx.group_bytes(&a).unwrap()).unwrap();
    let old: Vec<&str> = before.lines().collect();
    let new: Vec<&str> = after.lines().collect();
    assert_eq!(new.len(), 4);
    assert_eq!(
        (new[0], new[1], new[3]),
        (old[0], old[1], old[2]),
        "the other lines are untouched"
    );
    let middle: Value = serde_json::from_str(new[2]).unwrap();
    assert_eq!(middle["id"], b.as_str());
    assert_eq!(
        new[2],
        serde_json::to_string(&middle).unwrap(),
        "the new line is canonical"
    );
    // and the removal of a line touches only it
    put_entry(&fx.conn, &fx.vault, &b, None).unwrap();
    assert_eq!(
        String::from_utf8(fx.group_bytes(&a).unwrap()).unwrap(),
        before
    );
}

#[test]
fn unknown_fields_of_the_first_line_the_line_and_the_differences_are_kept() {
    // З2, З47, З48
    let fx = fx();
    let (a, b) = ids_in_one_group();
    fx.note(&a, "A.md", "Заказчик: Иван\n");
    fx.note(&b, "B.md", "");
    let (first, second) = if a < b { (&a, &b) } else { (&b, &a) };
    let line = |id: &str, extra: &str| {
        format!("{{\"id\":\"{id}\",{extra}\"props\":{{\"Заказчик\":{{\"color\":{{\"deep\":[1,null]}},\"icon\":\"1\"}}}}}}\n")
    };
    fx.write(
        &fx.group_rel(&a),
        &format!(
            "{{\"future\":{{\"keep\":[1,2]}},\"version\":1}}\n{}{}",
            line(first, "\"futureLine\":\"stay\","),
            line(second, "")
        ),
    );
    let note = &a;
    set_appearance(&fx.conn, &fx.vault, note, "Заказчик", "🔥", "").unwrap();
    let text = String::from_utf8(fx.group_bytes(&a).unwrap()).unwrap();
    assert!(
        text.starts_with("{\"future\":{\"keep\":[1,2]},\"version\":1}\n"),
        "{text}"
    );
    let mine = fx.line(&a).unwrap();
    assert_eq!(
        mine["props"]["Заказчик"]["color"],
        json!({"deep": [1, null]})
    );
    assert_eq!(mine["props"]["Заказчик"]["icon"], "🔥");
    if &a == first {
        assert_eq!(mine["futureLine"], "stay");
    }
    let (_, bad) = read_group(&fx.vault, &a).unwrap();
    assert!(bad.is_empty());
}

#[test]
fn a_line_that_cannot_be_used_hides_nothing_and_blocks_the_writes_of_the_whole_file() {
    // З51: the other notes are shown, no line of the file is written, the inspection names the line
    let fx = fx();
    let [a, b, c] = three_in_one_group();
    fx.note(&a, "A.md", "Заказчик: Иван\n");
    fx.note(&c, "C.md", "");
    let good =
        |id: &str| format!("{{\"id\":\"{id}\",\"props\":{{\"Заказчик\":{{\"icon\":\"1\"}}}}}}\n");
    fx.write(
        &fx.group_rel(&a),
        &format!(
            "{{\"version\":1}}\n{}this is not json\n{}",
            good(&a),
            good(&c)
        ),
    );
    fx.note(&b, "B.md", "");
    let before = fx.snapshot();
    let (file, bad) = read_group(&fx.vault, &a).unwrap();
    assert_eq!(file.entries.len(), 2);
    assert_eq!(bad.len(), 1);
    assert_eq!(bad[0].number, 3, "the first line is the version");
    let shown = panel(&fx.conn, &fx.vault, &a).unwrap();
    assert_eq!(shown.active[0].icon, "1", "the other records are shown");
    assert!(shown.warnings.contains(&PanelWarning::BadLineInGroup));
    // every edit of every note of the group is refused and nothing changes
    assert!(set_appearance(&fx.conn, &fx.vault, &a, "Заказчик", "🔥", "").is_err());
    assert!(create_property(&fx.conn, &fx.vault, &b, design("Другое"), "").is_err());
    assert!(put_entry(&fx.conn, &fx.vault, &b, Some(entry_of(&b, &[("Х", "1")]))).is_err());
    assert_eq!(fx.snapshot(), before);
    assert_eq!(inspect(&fx.conn, &fx.vault).unwrap().bad_lines.len(), 1);
}

#[test]
fn a_line_with_unique_names_broken_is_read_only_for_its_own_note_and_found_by_id() {
    // З51, З47: names that repeat after NFC / ASCII case break the line, the id is still known
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "Status: x\n");
    fx.write(
        &fx.group_rel(&note),
        &format!("{{\"version\":1}}\n{{\"id\":\"{note}\",\"props\":{{\"STATUS\":{{\"icon\":\"1\"}},\"Status\":{{\"icon\":\"2\"}}}}}}\n"),
    );
    let before = fx.snapshot();
    let (_, bad) = read_group(&fx.vault, &note).unwrap();
    assert_eq!(bad.len(), 1);
    assert_eq!(bad[0].note_id.as_deref(), Some(note.as_str()));
    assert!(panel(&fx.conn, &fx.vault, &note)
        .unwrap()
        .active
        .iter()
        .all(|p| p.read_only));
    assert!(set_value(&fx.conn, &fx.vault, &note, "Status", "y").is_err());
    assert_eq!(fx.snapshot(), before);
}

#[test]
fn an_unreadable_first_line_is_never_overwritten_and_the_note_is_not_touched() {
    // З48, З28: nothing is written, not even the key of a new property in the header
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Note.md", "");
    fx.write(&fx.group_rel(&note), "not-json\n");
    let before = fx.snapshot();
    assert!(create_property(&fx.conn, &fx.vault, &note, design("Заказчик"), "x").is_err());
    assert!(read_group(&fx.vault, &note).is_err());
    assert_eq!(fx.snapshot(), before);
}

#[test]
fn an_edit_that_changes_nothing_writes_nothing() {
    // З8: no write without a real edit, no background normalisation
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Note.md", "");
    create_property(&fx.conn, &fx.vault, &note, design("Заказчик"), "").unwrap();
    // a human wrote the same meaning with spaces
    let loose = String::from_utf8(fx.group_bytes(&note).unwrap())
        .unwrap()
        .replace("\":", "\": ");
    fx.write(&fx.group_rel(&note), &loose);
    let before = fx.snapshot();
    let (result, writes) =
        count_writes(|| set_appearance(&fx.conn, &fx.vault, &note, "Заказчик", "📌", ""));
    result.unwrap();
    assert_eq!(writes, 0);
    let (result, writes) =
        count_writes(|| reorder(&fx.conn, &fx.vault, &note, &["Заказчик".to_string()]));
    result.unwrap();
    assert_eq!(writes, 0);
    assert_eq!(fx.snapshot(), before);
}

#[test]
fn reading_never_writes() {
    // З8, З23
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Note.md", "Заказчик: Иван\n");
    create_property(&fx.conn, &fx.vault, &note, design("Автор"), "x").unwrap();
    let before = fx.snapshot();
    let (_, writes) = count_writes(|| {
        panel(&fx.conn, &fx.vault, &note).unwrap();
        inspect(&fx.conn, &fx.vault).unwrap();
        rebuild_cache(&fx.conn, &fx.vault).unwrap();
        read_group(&fx.vault, &note).unwrap();
    });
    assert_eq!(writes, 0);
    assert_eq!(fx.snapshot(), before);
}

#[test]
fn bom_and_line_endings_of_the_old_file_are_kept_and_a_new_line_gets_the_ending_of_the_file() {
    // З49: through `frontmatter::atomic_write_bytes`
    let fx = fx();
    let (a, b) = ids_in_one_group();
    fx.note(&a, "A.md", "");
    fx.note(&b, "B.md", "");
    create_property(&fx.conn, &fx.vault, &a, design("Заказчик"), "").unwrap();
    let canonical = String::from_utf8(fx.group_bytes(&a).unwrap()).unwrap();
    let mut with = vec![0xEF, 0xBB, 0xBF];
    with.extend_from_slice(canonical.replace('\n', "\r\n").as_bytes());
    fx.write_bytes(&fx.group_rel(&a), &with);
    create_property(&fx.conn, &fx.vault, &b, design("Автор"), "").unwrap();
    let after = fx.group_bytes(&a).unwrap();
    assert!(after.starts_with(&[0xEF, 0xBB, 0xBF]));
    let text = String::from_utf8_lossy(&after[3..]).to_string();
    assert!(text.contains("Автор"));
    assert_eq!(
        text.matches('\n').count(),
        text.matches("\r\n").count(),
        "all CRLF"
    );
}

#[test]
fn a_note_without_differences_has_no_line_and_a_file_without_lines_has_no_file() {
    // З4, З47
    let fx = fx();
    let (a, b) = ids_in_one_group();
    fx.note(&a, "A.md", "");
    fx.note(&b, "B.md", "");
    put_entry(
        &fx.conn,
        &fx.vault,
        &a,
        Some(entry_of(&a, &[("Один", "1")])),
    )
    .unwrap();
    put_entry(&fx.conn, &fx.vault, &b, Some(entry_of(&b, &[("Два", "2")]))).unwrap();
    put_entry(
        &fx.conn,
        &fx.vault,
        &a,
        Some(NoteEntry {
            id: a.clone(),
            ..NoteEntry::default()
        }),
    )
    .unwrap();
    assert!(
        read_entry(&fx.vault, &a).unwrap().is_none(),
        "an empty record is the same as none"
    );
    assert!(fx.line(&a).is_none());
    put_entry(&fx.conn, &fx.vault, &b, None).unwrap();
    assert!(!fx.exists(&fx.group_rel(&a)), "the last line left: no file");
    assert!(read_group(&fx.vault, &a).unwrap().0.entries.is_empty());
    // a record that only keeps a refused rename is a record
    let kept = NoteEntry {
        id: a.clone(),
        dismissed_renames: vec![["А".into(), "Б".into()]],
        ..NoteEntry::default()
    };
    put_entry(&fx.conn, &fx.vault, &a, Some(kept.clone())).unwrap();
    assert_eq!(
        read_entry(&fx.vault, &a)
            .unwrap()
            .unwrap()
            .dismissed_renames,
        kept.dismissed_renames
    );
}

#[test]
fn the_marks_of_old_versions_have_files_of_their_own_and_no_line_in_the_groups() {
    // З53: `legacy_<x>.jsonl` — `{"version":1}` and `{"entry","id","record"}`
    let fx = fx();
    let note = id(1);
    fx.note(&note, "N.md", "");
    let mark = LegacyMark {
        id: note.clone(),
        entry: "e".repeat(64),
        record: "0".repeat(64),
    };
    put_mark(&fx.vault, &note, Some(mark.clone())).unwrap();
    let rel = format!(".amby/properties/legacy_{}.jsonl", first_hex_digit(&note));
    assert_eq!(
        fx.read(&rel),
        format!(
            "{{\"version\":1}}\n{{\"entry\":\"{}\",\"id\":\"{note}\",\"record\":\"{}\"}}\n",
            "e".repeat(64),
            "0".repeat(64)
        )
    );
    assert_eq!(read_mark(&fx.vault, &note).unwrap(), Some(mark));
    assert!(
        !fx.exists(&fx.group_rel(&note)),
        "a note with nothing but a mark has no line of differences"
    );
    put_mark(&fx.vault, &note, None).unwrap();
    assert!(!fx.exists(&rel));
}

#[test]
fn the_hint_is_refreshed_when_the_line_is_written_and_not_when_a_file_is_renamed() {
    // З47
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Old.md", "");
    create_property(&fx.conn, &fx.vault, &note, design("Заказчик"), "").unwrap();
    assert_eq!(fx.line(&note).unwrap()["hint"]["path"], "Old.md");
    std::fs::rename(fx.vault.join("Old.md"), fx.vault.join("New.md")).unwrap();
    fx.conn
        .execute("UPDATE notes SET path = 'New.md' WHERE id = ?1", [&note])
        .unwrap();
    let before = fx.group_bytes(&note).unwrap();
    panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(fx.group_bytes(&note).unwrap(), before);
    set_appearance(&fx.conn, &fx.vault, &note, "Заказчик", "🔥", "").unwrap();
    assert_eq!(fx.line(&note).unwrap()["hint"]["path"], "New.md");
}

#[test]
fn the_cache_takes_the_value_from_the_header_and_a_rebuild_migrates_and_deletes_nothing() {
    // З23, З1
    let fx = fx();
    let (a, b) = ids_in_different_groups();
    fx.note(&a, "A.md", "Заказчик: Иван\n");
    fx.note(&b, "B.md", "");
    create_property(&fx.conn, &fx.vault, &a, design("Заказчик"), "Иван").unwrap();
    create_property(&fx.conn, &fx.vault, &b, design("Автор"), "x").unwrap();
    fx.note(&a, "A.md", "Заказчик: Пётр\n");
    fx.write(".amby/properties.json", "{\"version\":1,\"notes\":{}}\n");
    fx.conn
        .execute("DELETE FROM note_custom_properties", [])
        .unwrap();
    let before = fx.snapshot();
    rebuild_cache(&fx.conn, &fx.vault).unwrap();
    assert_eq!(fx.snapshot(), before);
    let value: String = fx
        .conn
        .query_row(
            "SELECT value FROM note_custom_properties WHERE note_id = ?1 AND name = 'Заказчик'",
            [&a],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(value, "Пётр");
}

#[test]
fn a_line_can_be_read_back_as_typed_data() {
    // З47
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Note.md", "");
    create_property(
        &fx.conn,
        &fx.vault,
        &note,
        design_typed("Заказчик", "select", "Идея,Готово"),
        "Идея",
    )
    .unwrap();
    let entry = read_entry(&fx.vault, &note).unwrap().unwrap();
    assert_eq!(entry.id, note);
    let diff = &entry.props["Заказчик"];
    assert_eq!(diff.icon.as_deref(), Some("📌"));
    assert_eq!(diff.property_type.as_deref(), Some("select"));
    assert_eq!(diff.settings.as_deref(), Some("Идея,Готово"));
    assert!(entry.hint.is_some());
}
