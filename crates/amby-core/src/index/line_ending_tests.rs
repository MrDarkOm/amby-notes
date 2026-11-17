use super::*;
use crate::frontmatter;
use std::fs;
use ulid::Ulid;

const ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

fn prepared_bytes(original: &[u8], new_body: &str) -> Vec<u8> {
    let vault = std::env::temp_dir().join(format!("amby-line-endings-{}", Ulid::generate()));
    fs::create_dir_all(&vault).unwrap();
    let path = vault.join("note.md");
    fs::write(&path, original).unwrap();
    let current = fs::read_to_string(&path).unwrap();
    let revision = body_revision(&frontmatter::parse_markdown(&current).body);

    let prepared = prepare_note_write_from_path(&vault, &path, ID, new_body, &revision).unwrap();
    let bytes = prepared.persisted_bytes;
    fs::remove_dir_all(&vault).ok();
    bytes
}

#[test]
fn a_crlf_frontmatter_keeps_its_bytes_when_the_body_uses_lf() {
    let original = format!("---\r\namby-id: {ID}\r\ntitle: Keep\r\n---\r\nfirst\nsecond\nthird\n");
    let bytes = prepared_bytes(original.as_bytes(), "first\nedited\nthird\n");

    let expected = format!("---\r\namby-id: {ID}\r\ntitle: Keep\r\n---\r\nfirst\nedited\nthird\n");
    assert_eq!(String::from_utf8(bytes).unwrap(), expected);
}

#[test]
fn an_lf_frontmatter_keeps_its_bytes_when_the_body_uses_crlf() {
    let original = format!("---\namby-id: {ID}\n---\nfirst\r\nsecond\r\nthird\r\n");
    let bytes = prepared_bytes(original.as_bytes(), "first\nedited\nthird\n");

    let expected = format!("---\namby-id: {ID}\n---\nfirst\r\nedited\r\nthird\r\n");
    assert_eq!(String::from_utf8(bytes).unwrap(), expected);
}

#[test]
fn the_bom_and_a_uniform_crlf_note_are_still_preserved() {
    let original = format!("\u{feff}---\r\namby-id: {ID}\r\n---\r\none\r\ntwo\r\n");
    let bytes = prepared_bytes(original.as_bytes(), "one\nchanged\n");

    let expected = format!("\u{feff}---\r\namby-id: {ID}\r\n---\r\none\r\nchanged\r\n");
    assert_eq!(String::from_utf8(bytes).unwrap(), expected);
}
