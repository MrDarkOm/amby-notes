//! The port of the store of conflicts for the interface (docs/sync-plan.md, appendix Г, К2:
//! Г20–Г36): the list, the two versions, the resolution — for sets in `.amby/conflicts/<id>/` and
//! for copies made before stage Э4б. The files are built by hand here, so these tests do not
//! depend on the engine. Red until written: the methods are `todo!()` today.

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, SystemTime};

use amby_sync_core::crypto::primitives::blake3_hash;
use sha2::{Digest, Sha256};

use super::conflict_store::{
    ConflictEntry, ConflictError, ConflictSource, ConflictStore, FileConflictStore, Resolution,
};
use super::test_support::TempVault;

const ID: &str = "0123456789ab";
const ITEM: &str = "d4e73ba99658c22f9c501b589feeddb5";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Writes the files of a set as the engine would (the second version, the base, `meta.json` last).
#[allow(clippy::too_many_arguments)]
fn make_set(
    vault: &TempVault,
    id: &str,
    kind: &str,
    item: &str,
    path: &str,
    other_name: &str,
    other: &[u8],
    base: Option<(&str, &[u8])>,
) {
    let dir = format!(".amby/conflicts/{id}");
    vault.put(&format!("{dir}/{other_name}"), other);
    let (base_name, base_hash) = match base {
        Some((name, bytes)) => {
            vault.put(&format!("{dir}/{name}"), bytes);
            (
                serde_json::to_string(name).unwrap(),
                format!("\"{}\"", hex(&blake3_hash(bytes))),
            )
        }
        None => ("null".into(), "null".into()),
    };
    let meta = format!(
        "{{\"v\":1,\"id\":\"{id}\",\"kind\":\"{kind}\",\"item_id\":\"{item}\",\"path\":{},\"other\":{},\"other_hash\":\"{}\",\"other_size\":{},\"base\":{base_name},\"base_hash\":{base_hash}}}",
        serde_json::to_string(path).unwrap(),
        serde_json::to_string(other_name).unwrap(),
        hex(&blake3_hash(other)),
        other.len()
    );
    vault.put(&format!("{dir}/meta.json"), meta.as_bytes());
}

fn store(vault: &TempVault) -> FileConflictStore {
    FileConflictStore::new(vault.root.clone(), BTreeMap::new(), BTreeSet::new())
}

fn entry(vault: &TempVault) -> ConflictEntry {
    let mut listed = store(vault).list().unwrap();
    assert_eq!(listed.len(), 1, "{listed:?}");
    listed.remove(0)
}

fn note_with_id(id: &str, body: &str) -> Vec<u8> {
    format!("---\namby-id: {id}\n---\n{body}").into_bytes()
}

fn listing_id(copy: &str) -> String {
    let digest = Sha256::digest(format!("amby-sync/conflict-listing/1\n{copy}"));
    hex(&digest[..6])
}

/// A vault with `Notes/n.md` ("current") and a set holding "other" and "base".
fn vault_with_a_set() -> TempVault {
    let vault = TempVault::new("conflicts");
    vault.put("Notes/n.md", b"current\n");
    make_set(
        &vault,
        ID,
        "bothEdited",
        ITEM,
        "Notes/n.md",
        "other.md",
        b"other\n",
        Some(("base.md", b"base\n")),
    );
    vault
}

fn set_files(vault: &TempVault) -> Vec<String> {
    let mut found: Vec<String> = walkdir::WalkDir::new(vault.root.join(".amby/conflicts"))
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .map(|e| {
            e.path()
                .strip_prefix(&vault.root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect();
    found.sort();
    found
}

// ----- the list -----

#[test]
fn a_complete_set_is_listed_with_what_the_interface_needs() {
    // Г25, Г31, Г32: `list` needs no network and no pass
    let vault = vault_with_a_set();
    let listed = entry(&vault);
    assert_eq!(listed.id, ID);
    assert_eq!(listed.kind, "bothEdited");
    assert_eq!(listed.path, "Notes/n.md");
    assert_eq!(listed.other_path, format!(".amby/conflicts/{ID}/other.md"));
    assert_eq!(listed.source, ConflictSource::Bundle);
    assert!(
        listed.text,
        "a Markdown note can be compared by lines (Г28)"
    );
    assert!(listed.has_base);
    assert!(!listed.created_here);
    assert!(
        listed.created_ms > 0,
        "the time of the meta.json file, for display"
    );
}

#[test]
fn the_current_path_of_the_item_wins_over_the_path_in_meta() {
    // Г27: a rename of the original does not cut the link
    let vault = vault_with_a_set();
    let mut paths = BTreeMap::new();
    paths.insert(ITEM.to_string(), "Archive/Renamed.md".to_string());
    let mut store = FileConflictStore::new(vault.root.clone(), paths, BTreeSet::new());
    let listed = store.list().unwrap();
    assert_eq!(listed[0].path, "Archive/Renamed.md");
}

#[test]
fn a_set_made_on_this_computer_says_so() {
    // Г25, Г34: `createdHere` comes from the ids in the state
    let vault = vault_with_a_set();
    let mut here = BTreeSet::new();
    here.insert(ID.to_string());
    let mut store = FileConflictStore::new(vault.root.clone(), BTreeMap::new(), here);
    assert!(store.list().unwrap()[0].created_here);
}

#[test]
fn a_conflict_of_two_new_files_has_no_base() {
    // Г21, Г32
    let vault = TempVault::new("conflicts");
    vault.put("c.md", b"zero");
    make_set(
        &vault,
        ID,
        "bothCreated",
        ITEM,
        "c.md",
        "other.md",
        b"one",
        None,
    );
    let listed = entry(&vault);
    assert_eq!(listed.kind, "bothCreated");
    assert!(!listed.has_base);
}

#[test]
fn a_binary_conflict_is_not_text() {
    // Г28
    let vault = TempVault::new("conflicts");
    vault.put("assets/pic.png", &[0x89, b'P', b'N', b'G', 1]);
    make_set(
        &vault,
        ID,
        "bothEdited",
        ITEM,
        "assets/pic.png",
        "other.png",
        &[0x89, b'P', b'N', b'G', 2],
        None,
    );
    assert!(!entry(&vault).text);
}

#[test]
fn a_markdown_note_that_is_not_utf8_or_is_too_big_is_not_text_either() {
    // Г28, Г5
    let vault = TempVault::new("conflicts");
    vault.put("Notes/n.md", b"fine\n");
    make_set(
        &vault,
        ID,
        "bothEdited",
        ITEM,
        "Notes/n.md",
        "other.md",
        b"not utf8: \xff\xfe\n",
        None,
    );
    assert!(!entry(&vault).text);
    let vault = TempVault::new("conflicts");
    vault.put("Notes/n.md", b"fine\n");
    make_set(
        &vault,
        ID,
        "bothEdited",
        ITEM,
        "Notes/n.md",
        "other.md",
        &vec![b'x'; 1024 * 1024 + 1],
        None,
    );
    assert!(!entry(&vault).text);
}

#[test]
fn an_unfinished_or_damaged_set_is_not_listed() {
    // Г23: only `meta.json` plus an `other` that matches it make a set
    let vault = TempVault::new("conflicts");
    vault.put("Notes/n.md", b"current\n");
    // only the second version
    vault.put(".amby/conflicts/aaaaaaaaaaaa/other.md", b"half a set");
    // a meta.json without its other file
    vault.put(
        ".amby/conflicts/bbbbbbbbbbbb/meta.json",
        b"{\"v\":1,\"id\":\"bbbbbbbbbbbb\",\"kind\":\"bothEdited\",\"item_id\":\"d4e73ba99658c22f9c501b589feeddb5\",\"path\":\"Notes/n.md\",\"other\":\"other.md\",\"other_hash\":\"00\",\"other_size\":1,\"base\":null,\"base_hash\":null}",
    );
    // a meta.json that is not JSON
    vault.put(".amby/conflicts/cccccccccccc/meta.json", b"not json");
    // a set whose other file changed after meta.json was written
    make_set(
        &vault,
        "dddddddddddd",
        "bothEdited",
        ITEM,
        "Notes/n.md",
        "other.md",
        b"good",
        None,
    );
    vault.put(".amby/conflicts/dddddddddddd/other.md", b"tampered");
    // a set from a newer build
    make_set(
        &vault,
        "eeeeeeeeeeee",
        "bothEdited",
        ITEM,
        "Notes/n.md",
        "other.md",
        b"newer",
        None,
    );
    let meta = vault
        .text(".amby/conflicts/eeeeeeeeeeee/meta.json")
        .unwrap();
    vault.put(
        ".amby/conflicts/eeeeeeeeeeee/meta.json",
        meta.replacen("\"v\":1", "\"v\":2", 1).as_bytes(),
    );
    // and a good one
    make_set(
        &vault,
        ID,
        "bothEdited",
        ITEM,
        "Notes/n.md",
        "other.md",
        b"other\n",
        None,
    );
    let listed = store(&vault).list().unwrap();
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(listed[0].id, ID);
}

#[test]
fn the_list_is_ordered_by_time_then_id() {
    // Г32
    let vault = TempVault::new("conflicts");
    vault.put("Notes/a.md", b"a");
    vault.put("Notes/b.md", b"b");
    vault.put("Notes/c.md", b"c");
    for (id, path) in [
        ("111111111111", "Notes/a.md"),
        ("222222222222", "Notes/b.md"),
        ("333333333333", "Notes/c.md"),
    ] {
        make_set(
            &vault,
            id,
            "bothEdited",
            ITEM,
            path,
            "other.md",
            id.as_bytes(),
            None,
        );
    }
    let later = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
    let earlier = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    for (id, time) in [
        ("111111111111", later),
        ("222222222222", earlier),
        ("333333333333", earlier),
    ] {
        let meta = std::fs::File::options()
            .write(true)
            .open(vault.root.join(format!(".amby/conflicts/{id}/meta.json")))
            .unwrap();
        meta.set_modified(time).unwrap();
    }
    let ids: Vec<String> = store(&vault)
        .list()
        .unwrap()
        .into_iter()
        .map(|e| e.id)
        .collect();
    assert_eq!(ids, vec!["222222222222", "333333333333", "111111111111"]);
}

#[test]
fn no_conflicts_is_an_empty_list() {
    // Г32
    let vault = TempVault::new("conflicts");
    vault.put("Notes/n.md", b"x");
    assert_eq!(store(&vault).list().unwrap(), Vec::new());
}

// ----- old copies (Г29) -----

#[test]
fn a_copy_made_before_the_sets_is_still_listed_as_a_conflict() {
    // Г29: `Name.<12 hex>-conflict.ext` next to the file, repeating its `amby-id`
    let vault = TempVault::new("conflicts");
    vault.put("Notes/n.md", &note_with_id("01ARZ", "mine"));
    vault.put(
        "Notes/n.0123456789ab-conflict.md",
        &note_with_id("01ARZ", "theirs"),
    );
    let listed = entry(&vault);
    assert_eq!(listed.source, ConflictSource::LegacyCopy);
    assert_eq!(listed.path, "Notes/n.md");
    assert_eq!(listed.other_path, "Notes/n.0123456789ab-conflict.md");
    assert_eq!(listed.kind, "bothEdited");
    assert!(listed.text);
    assert!(!listed.has_base, "an old copy has no common base");
    assert_eq!(
        listed.id,
        listing_id("Notes/n.0123456789ab-conflict.md"),
        "the id of a listing derived from the path of the copy, as before"
    );
}

#[test]
fn a_copy_with_an_identity_of_its_own_or_without_its_file_is_not_a_conflict() {
    // Г29, vault-format.md: "keep both" made it an ordinary note
    let vault = TempVault::new("conflicts");
    vault.put("Notes/n.md", &note_with_id("01ARZ", "mine"));
    vault.put(
        "Notes/n.0123456789ab-conflict.md",
        &note_with_id("01OTHER", "its own note"),
    );
    vault.put(
        "Notes/gone.0123456789ab-conflict.md",
        &note_with_id("01ARZ", "the file is gone"),
    );
    assert_eq!(store(&vault).list().unwrap(), Vec::new());
}

#[test]
fn sets_and_old_copies_are_listed_together() {
    // Г25, Г29
    let vault = vault_with_a_set();
    vault.put("Notes/m.md", &note_with_id("01ARZ", "mine"));
    vault.put(
        "Notes/m.0123456789ab-conflict.md",
        &note_with_id("01ARZ", "theirs"),
    );
    let sources: BTreeSet<String> = store(&vault)
        .list()
        .unwrap()
        .into_iter()
        .map(|e| format!("{:?}", e.source))
        .collect();
    assert_eq!(
        sources,
        BTreeSet::from(["Bundle".to_string(), "LegacyCopy".to_string()])
    );
}

// ----- the two versions -----

#[test]
fn both_versions_and_the_base_are_read_exactly() {
    // Г33: sizes, hashes and the text as the bytes read as UTF-8, a BOM as U+FEFF and \r\n kept
    let vault = TempVault::new("conflicts");
    let current = "\u{feff}current\r\nline\r\n";
    let other = "other\r\nбез перевода строки в конце";
    let base = "base\r\n";
    vault.put("Notes/n.md", current.as_bytes());
    make_set(
        &vault,
        ID,
        "bothEdited",
        ITEM,
        "Notes/n.md",
        "other.md",
        other.as_bytes(),
        Some(("base.md", base.as_bytes())),
    );
    let versions = store(&vault).read(ID).unwrap();
    assert_eq!(versions.entry.id, ID);
    assert_eq!(versions.current.text.as_deref(), Some(current));
    assert_eq!(versions.other.text.as_deref(), Some(other));
    assert_eq!(versions.base.as_ref().unwrap().text.as_deref(), Some(base));
    assert_eq!(versions.current.size as usize, current.len());
    assert_eq!(versions.other.size as usize, other.len());
    assert_eq!(versions.other.hash, hex(&blake3_hash(other.as_bytes())));
    assert_eq!(
        versions.base.as_ref().unwrap().hash,
        hex(&blake3_hash(base.as_bytes()))
    );
}

#[test]
fn a_conflict_that_is_not_text_gives_sizes_and_hashes_but_no_bytes() {
    // Г28, Г33
    let vault = TempVault::new("conflicts");
    vault.put("assets/pic.png", &[0x89, b'P', b'N', b'G', 1]);
    make_set(
        &vault,
        ID,
        "bothEdited",
        ITEM,
        "assets/pic.png",
        "other.png",
        &[0x89, b'P', b'N', b'G', 2, 2],
        None,
    );
    let versions = store(&vault).read(ID).unwrap();
    assert_eq!(versions.current.text, None);
    assert_eq!(versions.other.text, None);
    assert_eq!(versions.other.size, 6);
    assert!(versions.base.is_none());
}

#[test]
fn an_old_copy_reads_as_two_versions_and_no_base() {
    // Г29, Г33
    let vault = TempVault::new("conflicts");
    vault.put("Notes/n.md", &note_with_id("01ARZ", "mine"));
    vault.put(
        "Notes/n.0123456789ab-conflict.md",
        &note_with_id("01ARZ", "theirs"),
    );
    let id = listing_id("Notes/n.0123456789ab-conflict.md");
    let versions = store(&vault).read(&id).unwrap();
    assert_eq!(
        versions.current.text.as_deref(),
        Some("---\namby-id: 01ARZ\n---\nmine")
    );
    assert_eq!(
        versions.other.text.as_deref(),
        Some("---\namby-id: 01ARZ\n---\ntheirs")
    );
    assert!(versions.base.is_none());
}

#[test]
fn reading_an_unknown_or_unfinished_conflict_is_refused() {
    // Г35
    let vault = vault_with_a_set();
    vault.put(".amby/conflicts/aaaaaaaaaaaa/other.md", b"half a set");
    let mut store = store(&vault);
    assert_eq!(
        store.read("ffffffffffff").unwrap_err(),
        ConflictError::NotFound
    );
    assert_eq!(
        store.read("aaaaaaaaaaaa").unwrap_err(),
        ConflictError::Incomplete
    );
}

// ----- resolving -----

fn trashed_originals(vault: &TempVault) -> Vec<String> {
    vault.trashed()
}

#[test]
fn keeping_the_current_file_removes_the_set_to_the_trash() {
    // Г26 (2): the second version stays recoverable in the vault trash
    let vault = vault_with_a_set();
    store(&vault).resolve(ID, Resolution::Current).unwrap();
    assert_eq!(vault.text("Notes/n.md").as_deref(), Some("current\n"));
    assert!(set_files(&vault).is_empty(), "{:?}", set_files(&vault));
    let trashed = trashed_originals(&vault);
    for name in ["other.md", "base.md", "meta.json"] {
        assert!(
            trashed.contains(&format!(".amby/conflicts/{ID}/{name}")),
            "{name} is in the trash: {trashed:?}"
        );
    }
    assert!(
        vault.snapshots("Notes/n.md").is_empty(),
        "the file was not written"
    );
    assert_eq!(store(&vault).list().unwrap(), Vec::new());
}

#[test]
fn taking_the_other_version_replaces_the_file_with_a_snapshot() {
    // Г26 (1): an ordinary write with the old content in the history
    let vault = vault_with_a_set();
    store(&vault).resolve(ID, Resolution::Other).unwrap();
    assert_eq!(vault.text("Notes/n.md").as_deref(), Some("other\n"));
    assert!(
        vault
            .snapshots("Notes/n.md")
            .iter()
            .any(|(reason, text)| reason == "sync-overwrite" && text == "current\n"),
        "{:?}",
        vault.snapshots("Notes/n.md")
    );
    assert!(set_files(&vault).is_empty());
}

#[test]
fn an_assembled_text_is_written_byte_for_byte() {
    // Г33: BOM, CRLF, no newline at the end, a NFD letter: nothing is added or normalised
    let vault = vault_with_a_set();
    let text = "\u{feff}first\r\nsecond e\u{301}\nno newline at the end";
    store(&vault)
        .resolve(ID, Resolution::Assembled { text: text.into() })
        .unwrap();
    assert_eq!(vault.bytes("Notes/n.md").as_deref(), Some(text.as_bytes()));
    assert!(vault
        .snapshots("Notes/n.md")
        .iter()
        .any(|(reason, text)| reason == "sync-overwrite" && text == "current\n"));
    assert!(set_files(&vault).is_empty());
}

#[test]
fn an_assembled_text_for_a_file_that_is_not_text_is_refused_and_nothing_changes() {
    // Г28, Г35
    let vault = TempVault::new("conflicts");
    vault.put("assets/pic.png", &[0x89, b'P', b'N', b'G', 1]);
    make_set(
        &vault,
        ID,
        "bothEdited",
        ITEM,
        "assets/pic.png",
        "other.png",
        &[0x89, b'P', b'N', b'G', 2],
        None,
    );
    let error = store(&vault)
        .resolve(ID, Resolution::Assembled { text: "x".into() })
        .unwrap_err();
    assert_eq!(error, ConflictError::NotText);
    assert_eq!(
        vault.bytes("assets/pic.png").unwrap(),
        vec![0x89, b'P', b'N', b'G', 1]
    );
    assert_eq!(set_files(&vault).len(), 2, "the set is still there");
    // the other version of a picture can be taken whole
    store(&vault).resolve(ID, Resolution::Other).unwrap();
    assert_eq!(
        vault.bytes("assets/pic.png").unwrap(),
        vec![0x89, b'P', b'N', b'G', 2]
    );
}

#[test]
fn a_resolution_repeated_after_a_crash_gives_the_same_result() {
    // Г26: the file was written, the set was not removed yet; the person tries again
    let vault = vault_with_a_set();
    vault.put("Notes/n.md", b"other\n");
    store(&vault).resolve(ID, Resolution::Other).unwrap();
    assert_eq!(vault.text("Notes/n.md").as_deref(), Some("other\n"));
    assert!(set_files(&vault).is_empty());
    // and once it is gone, a second try finds nothing and changes nothing
    assert_eq!(
        store(&vault).resolve(ID, Resolution::Other).unwrap_err(),
        ConflictError::NotFound
    );
    assert_eq!(vault.text("Notes/n.md").as_deref(), Some("other\n"));
}

#[test]
fn resolving_an_unknown_conflict_changes_nothing() {
    // Г35
    let vault = vault_with_a_set();
    assert_eq!(
        store(&vault)
            .resolve("ffffffffffff", Resolution::Other)
            .unwrap_err(),
        ConflictError::NotFound
    );
    assert_eq!(vault.text("Notes/n.md").as_deref(), Some("current\n"));
    assert_eq!(set_files(&vault).len(), 3);
}

#[test]
fn the_renamed_original_is_the_file_that_is_written() {
    // Г27
    let vault = TempVault::new("conflicts");
    vault.put("Archive/Renamed.md", b"current\n");
    make_set(
        &vault,
        ID,
        "bothEdited",
        ITEM,
        "Notes/n.md",
        "other.md",
        b"other\n",
        None,
    );
    let mut paths = BTreeMap::new();
    paths.insert(ITEM.to_string(), "Archive/Renamed.md".to_string());
    FileConflictStore::new(vault.root.clone(), paths, BTreeSet::new())
        .resolve(ID, Resolution::Other)
        .unwrap();
    assert_eq!(vault.text("Archive/Renamed.md").as_deref(), Some("other\n"));
    assert!(!vault.exists("Notes/n.md"), "the old path is not written");
}

#[test]
fn a_missing_original_cannot_be_kept_but_can_be_made_again() {
    // Г27
    let vault = TempVault::new("conflicts");
    make_set(
        &vault,
        ID,
        "bothEdited",
        ITEM,
        "Notes/n.md",
        "other.md",
        b"other\n",
        None,
    );
    assert_eq!(
        store(&vault).resolve(ID, Resolution::Current).unwrap_err(),
        ConflictError::OriginalMissing
    );
    assert_eq!(set_files(&vault).len(), 2, "nothing was removed");
    store(&vault).resolve(ID, Resolution::Other).unwrap();
    assert_eq!(vault.text("Notes/n.md").as_deref(), Some("other\n"));
    assert!(set_files(&vault).is_empty());
}

#[test]
fn an_old_copy_is_resolved_the_three_ways() {
    // Г29
    for (resolution, file, copy_stays_in_trash) in [
        (Resolution::Current, "mine", true),
        (Resolution::Other, "theirs", true),
        (
            Resolution::Assembled {
                text: "assembled\r\n".into(),
            },
            "assembled\r\n",
            true,
        ),
    ] {
        let vault = TempVault::new("conflicts");
        vault.put("Notes/n.md", &note_with_id("01ARZ", "mine"));
        vault.put(
            "Notes/n.0123456789ab-conflict.md",
            &note_with_id("01ARZ", "theirs"),
        );
        let id = listing_id("Notes/n.0123456789ab-conflict.md");
        store(&vault).resolve(&id, resolution.clone()).unwrap();
        let expected = if matches!(resolution, Resolution::Assembled { .. }) {
            file.to_string()
        } else {
            format!("---\namby-id: 01ARZ\n---\n{file}")
        };
        assert_eq!(vault.text("Notes/n.md").as_deref(), Some(expected.as_str()));
        assert!(!vault.exists("Notes/n.0123456789ab-conflict.md"));
        assert_eq!(
            vault
                .trashed()
                .contains(&"Notes/n.0123456789ab-conflict.md".to_string()),
            copy_stays_in_trash
        );
        if !matches!(resolution, Resolution::Current) {
            assert!(
                vault
                    .snapshots("Notes/n.md")
                    .iter()
                    .any(|(reason, _)| reason == "sync-overwrite"),
                "the replaced file is in the history"
            );
        }
        assert_eq!(store(&vault).list().unwrap(), Vec::new());
    }
}

// ----- the shape the interface sees (Г33, Г36) -----

#[test]
fn the_resolution_has_the_shape_the_interface_expects() {
    // Г33: `{kind: "current"}`, `{kind: "other"}`, `{kind: "assembled", text}`
    assert_eq!(
        serde_json::to_value(Resolution::Current).unwrap(),
        serde_json::json!({"kind": "current"})
    );
    assert_eq!(
        serde_json::to_value(Resolution::Other).unwrap(),
        serde_json::json!({"kind": "other"})
    );
    assert_eq!(
        serde_json::to_value(Resolution::Assembled {
            text: "a\r\n".into()
        })
        .unwrap(),
        serde_json::json!({"kind": "assembled", "text": "a\r\n"})
    );
    let back: Resolution =
        serde_json::from_value(serde_json::json!({"kind": "assembled", "text": ""})).unwrap();
    assert_eq!(
        back,
        Resolution::Assembled {
            text: String::new()
        }
    );
}

#[test]
fn the_entry_has_the_fields_of_the_contract_in_camel_case() {
    // Г32
    let vault = vault_with_a_set();
    let json = serde_json::to_value(entry(&vault)).unwrap();
    let object = json.as_object().unwrap();
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "createdHere",
            "createdMs",
            "hasBase",
            "id",
            "kind",
            "otherPath",
            "path",
            "source",
            "text"
        ]
    );
    assert_eq!(object["source"], "bundle");
    assert_eq!(ConflictError::NotText.code(), "not_text");
}
