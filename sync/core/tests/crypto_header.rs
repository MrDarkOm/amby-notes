//! The encrypted item header (Р2, Р6, Р9, Р13, О1, С5, С6, С13): what is hidden, what binds a
//! header to its item and version, and what is rejected. Exact bytes are in
//! `crypto_reference_vectors.rs`.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::collections::BTreeMap;

use amby_sync_core::crypto::header::{
    canonical_header_json, header_envelope_epoch, open_header, parse_header_json, seal_header,
    Header, ItemKind,
};
use amby_sync_core::crypto::keys::{BodyId, ItemId, SpaceId, SpaceKey};
use amby_sync_core::crypto::random::OsRandom;
use amby_sync_core::crypto::CryptoError;
use common::{file_header, SeedRandom};
use proptest::prelude::*;
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

fn vk() -> SpaceKey {
    SpaceKey::from_bytes([0x11; 32], 1)
}

fn space() -> SpaceId {
    SpaceId::from_bytes([0xA1; 16])
}

fn item() -> ItemId {
    ItemId::from_bytes([0xB2; 16])
}

fn seal(header: &Header) -> Vec<u8> {
    seal_header(&vk(), &space(), &item(), header, &mut OsRandom).unwrap()
}

#[test]
fn a_header_survives_seal_and_open_unchanged() {
    // Р2, Р6, О7: every field comes back as written, for files, folders and deletions
    let mut folder = file_header(1, "Projects/Empty folder");
    folder.kind = ItemKind::Folder;
    folder.size = 0;
    folder.content_hash = None;
    folder.body_id = None;
    let mut deleted = file_header(8, "gone.md");
    deleted.deleted = true;
    for header in [file_header(3, "Notes/Идея.md"), folder, deleted] {
        let envelope = seal(&header);
        let opened = open_header(&vk(), &space(), &item(), header.version, &envelope).unwrap();
        assert_eq!(opened, header);
    }
}

#[test]
fn the_server_sees_neither_the_path_nor_the_hash() {
    // О1, Р2, Р6: no plaintext of the header appears in the envelope
    let mut header = file_header(2, "Secret project/passwords and plans.md");
    header.content_hash = Some([0x5A; 32]);
    header.body_id = Some(BodyId::from_bytes([0x6B; 16]));
    let envelope = seal(&header);
    assert!(open_header(&vk(), &space(), &item(), 2, &envelope).is_ok());
    for needle in [
        b"Secret project".to_vec(),
        b"passwords".to_vec(),
        b"plans.md".to_vec(),
        b"\"path\"".to_vec(),
        vec![0x5A; 8],
        vec![0x6B; 8],
    ] {
        assert!(
            !envelope
                .windows(needle.len())
                .any(|window| window == needle.as_slice()),
            "{needle:?}"
        );
    }
}

#[test]
fn the_envelope_length_hides_the_path_length_within_256_bytes() {
    // О2, Р6, Ф17, Ф18: 1 + 4 + 24 + a multiple of 256 + 16 bytes
    let short = seal(&file_header(1, "a.md"));
    let medium = seal(&file_header(1, &format!("{}.md", "x".repeat(17))));
    assert_eq!(
        short.len(),
        medium.len(),
        "paths of different length share one size"
    );
    assert_eq!((short.len() - 45) % 256, 0);
    assert!(short.len() >= 45 + 256);
    let long = seal(&file_header(1, &format!("{}.md", "y".repeat(400))));
    assert!(long.len() > short.len(), "a long path needs a longer block");
    assert_eq!((long.len() - 45) % 256, 0);
}

#[test]
fn sealing_twice_gives_different_envelopes() {
    // Р6, Ф18: a fresh nonce every time; both open to the same header
    let header = file_header(4, "same.md");
    let first = seal(&header);
    let second = seal(&header);
    assert_ne!(first, second);
    assert_eq!(
        open_header(&vk(), &space(), &item(), 4, &first).unwrap(),
        header
    );
    assert_eq!(
        open_header(&vk(), &space(), &item(), 4, &second).unwrap(),
        header
    );
}

#[test]
fn a_header_cannot_be_moved_to_another_item_space_or_version() {
    // Р6, Р3, С5, С6: the AAD binds item, space, epoch and version
    let header = file_header(5, "Notes/a.md");
    let envelope = seal(&header);
    assert_eq!(
        open_header(&vk(), &space(), &item(), 5, &envelope).unwrap(),
        header,
        "control"
    );

    let other_item = ItemId::from_bytes([0xB3; 16]);
    assert_eq!(
        open_header(&vk(), &space(), &other_item, 5, &envelope),
        Err(CryptoError::Authentication)
    );
    let other_space = SpaceId::from_bytes([0xA2; 16]);
    assert_eq!(
        open_header(&vk(), &other_space, &item(), 5, &envelope),
        Err(CryptoError::Authentication)
    );
    // an old header presented as a newer version, and a new one as an older version
    assert_eq!(
        open_header(&vk(), &space(), &item(), 6, &envelope),
        Err(CryptoError::Authentication)
    );
    assert_eq!(
        open_header(&vk(), &space(), &item(), 4, &envelope),
        Err(CryptoError::Authentication)
    );
    assert_eq!(
        open_header(&vk(), &space(), &item(), 0, &envelope),
        Err(CryptoError::Authentication)
    );
}

#[test]
fn an_old_version_of_the_same_item_does_not_pass_for_the_new_one() {
    // Р6, Р3, С6: the server hands out the header of version 3 when version 4 is expected
    let old = seal(&file_header(3, "Notes/a.md"));
    let new = seal(&file_header(4, "Notes/a.md"));
    assert!(open_header(&vk(), &space(), &item(), 4, &new).is_ok());
    assert_eq!(
        open_header(&vk(), &space(), &item(), 4, &old),
        Err(CryptoError::Authentication)
    );
}

#[test]
fn another_key_or_epoch_is_rejected() {
    // Р5, Р6, Ф18: wrong VK → authentication; the right bytes with another epoch → epoch mismatch
    let envelope = seal(&file_header(2, "a.md"));
    let wrong_key = SpaceKey::from_bytes([0x12; 32], 1);
    assert_eq!(
        open_header(&wrong_key, &space(), &item(), 2, &envelope),
        Err(CryptoError::Authentication)
    );
    let other_epoch = SpaceKey::from_bytes([0x11; 32], 2);
    assert_eq!(
        open_header(&other_epoch, &space(), &item(), 2, &envelope),
        Err(CryptoError::EpochMismatch)
    );
    assert_eq!(header_envelope_epoch(&envelope).unwrap(), 1);

    let second_epoch = seal_header(
        &other_epoch,
        &space(),
        &item(),
        &file_header(2, "a.md"),
        &mut OsRandom,
    )
    .unwrap();
    assert_eq!(header_envelope_epoch(&second_epoch).unwrap(), 2);
    assert!(open_header(&other_epoch, &space(), &item(), 2, &second_epoch).is_ok());
}

#[test]
fn every_changed_byte_of_an_envelope_is_rejected() {
    // Р6, С5: version byte, epoch, nonce, ciphertext and tag are all covered (Ф18)
    let envelope = seal(&file_header(7, "Notes/a.md"));
    assert!(
        open_header(&vk(), &space(), &item(), 7, &envelope).is_ok(),
        "control"
    );
    for position in 0..envelope.len() {
        let mut changed = envelope.clone();
        changed[position] ^= 0x01;
        let error = open_header(&vk(), &space(), &item(), 7, &changed).unwrap_err();
        let expected = match position {
            0 => CryptoError::UnsupportedVersion(0),
            1..=4 => CryptoError::EpochMismatch,
            _ => CryptoError::Authentication,
        };
        assert_eq!(error, expected, "byte {position}");
    }
}

#[test]
fn truncated_or_extended_envelopes_are_rejected_without_panic() {
    // Р6, С5
    let envelope = seal(&file_header(7, "Notes/a.md"));
    for length in (0..envelope.len()).step_by(7).chain([envelope.len() - 1]) {
        assert!(
            open_header(&vk(), &space(), &item(), 7, &envelope[..length]).is_err(),
            "length {length}"
        );
    }
    let mut longer = envelope.clone();
    longer.push(0);
    assert!(open_header(&vk(), &space(), &item(), 7, &longer).is_err());
    assert!(header_envelope_epoch(&envelope[..3]).is_err());
}

#[test]
fn unknown_fields_of_newer_versions_are_kept() {
    // Р13, С13, Ф14: a field this build does not know survives a round trip and a rewrite
    let mut header = file_header(2, "a.md");
    header.extra.insert("color".into(), json!("red"));
    header.extra.insert(
        "nested".into(),
        json!({"b": [1, 2, {"d": null, "c": true}], "a": -4}),
    );
    let opened = open_header(&vk(), &space(), &item(), 2, &seal(&header)).unwrap();
    assert_eq!(opened.extra, header.extra);

    // a rename on this device: change the path, bump the version, seal again
    let mut renamed = opened;
    renamed.path = "b.md".into();
    renamed.version = 3;
    let again = open_header(&vk(), &space(), &item(), 3, &seal(&renamed)).unwrap();
    assert_eq!(again.extra, header.extra);
    assert_eq!(again.path, "b.md");
}

#[test]
fn an_unknown_field_cannot_reuse_a_known_name() {
    // Р13, Ф16: it would shadow a real field
    for key in ["path", "version", "format", "body_id", "deleted"] {
        let mut header = file_header(2, "a.md");
        header.extra.insert(key.into(), json!("shadow"));
        assert_eq!(
            seal_header(&vk(), &space(), &item(), &header, &mut OsRandom).unwrap_err(),
            CryptoError::ReservedKey(key.into())
        );
        assert!(canonical_header_json(&header).is_err());
    }
}

#[test]
fn a_path_not_in_nfc_is_refused() {
    // Р9, Р6, Ф19: macOS gives NFD; the header must hold NFC or one file becomes two
    let nfc = "Notes/caf\u{00e9}.md";
    let nfd: String = nfc.nfd().collect();
    assert_ne!(nfc, nfd);
    assert!(seal_header(
        &vk(),
        &space(),
        &item(),
        &file_header(1, nfc),
        &mut OsRandom
    )
    .is_ok());
    assert_eq!(
        seal_header(
            &vk(),
            &space(),
            &item(),
            &file_header(1, &nfd),
            &mut OsRandom
        )
        .unwrap_err(),
        CryptoError::PathNotNfc
    );
    assert_eq!(
        canonical_header_json(&file_header(1, &nfd)).unwrap_err(),
        CryptoError::PathNotNfc
    );
}

#[test]
fn canonical_json_has_sorted_keys_and_no_spaces() {
    // Р6, Ф15: expected text written by hand from the rules of the plan
    let mut folder = file_header(2, "a");
    folder.kind = ItemKind::Folder;
    folder.size = 0;
    folder.mtime_ms = 7;
    folder.content_hash = None;
    folder.body_id = None;
    assert_eq!(
        String::from_utf8(canonical_header_json(&folder).unwrap()).unwrap(),
        r#"{"body_id":null,"content_hash":null,"deleted":false,"format":1,"kind":"folder","mtime_ms":7,"path":"a","size":0,"version":2}"#
    );

    let mut file = file_header(1, "a \"q\"/é😀.md");
    file.size = 9;
    file.mtime_ms = -3;
    file.content_hash = Some([0xAB; 32]);
    file.body_id = Some(BodyId::from_bytes([0x01; 16]));
    file.extra.insert("zz".into(), json!(1));
    file.extra
        .insert("aa".into(), json!({"y": 2, "x": [true, null]}));
    // escapes: quote, backslash, tab, newline, U+0001 as \u0001; U+007F stays as it is (Ф15)
    file.extra
        .insert("note".into(), json!("a\\b\tc\nd\u{1}e\u{7f}"));
    let expected = format!(
        r#"{{"aa":{{"x":[true,null],"y":2}},"body_id":"{}","content_hash":"{}","deleted":false,"format":1,"kind":"file","mtime_ms":-3,"note":"a\\b\tc\nd\u0001e{}","path":"a \"q\"/é😀.md","size":9,"version":1,"zz":1}}"#,
        "01".repeat(16),
        "ab".repeat(32),
        '\u{7f}'
    );
    assert_eq!(
        String::from_utf8(canonical_header_json(&file).unwrap()).unwrap(),
        expected
    );
}

#[test]
fn fractional_numbers_are_not_allowed_among_unknown_fields() {
    // Р6, Ф15: only integers have one canonical spelling
    let mut header = file_header(1, "a.md");
    header.extra.insert("ratio".into(), json!(1.5));
    assert!(matches!(
        canonical_header_json(&header),
        Err(CryptoError::Malformed(_))
    ));
    assert!(seal_header(&vk(), &space(), &item(), &header, &mut OsRandom).is_err());
}

#[test]
fn newer_formats_are_refused_not_misread() {
    // Р13, С13, Ф19: format 2 is not understood and is reported as such
    let json = br#"{"body_id":null,"content_hash":null,"deleted":false,"format":2,"kind":"folder","mtime_ms":0,"path":"a","size":0,"version":1,"future":{"x":1}}"#;
    assert_eq!(
        parse_header_json(json).unwrap_err(),
        CryptoError::UnsupportedFormat(2)
    );
}

#[test]
fn parsing_rejects_malformed_headers_and_accepts_the_valid_one() {
    // Р6, С5, Ф14: types, hex length and case, kind, missing fields
    let valid = json!({
        "format": 1, "version": 3, "kind": "file", "path": "a.md", "size": 5, "mtime_ms": 1,
        "content_hash": "ab".repeat(32), "body_id": "cd".repeat(16), "deleted": false
    });
    let parsed = parse_header_json(valid.to_string().as_bytes()).unwrap();
    assert_eq!(parsed.path, "a.md");
    assert_eq!(parsed.content_hash, Some([0xAB; 32]));

    let broken = |field: &str, value: Value| -> Vec<u8> {
        let mut copy = valid.clone();
        match value {
            Value::Null if field.starts_with('-') => {
                copy.as_object_mut().unwrap().remove(&field[1..]);
            }
            other => {
                copy[field] = other;
            }
        }
        copy.to_string().into_bytes()
    };
    for bytes in [
        broken("-path", Value::Null),
        broken("-version", Value::Null),
        broken("-deleted", Value::Null),
        broken("kind", json!("symlink")),
        broken("kind", json!(1)),
        broken("size", json!(-1)),
        broken("size", json!("5")),
        broken("version", json!(-1)),
        broken("path", json!(5)),
        broken("deleted", json!("false")),
        broken("content_hash", json!("AB".repeat(32))),
        broken("content_hash", json!("ab".repeat(31))),
        broken("content_hash", json!("zz".repeat(32))),
        broken("body_id", json!("cd".repeat(15))),
        broken("mtime_ms", json!(1.5)),
        b"[]".to_vec(),
        b"null".to_vec(),
        b"{".to_vec(),
        b"".to_vec(),
        b"not json".to_vec(),
    ] {
        assert!(
            parse_header_json(&bytes).is_err(),
            "{}",
            String::from_utf8_lossy(&bytes)
        );
    }
}

/// The path rules of Ф33, written independently of the implementation.
fn path_syntax_ok(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.starts_with('/')
        && !path.ends_with('/')
        && !path.contains('\\')
        && !path.chars().any(|c| (c as u32) <= 0x1F || c as u32 == 0x7F)
        && path
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

#[test]
fn a_repeated_key_in_the_header_json_is_an_error() {
    // Р6, Р13, Ф16: parsers disagree about repeats, so none is accepted (top level and nested)
    let valid = br#"{"body_id":null,"content_hash":null,"deleted":false,"format":1,"kind":"folder","mtime_ms":0,"path":"a","size":0,"version":1}"#;
    assert!(parse_header_json(valid).is_ok(), "control");
    let top = br#"{"body_id":null,"content_hash":null,"deleted":false,"format":1,"kind":"folder","mtime_ms":0,"path":"a","size":0,"size":1,"version":1}"#;
    assert!(matches!(
        parse_header_json(top),
        Err(CryptoError::Malformed(_))
    ));
    let nested = br#"{"body_id":null,"content_hash":null,"deleted":false,"format":1,"kind":"folder","mtime_ms":0,"path":"a","size":0,"version":1,"x":{"a":1,"a":2}}"#;
    assert!(matches!(
        parse_header_json(nested),
        Err(CryptoError::Malformed(_))
    ));
    let same_name_in_two_objects = br#"{"body_id":null,"content_hash":null,"deleted":false,"format":1,"kind":"folder","mtime_ms":0,"path":"a","size":0,"version":1,"x":{"a":1},"y":{"a":2}}"#;
    assert!(
        parse_header_json(same_name_in_two_objects).is_ok(),
        "the same name in different objects is fine"
    );
}

#[test]
fn paths_that_could_leave_the_vault_are_refused() {
    // Р9, Р6, Ф33: every rule, when sealing, when producing JSON and when parsing
    let long_ok = "a".repeat(4096);
    let long_bad = "a".repeat(4097);
    let bad: Vec<(&str, String)> = vec![
        ("empty", String::new()),
        ("leading slash", "/a.md".into()),
        ("trailing slash", "a/".into()),
        ("only a slash", "/".into()),
        ("empty segment", "a//b.md".into()),
        ("dot segment", "a/./b.md".into()),
        ("single dot", ".".into()),
        ("dotdot", "..".into()),
        ("dotdot first", "../outside.md".into()),
        ("dotdot inside", "a/../../b.md".into()),
        ("dotdot last", "a/..".into()),
        ("backslash", "a\\b.md".into()),
        ("nul", "a\u{0}b.md".into()),
        ("tab", "a\tb.md".into()),
        ("newline", "a\nb.md".into()),
        ("unit separator", "a\u{1f}b.md".into()),
        ("delete", "a\u{7f}b.md".into()),
        ("too long", long_bad),
        // 1025 four-byte characters: 4100 bytes although only 1025 characters
        ("too long in bytes", "😀".repeat(1025)),
    ];
    for (why, path) in &bad {
        let header = file_header(1, path);
        assert_eq!(
            seal_header(&vk(), &space(), &item(), &header, &mut OsRandom).unwrap_err(),
            CryptoError::InvalidPath,
            "seal: {why}"
        );
        assert_eq!(
            canonical_header_json(&header).unwrap_err(),
            CryptoError::InvalidPath,
            "json: {why}"
        );
    }
    let good = [
        "a",
        "a.md",
        ".hidden",
        "a/.hidden/b",
        "..a",
        "a..",
        "a/b..c",
        "a/\u{2028}",
        "😀/😀.md",
        long_ok.as_str(),
        &"😀".repeat(1024),
    ];
    for path in good {
        let header = file_header(1, path);
        let envelope = seal_header(&vk(), &space(), &item(), &header, &mut OsRandom)
            .unwrap_or_else(|e| panic!("{path:?}: {e:?}"));
        assert_eq!(
            open_header(&vk(), &space(), &item(), 1, &envelope)
                .unwrap()
                .path,
            path
        );
    }
    // parsing refuses the same paths in a header that arrives from outside
    let json = |path: &str| {
        let mut value = json!({
            "format": 1, "version": 1, "kind": "folder", "path": "a", "size": 0, "mtime_ms": 0,
            "content_hash": null, "body_id": null, "deleted": false
        });
        value["path"] = json!(path);
        value.to_string().into_bytes()
    };
    assert!(parse_header_json(&json("a/b.md")).is_ok(), "control");
    for (why, path) in &bad {
        assert_eq!(
            parse_header_json(&json(path)).unwrap_err(),
            CryptoError::InvalidPath,
            "parse: {why}"
        );
    }
}

#[test]
fn the_path_syntax_is_checked_before_nfc() {
    // Р9, Ф33: a path that is bad twice reports the syntax error
    let nfd_and_bad = "../cafe\u{301}.md";
    assert_eq!(
        seal_header(
            &vk(),
            &space(),
            &item(),
            &file_header(1, nfd_and_bad),
            &mut OsRandom
        )
        .unwrap_err(),
        CryptoError::InvalidPath
    );
}

#[test]
fn an_epoch_of_zero_in_a_header_is_a_mismatch() {
    // Р5, Ф3, Ф18: opening says EpochMismatch, reading the epoch alone says Malformed
    let envelope = seal(&file_header(2, "a.md"));
    assert_eq!(header_envelope_epoch(&envelope).unwrap(), 1, "control");
    let mut zero = envelope.clone();
    zero[1..5].copy_from_slice(&0u32.to_be_bytes());
    assert_eq!(
        open_header(&vk(), &space(), &item(), 2, &zero),
        Err(CryptoError::EpochMismatch)
    );
    assert!(matches!(
        header_envelope_epoch(&zero),
        Err(CryptoError::Malformed(_))
    ));
    let mut two = envelope.clone();
    two[1..5].copy_from_slice(&2u32.to_be_bytes());
    assert_eq!(
        open_header(&vk(), &space(), &item(), 2, &two),
        Err(CryptoError::EpochMismatch)
    );
}

fn nfc_path() -> impl Strategy<Value = String> {
    // a valid path: 1–4 segments of printable characters, none of them `.` or `..` (Ф33), in NFC
    proptest::collection::vec(
        "[^/\\\\\\p{Cc}]{1,20}".prop_filter("not a dot segment", |segment| {
            segment != "." && segment != ".."
        }),
        1..4,
    )
    .prop_map(|segments| {
        segments
            .iter()
            .map(|segment| segment.nfc().collect::<String>())
            .collect::<Vec<_>>()
            .join("/")
    })
}

fn extra_fields() -> impl Strategy<Value = BTreeMap<String, Value>> {
    proptest::collection::btree_map(
        "x_[a-z\\u{e9}\\u{1F600}]{1,6}",
        (-1_000_000i64..1_000_000).prop_map(|n| json!(n)),
        0..4,
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn any_header_roundtrips(
        version in 1u64..1_000_000,
        path in nfc_path(),
        size in 0u64..(1 << 40),
        mtime_ms in -(1i64 << 50)..(1i64 << 50),
        hash in any::<[u8; 32]>(),
        body in any::<[u8; 16]>(),
        is_folder in any::<bool>(),
        deleted in any::<bool>(),
        extra in extra_fields(),
        seed in any::<u64>(),
    ) {
        // Р2, Р6, Р13, О7: seal then open returns the same header; the envelope is a multiple of 256 plus 45
        let header = Header {
            format: 1,
            version,
            kind: if is_folder { ItemKind::Folder } else { ItemKind::File },
            path,
            size,
            mtime_ms,
            content_hash: (!is_folder).then_some(hash),
            body_id: (!is_folder).then(|| BodyId::from_bytes(body)),
            deleted,
            extra,
        };
        let envelope = seal_header(&vk(), &space(), &item(), &header, &mut SeedRandom(seed)).unwrap();
        prop_assert_eq!((envelope.len() - 45) % 256, 0);
        prop_assert_eq!(open_header(&vk(), &space(), &item(), version, &envelope).unwrap(), header);
    }

    #[test]
    fn no_accepted_path_leaves_the_vault(
        parts in proptest::collection::vec(
            proptest::sample::select(vec!["a", "b", ".", "..", "/", "//", "\\", "\u{1}", "\u{7f}", "é", "e\u{301}", " ", "😀", "x/y", "../.."]),
            0..8,
        ),
    ) {
        // Р9, Р6, Ф33: whatever is accepted has only ordinary segments, below the root
        let path: String = parts.concat();
        let result = seal_header(&vk(), &space(), &item(), &file_header(1, &path), &mut SeedRandom(5));
        if !path_syntax_ok(&path) {
            prop_assert_eq!(result.unwrap_err(), CryptoError::InvalidPath);
        } else if path.nfc().collect::<String>() != path {
            prop_assert_eq!(result.unwrap_err(), CryptoError::PathNotNfc);
        } else {
            let envelope = result.unwrap();
            let opened = open_header(&vk(), &space(), &item(), 1, &envelope).unwrap();
            prop_assert_eq!(&opened.path, &path);
            prop_assert!(!std::path::Path::new(&path).is_absolute());
            prop_assert!(std::path::Path::new(&path)
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_))));
            prop_assert!(!path.contains('\\'));
        }
    }

    #[test]
    fn any_flipped_byte_is_rejected(position in 0usize..2048, mask in 1u8..=255, seed in any::<u64>()) {
        // Р6, С5: tampering anywhere never opens
        let header = file_header(9, "Notes/some note.md");
        let envelope = seal_header(&vk(), &space(), &item(), &header, &mut SeedRandom(seed)).unwrap();
        prop_assert!(open_header(&vk(), &space(), &item(), 9, &envelope).is_ok());
        let mut changed = envelope.clone();
        let at = position % changed.len();
        changed[at] ^= mask;
        prop_assert!(open_header(&vk(), &space(), &item(), 9, &changed).is_err());
    }

    #[test]
    fn arbitrary_bytes_are_never_a_header(bytes in proptest::collection::vec(any::<u8>(), 0..800)) {
        // Р6, С5: what comes from the server is never trusted; no panic, no header
        prop_assert!(open_header(&vk(), &space(), &item(), 1, &bytes).is_err());
        let _ = parse_header_json(&bytes);
        let _ = header_envelope_epoch(&bytes);
    }
}
