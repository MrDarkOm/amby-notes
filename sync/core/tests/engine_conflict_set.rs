//! The set of a conflict in `.amby/conflicts/<id>/` (docs/sync-plan.md, appendix Г, К2: Г20–Г24):
//! where its files lie, how its identifier is made, the exact bytes of `meta.json`, and how a
//! damaged `meta.json` is refused. Red until written: the functions are `todo!()` today.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_core::crypto::keys::ItemId;
use amby_sync_core::engine::conflict_set::{
    decode_meta, encode_meta, is_in_conflicts_dir, set_id, set_paths, MetaError, SetMeta,
    CONFLICTS_DIR,
};
use amby_sync_core::engine::names::conflict_id;
use amby_sync_core::engine::ConflictKind;
use proptest::prelude::*;

const ID: &str = "0123456789ab";

fn item(byte: u8) -> ItemId {
    ItemId::from_bytes([byte; 16])
}

// ----- paths -----

#[test]
fn the_files_of_a_set_lie_in_its_folder() {
    // Г21, Г24
    assert_eq!(CONFLICTS_DIR, ".amby/conflicts");
    let paths = set_paths(ID, "Notes/Plan.md");
    assert_eq!(paths.dir, ".amby/conflicts/0123456789ab");
    assert_eq!(paths.other, ".amby/conflicts/0123456789ab/other.md");
    assert_eq!(paths.base, ".amby/conflicts/0123456789ab/base.md");
    assert_eq!(paths.meta, ".amby/conflicts/0123456789ab/meta.json");
}

#[test]
fn the_extension_of_the_original_is_kept_when_it_is_short_and_plain() {
    // Г21: 1–8 characters of A–Z a–z 0–9 after the last dot of the last segment
    for (original, ext) in [
        ("a.md", ".md"),
        ("A.MD", ".MD"),
        ("dir/sub/photo.png", ".png"),
        ("archive.tar.gz", ".gz"),
        ("x.a", ".a"),
        ("x.12345678", ".12345678"),
        ("Заметка.md", ".md"),
    ] {
        let paths = set_paths(ID, original);
        assert_eq!(
            paths.other,
            format!(".amby/conflicts/{ID}/other{ext}"),
            "{original}"
        );
        assert_eq!(
            paths.base,
            format!(".amby/conflicts/{ID}/base{ext}"),
            "{original}"
        );
        assert_eq!(paths.meta, format!(".amby/conflicts/{ID}/meta.json"));
    }
}

#[test]
fn no_extension_when_there_is_none_or_it_is_odd() {
    // Г21
    for original in [
        "README",
        ".env",
        "dir.v2/file",
        "trailing.",
        "x.123456789",
        "x.my-ext",
        "x.мд",
        "x.a b",
        "dir/.hidden",
    ] {
        let paths = set_paths(ID, original);
        assert_eq!(
            paths.other,
            format!(".amby/conflicts/{ID}/other"),
            "{original}"
        );
        assert_eq!(
            paths.base,
            format!(".amby/conflicts/{ID}/base"),
            "{original}"
        );
    }
}

#[test]
fn the_conflicts_folder_is_recognised_at_the_root_only() {
    // Г19, Г24
    for path in [
        ".amby/conflicts",
        ".amby/conflicts/",
        ".amby/conflicts/0123456789ab",
        ".amby/conflicts/0123456789ab/other.md",
        ".amby/conflicts/0123456789ab/meta.json",
    ] {
        assert!(is_in_conflicts_dir(path), "{path}");
    }
    for path in [
        ".amby/conflictsX/a",
        ".amby/conflicts-old/a",
        ".amby/trash/conflicts/a",
        "amby/conflicts/a",
        "Notes/.amby/conflicts/a",
        "conflicts/a",
        ".amby",
        "Notes/a.md",
        "",
    ] {
        assert!(!is_in_conflicts_dir(path), "{path}");
    }
}

// ----- the identifier -----

/// The formula of Г22 written out with BLAKE3 directly.
fn expected_id(
    item: &ItemId,
    local: &[u8; 32],
    version: u64,
    base: Option<&[u8; 32]>,
    attempt: u32,
) -> String {
    let mut data = b"amby-sync/conflict/2".to_vec();
    data.extend_from_slice(item.as_bytes());
    data.extend_from_slice(local);
    data.extend_from_slice(&version.to_be_bytes());
    data.extend_from_slice(base.unwrap_or(&[0u8; 32]));
    if attempt != 0 {
        data.extend_from_slice(&attempt.to_be_bytes());
    }
    let digest = blake3::hash(&data);
    digest.as_bytes()[..6]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn the_identifier_follows_the_formula_of_the_plan() {
    // Г22
    let (it, local, base) = (item(7), [0xAB; 32], [0xCD; 32]);
    for (version, base, attempt) in [
        (1u64, None, 0u32),
        (1, Some(&base), 0),
        (258, Some(&base), 0),
        (3, None, 1),
        (3, Some(&base), 5),
    ] {
        let id = set_id(&it, &local, version, base, attempt);
        assert_eq!(id, expected_id(&it, &local, version, base, attempt));
        assert_eq!(id.len(), 12);
        assert!(id
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }
}

#[test]
fn a_missing_base_counts_as_thirty_two_zero_bytes() {
    // Г22
    let (it, local) = (item(1), [1u8; 32]);
    assert_eq!(
        set_id(&it, &local, 4, None, 0),
        set_id(&it, &local, 4, Some(&[0u8; 32]), 0)
    );
}

#[test]
fn every_input_changes_the_identifier() {
    // Г22: two devices with a different base, version, local content, item or attempt never
    // write one set under one name
    let (it, local, base) = (item(1), [1u8; 32], [2u8; 32]);
    let reference = set_id(&it, &local, 4, Some(&base), 0);
    let others = [
        set_id(&item(2), &local, 4, Some(&base), 0),
        set_id(&it, &[9u8; 32], 4, Some(&base), 0),
        set_id(&it, &local, 5, Some(&base), 0),
        set_id(&it, &local, 4, Some(&[3u8; 32]), 0),
        set_id(&it, &local, 4, None, 0),
        set_id(&it, &local, 4, Some(&base), 1),
        set_id(&it, &local, 4, Some(&base), 2),
    ];
    for other in &others {
        assert_ne!(*other, reference);
    }
    let mut all = others.to_vec();
    all.push(reference);
    all.sort();
    all.dedup();
    assert_eq!(
        all.len(),
        others.len() + 1,
        "all different from each other too"
    );
}

#[test]
fn the_identifier_repeats_and_is_not_the_old_one() {
    // Г22, Д4: a repeat after a crash makes the same set; Д46: the old formula stays for old copies
    let (it, local) = (item(5), [8u8; 32]);
    assert_eq!(
        set_id(&it, &local, 2, None, 0),
        set_id(&it, &local, 2, None, 0)
    );
    assert_ne!(
        set_id(&it, &local, 2, None, 0),
        conflict_id(&it, &local, 2, 0),
        "another domain string"
    );
}

// ----- meta.json -----

fn sample() -> SetMeta {
    SetMeta {
        id: ID.into(),
        kind: ConflictKind::BothEdited,
        item_id: item(0xAB),
        path: "Notes/Plan.md".into(),
        other: "other.md".into(),
        other_hash: [0x11; 32],
        other_size: 1234,
        base: Some("base.md".into()),
        base_hash: Some([0x22; 32]),
    }
}

#[test]
fn meta_json_is_exactly_these_bytes() {
    // Г21: compact, keys in this order, lowercase hex, no final newline
    let expected = format!(
        "{{\"v\":1,\"id\":\"{ID}\",\"kind\":\"bothEdited\",\"item_id\":\"{}\",\"path\":\"Notes/Plan.md\",\"other\":\"other.md\",\"other_hash\":\"{}\",\"other_size\":1234,\"base\":\"base.md\",\"base_hash\":\"{}\"}}",
        "ab".repeat(16),
        "11".repeat(32),
        "22".repeat(32),
    );
    assert_eq!(String::from_utf8(encode_meta(&sample())).unwrap(), expected);
}

#[test]
fn a_set_without_a_base_writes_null_twice_and_the_other_kind() {
    // Г21
    let meta = SetMeta {
        kind: ConflictKind::BothCreated,
        base: None,
        base_hash: None,
        ..sample()
    };
    let text = String::from_utf8(encode_meta(&meta)).unwrap();
    assert!(text.contains("\"kind\":\"bothCreated\""), "{text}");
    assert!(
        text.ends_with("\"base\":null,\"base_hash\":null}"),
        "{text}"
    );
}

#[test]
fn text_in_meta_is_utf8_not_escaped_and_specials_are_escaped() {
    // Г21: a path in any script is written as it is; quote, backslash and control characters are
    // escaped the way JSON says
    let meta = SetMeta {
        path: "Заметки/日本語 \"q\" \\ \u{1}.md".into(),
        ..sample()
    };
    let text = String::from_utf8(encode_meta(&meta)).unwrap();
    assert!(
        text.contains("\"path\":\"Заметки/日本語 \\\"q\\\" \\\\ \\u0001.md\""),
        "{text}"
    );
    assert_eq!(decode_meta(text.as_bytes()).unwrap(), meta);
}

#[test]
fn the_same_set_gives_the_same_bytes_on_every_device() {
    // Г21: nothing depends on the device or the time
    assert_eq!(encode_meta(&sample()), encode_meta(&sample()));
    let text = String::from_utf8(encode_meta(&sample())).unwrap();
    for word in ["time", "ms", "device", "created"] {
        assert!(!text.contains(word), "{word} in {text}");
    }
}

#[test]
fn meta_is_read_back_unchanged() {
    // Г21, Г23
    let meta = sample();
    assert_eq!(decode_meta(&encode_meta(&meta)).unwrap(), meta);
    let created = SetMeta {
        kind: ConflictKind::BothCreated,
        base: None,
        base_hash: None,
        ..sample()
    };
    assert_eq!(decode_meta(&encode_meta(&created)).unwrap(), created);
}

#[test]
fn meta_written_by_hand_with_other_spacing_order_and_extra_keys_is_read() {
    // Г21, Р13: a newer build may add keys; spacing and order do not matter
    let text = format!(
        "{{\n  \"extra\": [1, 2, {{\"x\": null}}],\n  \"base_hash\": null, \"base\": null,\n  \"other_size\": 7,\n  \"other_hash\": \"{}\",\n  \"other\": \"other\",\n  \"path\": \"x\",\n  \"item_id\": \"{}\",\n  \"kind\": \"bothCreated\",\n  \"id\": \"{ID}\",\n  \"v\": 1\n}}\n",
        "00".repeat(32),
        "0f".repeat(16),
    );
    let meta = decode_meta(text.as_bytes()).unwrap();
    assert_eq!(meta.id, ID);
    assert_eq!(meta.kind, ConflictKind::BothCreated);
    assert_eq!(meta.item_id, ItemId::from_bytes([0x0f; 16]));
    assert_eq!(meta.other_size, 7);
    assert_eq!(meta.base, None);
}

fn with_field(key: &str, value: &str) -> Vec<u8> {
    // The sample meta with one field replaced (value is raw JSON).
    let mut json: serde_json::Value =
        serde_json::from_slice(&encode_meta(&sample())).expect("the sample is JSON");
    json[key] = serde_json::from_str(value).expect("a JSON value");
    serde_json::to_vec(&json).unwrap()
}

fn without_field(key: &str) -> Vec<u8> {
    let mut json: serde_json::Value = serde_json::from_slice(&encode_meta(&sample())).unwrap();
    json.as_object_mut().unwrap().remove(key);
    serde_json::to_vec(&json).unwrap()
}

#[test]
fn a_meta_with_a_missing_or_wrong_field_is_malformed() {
    // Г23
    for key in [
        "v",
        "id",
        "kind",
        "item_id",
        "path",
        "other",
        "other_hash",
        "other_size",
        "base",
        "base_hash",
    ] {
        assert_eq!(
            decode_meta(&without_field(key)),
            Err(MetaError::Malformed),
            "without {key}"
        );
    }
    for (key, value) in [
        ("kind", "\"bothEverything\""),
        ("kind", "1"),
        ("id", "\"ABCDEF012345\""),  // upper case
        ("id", "\"0123456789a\""),   // 11 characters
        ("id", "\"0123456789abc\""), // 13 characters
        ("id", "\"0123456789ag\""),  // not hex
        ("item_id", "\"abcd\""),
        ("other_hash", "\"ab\""),
        ("other_hash", "7"),
        ("other_size", "-1"),
        ("other_size", "1.5"),
        ("other_size", "\"12\""),
        ("path", "5"),
        ("other", "null"),
        ("base", "7"),
        ("base_hash", "\"zz\""),
    ] {
        assert_eq!(
            decode_meta(&with_field(key, value)),
            Err(MetaError::Malformed),
            "{key} = {value}"
        );
    }
}

#[test]
fn a_base_without_its_hash_or_a_hash_without_its_base_is_malformed() {
    // Г21, Г23: both or neither
    assert_eq!(
        decode_meta(&with_field("base_hash", "null")),
        Err(MetaError::Malformed)
    );
    assert_eq!(
        decode_meta(&with_field("base", "null")),
        Err(MetaError::Malformed)
    );
}

#[test]
fn something_that_is_not_json_is_malformed() {
    // Г23
    for bytes in [
        b"".as_slice(),
        b"{",
        b"[1,2]",
        b"null",
        b"\xff\xfe",
        b"{\"v\":1} trailing",
    ] {
        assert_eq!(decode_meta(bytes), Err(MetaError::Malformed), "{bytes:?}");
    }
}

#[test]
fn a_newer_version_of_the_format_is_not_read() {
    // Г21, Р13: the set is not listed
    assert_eq!(
        decode_meta(&with_field("v", "2")),
        Err(MetaError::UnsupportedVersion(2))
    );
    assert_eq!(
        decode_meta(&with_field("v", "99")),
        Err(MetaError::UnsupportedVersion(99))
    );
    assert_eq!(
        decode_meta(&with_field("v", "0")),
        Err(MetaError::Malformed)
    );
    assert_eq!(
        decode_meta(&with_field("v", "\"1\"")),
        Err(MetaError::Malformed)
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    #[test]
    fn any_meta_is_read_back_and_written_the_same(
        id in "[0-9a-f]{12}",
        both_created in any::<bool>(),
        item_bytes in any::<[u8; 16]>(),
        path in "\\PC{1,40}",
        ext in "(\\.[a-z0-9]{1,8})?",
        other_hash in any::<[u8; 32]>(),
        other_size in 0u64..(1 << 40),
        base in proptest::option::of((any::<[u8; 32]>(), "(\\.[a-z0-9]{1,8})?")),
    ) {
        // Г21
        let meta = SetMeta {
            id,
            kind: if both_created { ConflictKind::BothCreated } else { ConflictKind::BothEdited },
            item_id: ItemId::from_bytes(item_bytes),
            path,
            other: format!("other{ext}"),
            other_hash,
            other_size,
            base_hash: base.as_ref().map(|(h, _)| *h),
            base: base.map(|(_, e)| format!("base{e}")),
        };
        let bytes = encode_meta(&meta);
        prop_assert!(!bytes.ends_with(b"\n") && !bytes.contains(&b' ') || meta.path.contains(' '));
        let back = decode_meta(&bytes).unwrap();
        prop_assert_eq!(&back, &meta);
        prop_assert_eq!(encode_meta(&back), bytes);
    }
}
