//! The format of the groups on disk (docs/sync-plan.md, appendix З: З1, З2, З4–З8, З23, З36).
//! Red until `property_groups` is written: its bodies are `todo!()` today.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::{json, Value};

use super::testkit::*;
use super::*;

const SAMPLE_CANONICAL: &str = "{\n  \"version\": 1,\n  \"notes\": {\n    \"01JC00000000000000000A0001\": {\n      \"hint\": {\n        \"path\": \"Папка/Заметка.md\",\n        \"title\": \"Заметка\"\n      },\n      \"properties\": [\n        {\n          \"id\": \"01JC00000000000000000B0001\",\n          \"name\": \"Статус\",\n          \"icon\": \"📌\",\n          \"propertyType\": \"select\",\n          \"settings\": \"Идея,Готово\"\n        }\n      ]\n    }\n  }\n}\n";

fn sample_group() -> GroupFile {
    serde_json::from_str(SAMPLE_CANONICAL).unwrap()
}

#[test]
fn the_group_of_a_note_is_the_file_of_the_first_byte_of_blake3_of_its_id() {
    // З5: the path on disk, and nothing else is created besides the layout
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Note.md", "");
    create_property(&fx.conn, &fx.vault, &note, design("Статус"), "Готово").unwrap();
    let expected = format!(
        ".amby/properties/{:02x}.json",
        amby_sync_core::crypto::primitives::blake3_hash(note.as_bytes())[0]
    );
    assert_eq!(
        group_path(&fx.vault, &note),
        fx.vault.join(&expected),
        "group_path"
    );
    assert!(fx.exists(&expected));
    let mut files = fx.files_under(".amby/properties/");
    files.sort();
    let mut want = vec![".amby/properties/layout.json".to_string(), expected];
    want.sort();
    assert_eq!(files, want, "one group and the layout");
    assert!(
        !fx.exists(".amby/properties.json"),
        "the old file is not created (З22)"
    );
}

#[test]
fn the_layout_decides_where_the_properties_live() {
    // З6, З38
    assert_eq!(storage_mode(&fx().vault).unwrap(), StorageMode::Groups);
    assert_eq!(storage_mode(&fx_old().vault).unwrap(), StorageMode::Legacy);
}

#[test]
fn another_layout_makes_the_properties_read_only_and_writes_nothing() {
    // З6: a version we do not know or another number of groups; a warning, no write
    for layout in [
        r#"{"version":2,"groups":256,"hash":"blake3-first-byte"}"#,
        r#"{"version":1,"groups":512,"hash":"blake3-first-byte"}"#,
        r#"{"version":1,"groups":256,"hash":"sha256-first-byte"}"#,
    ] {
        let fx = fx();
        fx.write(".amby/properties/layout.json", layout);
        let note = id(1);
        fx.note(&note, "Note.md", "Статус: Готово\n");
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
        assert!(put_entry(&fx.conn, &fx.vault, &note, Some(NoteEntry::default())).is_err());
        let shown = panel(&fx.conn, &fx.vault, &note).unwrap();
        assert!(
            shown.warnings.contains(&PanelWarning::FormatNewer),
            "{layout}"
        );
        assert_eq!(fx.snapshot(), before, "{layout}: nothing was written");
    }
}

#[test]
fn the_value_is_never_stored_in_the_group() {
    // З1, З2: the header is the only source of a value
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Note.md", "");
    create_property(
        &fx.conn,
        &fx.vault,
        &note,
        design("Статус"),
        "Секретное значение",
    )
    .unwrap();
    let text = String::from_utf8(fx.group_bytes(&note).unwrap()).unwrap();
    assert!(
        !text.contains("value") && !text.contains("Секретное"),
        "{text}"
    );
    assert!(fx.read("Note.md").contains("Статус: Секретное значение"));
}

#[test]
fn fields_of_a_newer_version_are_kept_at_all_three_levels() {
    // З2: file, record and property
    let fx = fx();
    let (a, b) = ids_in_one_group();
    fx.note(&a, "A.md", "Статус: Готово\n");
    fx.note(&b, "B.md", "");
    let group = json!({
        "version": 1,
        "futureFile": {"keep": [1, 2, {"x": null}]},
        "notes": {
            a.clone(): {
                "hint": {"path": "A.md", "title": "A"},
                "futureNote": "stay",
                "properties": [
                    {"id": "01JC00000000000000000B0001", "name": "Статус", "icon": "📌",
                     "propertyType": "text", "settings": "", "futureProp": {"color": "red"}}
                ]
            },
            b.clone(): {"futureOther": 7, "properties": []}
        }
    });
    fx.write(
        &fx.group_rel(&a),
        &serde_json::to_string_pretty(&group).unwrap(),
    );
    set_appearance(
        &fx.conn,
        &fx.vault,
        &a,
        "01JC00000000000000000B0001",
        "🔥",
        "",
    )
    .unwrap();
    let after = fx.group_json(&a);
    assert_eq!(after["futureFile"], group["futureFile"]);
    assert_eq!(after["notes"][&a]["futureNote"], "stay");
    assert_eq!(
        after["notes"][&a]["properties"][0]["futureProp"],
        json!({"color": "red"})
    );
    assert_eq!(after["notes"][&a]["properties"][0]["icon"], "🔥");
    assert_eq!(
        after["notes"][&b]["futureOther"], 7,
        "the record of another note of the group is untouched"
    );
    // the same through the typed API
    let read = read_group(&fx.vault, &a).unwrap();
    assert_eq!(read.extra["futureFile"], group["futureFile"]);
    assert_eq!(
        read.notes[&a].properties[0].extra["futureProp"],
        json!({"color": "red"})
    );
}

#[test]
fn the_canonical_form_is_exactly_the_documented_bytes() {
    // З8: keys of `notes` ascending, fields in the order of the structure, two-space indent, one
    // line feed at the end
    assert_eq!(
        String::from_utf8(canonical_group_bytes(&sample_group())).unwrap(),
        SAMPLE_CANONICAL
    );
}

#[test]
fn every_write_of_the_app_is_canonical_and_two_writes_of_the_same_edit_do_not_differ() {
    // З8, З30
    let fx = fx();
    let (a, b) = ids_in_one_group();
    fx.note(&b, "B.md", "");
    fx.note(&a, "A.md", "");
    create_property(&fx.conn, &fx.vault, &b, design("Автор"), "x").unwrap();
    create_property(
        &fx.conn,
        &fx.vault,
        &a,
        design_typed("Статус", "select", "Идея,Готово"),
        "Идея",
    )
    .unwrap();
    let bytes = fx.group_bytes(&a).unwrap();
    assert_eq!(
        bytes,
        canonical_group_bytes(&read_group(&fx.vault, &a).unwrap())
    );
    let json = fx.group_json(&a);
    let keys: Vec<&String> = json["notes"].as_object().unwrap().keys().collect();
    let mut sorted = keys.clone();
    sorted.sort();
    assert_eq!(keys, sorted, "notes ascending");
}

#[test]
fn an_edit_that_changes_nothing_writes_nothing() {
    // З8: no write without a real edit, no background normalisation
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Note.md", "");
    let made = create_property(&fx.conn, &fx.vault, &note, design("Статус"), "").unwrap();
    // the file was written by a human in another layout: same meaning, not canonical
    let loose = serde_json::to_string(&fx.group_json(&note)).unwrap();
    fx.write(&fx.group_rel(&note), &loose);
    let before = fx.snapshot();
    let (result, writes) = count_writes(|| {
        set_appearance(
            &fx.conn,
            &fx.vault,
            &note,
            &made.id,
            &made.icon,
            &made.settings,
        )
    });
    result.unwrap();
    assert_eq!(writes, 0);
    assert_eq!(
        fx.snapshot(),
        before,
        "bytes of the group stay as they were"
    );
    let (result, writes) =
        count_writes(|| reorder(&fx.conn, &fx.vault, &note, std::slice::from_ref(&made.id)));
    result.unwrap();
    assert_eq!(writes, 0);
    assert_eq!(fx.snapshot(), before);
}

#[test]
fn reading_never_writes() {
    // З8, З23: panel, inspection and the rebuild of the cache leave every file as it was
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Note.md", "Статус: Готово\n");
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
fn bom_and_line_endings_of_the_old_group_file_are_kept() {
    // З8: through `frontmatter::atomic_write`
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Note.md", "");
    let made = create_property(&fx.conn, &fx.vault, &note, design("Статус"), "").unwrap();
    let canonical = String::from_utf8(fx.group_bytes(&note).unwrap()).unwrap();
    let mut with = vec![0xEF, 0xBB, 0xBF];
    with.extend_from_slice(canonical.replace('\n', "\r\n").as_bytes());
    fx.write_bytes(&fx.group_rel(&note), &with);
    set_appearance(&fx.conn, &fx.vault, &note, &made.id, "🔥", "").unwrap();
    let after = fx.group_bytes(&note).unwrap();
    assert!(after.starts_with(&[0xEF, 0xBB, 0xBF]));
    let text = String::from_utf8_lossy(&after[3..]).to_string();
    assert!(text.contains("🔥"));
    assert_eq!(
        text.matches('\n').count(),
        text.matches("\r\n").count(),
        "all CRLF"
    );
}

#[test]
fn a_note_without_designs_has_no_record_and_a_group_without_records_has_no_file() {
    // З4
    let fx = fx();
    let (a, b) = ids_in_one_group();
    fx.note(&a, "A.md", "");
    fx.note(&b, "B.md", "");
    let entry = |name: &str| NoteEntry {
        properties: vec![Design {
            id: format!("{name}-id"),
            ..design(name)
        }],
        ..NoteEntry::default()
    };
    put_entry(&fx.conn, &fx.vault, &a, Some(entry("Один"))).unwrap();
    put_entry(&fx.conn, &fx.vault, &b, Some(entry("Два"))).unwrap();
    // an empty record is the same as none
    put_entry(&fx.conn, &fx.vault, &a, Some(NoteEntry::default())).unwrap();
    assert!(read_entry(&fx.vault, &a).unwrap().is_none());
    assert!(fx.group_json(&a)["notes"].get(&a).is_none());
    put_entry(&fx.conn, &fx.vault, &b, None).unwrap();
    assert!(
        !fx.exists(&fx.group_rel(&a)),
        "the last record left: no file"
    );
    // a missing group reads as an empty one
    assert!(read_group(&fx.vault, &a).unwrap().notes.is_empty());
}

#[test]
fn a_record_with_the_legacy_mark_stays_even_when_empty() {
    // З4, З36: otherwise the property deleted here would be revived from `properties.json`
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Note.md", "");
    let tomb = NoteEntry {
        legacy: Some(LegacyMark {
            entry: "aa".into(),
            record: "bb".into(),
        }),
        ..NoteEntry::default()
    };
    put_entry(&fx.conn, &fx.vault, &note, Some(tomb.clone())).unwrap();
    let kept = read_entry(&fx.vault, &note).unwrap().unwrap();
    assert!(kept.properties.is_empty());
    assert_eq!(kept.legacy, tomb.legacy);
}

#[test]
fn an_unreadable_group_is_never_overwritten_and_the_note_is_not_touched() {
    // З6, З28: nothing is written, not even the key of a new property in the header
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Note.md", "");
    fx.write(&fx.group_rel(&note), "not-json");
    let before = fx.snapshot();
    assert!(create_property(&fx.conn, &fx.vault, &note, design("Статус"), "x").is_err());
    assert!(read_group(&fx.vault, &note).is_err());
    assert_eq!(fx.snapshot(), before);
}

#[test]
fn the_hint_is_refreshed_when_the_record_is_written_and_not_when_a_file_is_renamed() {
    // З7
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Old.md", "");
    let made = create_property(&fx.conn, &fx.vault, &note, design("Статус"), "").unwrap();
    assert_eq!(
        fx.group_json(&note)["notes"][&note]["hint"]["path"],
        "Old.md"
    );
    std::fs::rename(fx.vault.join("Old.md"), fx.vault.join("New.md")).unwrap();
    fx.conn
        .execute("UPDATE notes SET path = 'New.md' WHERE id = ?1", [&note])
        .unwrap();
    let before = fx.group_bytes(&note).unwrap();
    panel(&fx.conn, &fx.vault, &note).unwrap();
    assert_eq!(
        fx.group_bytes(&note).unwrap(),
        before,
        "a rename alone does not change the group"
    );
    set_appearance(&fx.conn, &fx.vault, &note, &made.id, "🔥", "").unwrap();
    assert_eq!(
        fx.group_json(&note)["notes"][&note]["hint"]["path"],
        "New.md"
    );
}

#[test]
fn the_cache_takes_the_value_from_the_header_and_a_rebuild_migrates_and_deletes_nothing() {
    // З23, З1
    let fx = fx();
    let (a, b) = ids_in_different_groups();
    fx.note(&a, "A.md", "Статус: Готово\n");
    fx.note(&b, "B.md", "");
    let made = create_property(&fx.conn, &fx.vault, &a, design("Статус"), "Готово").unwrap();
    create_property(&fx.conn, &fx.vault, &b, design("Автор"), "x").unwrap();
    // an external edit of the header, then a rebuild
    fx.note(&a, "A.md", "Статус: Другое\n");
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
            "SELECT value FROM note_custom_properties WHERE note_id = ?1 AND id = ?2",
            [&a, &made.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(value, "Другое");
}

#[test]
fn a_whole_group_can_be_read_back_as_typed_data() {
    // З2, З7
    let fx = fx();
    let note = id(1);
    fx.note(&note, "Note.md", "");
    let made = create_property(
        &fx.conn,
        &fx.vault,
        &note,
        Design {
            icon: "🔥".into(),
            ..design_typed("Статус", "select", "Идея,Готово")
        },
        "Идея",
    )
    .unwrap();
    let entry = read_entry(&fx.vault, &note).unwrap().unwrap();
    assert_eq!(entry.properties, vec![made]);
    assert!(entry.hint.is_some());
    let _ = Value::Null;
}
