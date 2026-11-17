//! Why a note could not be read, told as a code the journal may keep (`docs/notices.md`): the
//! journal of the application had only "failed", so the cause of a read error the owner saw on
//! 13 November could not be found. Written before the code.

use std::fs;

use super::{open_connection, read_note_with_reason, upsert_note_index};

const ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

fn indexed_vault(name: &str) -> (std::path::PathBuf, std::path::PathBuf, rusqlite::Connection) {
    let vault = std::env::temp_dir().join(format!(
        "amby_read_reason_{name}_{}",
        ulid::Ulid::generate()
    ));
    fs::create_dir_all(&vault).unwrap();
    let path = vault.join("Note.md");
    fs::write(&path, format!("---\namby-id: {ID}\n---\nbody\n")).unwrap();
    let conn = open_connection(&vault).unwrap();
    upsert_note_index(&conn, &vault, ID, "body\n", &path).unwrap();
    (vault, path, conn)
}

#[test]
fn a_readable_note_has_no_reason() {
    let (vault, _, conn) = indexed_vault("ok");
    assert!(read_note_with_reason(&conn, &vault, ID).is_ok());
}

#[test]
fn an_id_the_index_does_not_know_is_note_not_indexed() {
    let (vault, _, conn) = indexed_vault("unknown");
    let Err((_, code)) = read_note_with_reason(&conn, &vault, "01ARZ3NDEKTSV4RRFFQ69G5FZZ") else {
        panic!("the read must fail")
    };
    assert_eq!(code, "NoteNotIndexed");
}

#[test]
fn a_file_gone_from_the_disk_is_file_not_found() {
    let (vault, path, conn) = indexed_vault("gone");
    fs::remove_file(&path).unwrap();
    let Err((_, code)) = read_note_with_reason(&conn, &vault, ID) else {
        panic!("the read must fail")
    };
    assert_eq!(code, "FileNotFound");
}

#[test]
fn a_file_that_is_not_utf8_is_invalid_data() {
    let (vault, path, conn) = indexed_vault("bytes");
    fs::write(&path, [0xff, 0xfe, 0x00, 0x80]).unwrap();
    let Err((_, code)) = read_note_with_reason(&conn, &vault, ID) else {
        panic!("the read must fail")
    };
    assert_eq!(code, "InvalidData");
}

#[test]
fn the_reason_codes_pass_the_privacy_filter_as_they_are() {
    for code in [
        "NoteNotIndexed",
        "FileNotFound",
        "InvalidData",
        "PermissionDenied",
        "IoError",
    ] {
        assert_eq!(
            crate::logging::sanitized_error_code(code).as_deref(),
            Some(code),
            "{code} must reach the journal"
        );
    }
}
