//! Names (Р7, Р9; appendix В, Д46, Д61–Д63): what cannot exist on a system, when two names are
//! "the same file", and how a conflict copy is called. Pure functions, red until written.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_core::crypto::keys::ItemId;
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::engine::names::{
    check_path_for_system, collision_key, conflict_copy_path, conflict_id, NameProblem,
};
use amby_sync_core::engine::NameRules;

fn windows(path: &str) -> Result<(), NameProblem> {
    check_path_for_system(path, &NameRules::windows())
}

#[test]
fn windows_forbidden_characters_are_refused_one_by_one() {
    // Р9, Д62: `<>:"\|?*` cannot be in a Windows name.
    for c in ['<', '>', ':', '"', '\\', '|', '?', '*'] {
        let path = format!("Notes/a{c}b.md");
        assert_eq!(
            windows(&path),
            Err(NameProblem::WindowsForbiddenChar(c)),
            "{c}"
        );
    }
    assert_eq!(windows("Notes/fine name (1).md"), Ok(()));
}

#[test]
fn the_same_names_are_fine_on_linux_and_macos() {
    // Р9, Д62: the Windows rules apply only where `windows_names` is set.
    for rules in [NameRules::linux(), NameRules::macos()] {
        for path in [
            "a:b.md",
            "CON",
            "nul.txt",
            "ends with dot.",
            "ends with space ",
            "q?.md",
        ] {
            assert_eq!(check_path_for_system(path, &rules), Ok(()), "{path}");
        }
    }
}

#[test]
fn a_segment_may_not_end_with_a_dot_or_a_space_on_windows() {
    // Р9, Д62.
    assert_eq!(windows("Notes/a.md."), Err(NameProblem::TrailingDotOrSpace));
    assert_eq!(windows("Notes/a.md "), Err(NameProblem::TrailingDotOrSpace));
    assert_eq!(
        windows("folder./a.md"),
        Err(NameProblem::TrailingDotOrSpace),
        "any segment, not only the last"
    );
    assert_eq!(windows("Notes/a. b.md"), Ok(()));
}

#[test]
fn reserved_device_names_are_refused_with_or_without_an_extension() {
    // Р9, Д62: CON, PRN, AUX, NUL, COM1–COM9, LPT1–LPT9, any case, `con.txt` included.
    let reserved = [
        "CON",
        "con",
        "Con.txt",
        "PRN",
        "aux.md",
        "NUL",
        "nul.tar.gz",
        "COM1",
        "com9",
        "Lpt1.md",
        "LPT9",
    ];
    for name in reserved {
        assert_eq!(
            windows(&format!("Notes/{name}")),
            Err(NameProblem::ReservedName(name.to_string())),
            "{name}"
        );
    }
    assert_eq!(
        windows("CON/inside.md"),
        Err(NameProblem::ReservedName("CON".into())),
        "a folder too"
    );
    for fine in [
        "COM0",
        "COM10",
        "LPT0",
        "CONSOLE.md",
        "xCON",
        "AUXILIARY",
        "COM",
        "NULL",
    ] {
        assert_eq!(windows(&format!("Notes/{fine}")), Ok(()), "{fine}");
    }
}

#[test]
fn the_first_problem_from_the_left_is_reported() {
    // Р9, Д62: segments from the left; inside a segment a forbidden character comes first.
    assert_eq!(
        windows("ok/bad:/CON"),
        Err(NameProblem::WindowsForbiddenChar(':'))
    );
    assert_eq!(
        windows("CON/bad:"),
        Err(NameProblem::ReservedName("CON".into()))
    );
    assert_eq!(windows("a:."), Err(NameProblem::WindowsForbiddenChar(':')));
}

#[test]
fn length_limits_count_utf8_bytes() {
    // Р9, Д62: 255 bytes per segment on every system, and the limit of the whole path.
    let name = |n: usize| "a".repeat(n);
    for rules in [NameRules::windows(), NameRules::macos(), NameRules::linux()] {
        assert_eq!(check_path_for_system(&name(255), &rules), Ok(()));
        assert_eq!(
            check_path_for_system(&name(256), &rules),
            Err(NameProblem::SegmentTooLong)
        );
        // 128 two-byte characters are 256 bytes.
        assert_eq!(
            check_path_for_system(&"é".repeat(128), &rules),
            Err(NameProblem::SegmentTooLong)
        );
        assert_eq!(check_path_for_system(&"é".repeat(127), &rules), Ok(()));
    }
    let long_path = |len: usize| {
        let mut path = String::new();
        while path.len() + 101 <= len {
            path.push_str(&"b".repeat(100));
            path.push('/');
        }
        let rest = len - path.len();
        assert!(rest > 0, "the helper must not end with a slash");
        path.push_str(&"c".repeat(rest));
        assert_eq!(path.len(), len);
        path
    };
    assert_eq!(
        check_path_for_system(&long_path(259), &NameRules::windows()),
        Ok(())
    );
    assert_eq!(
        check_path_for_system(&long_path(260), &NameRules::windows()),
        Err(NameProblem::PathTooLong)
    );
    assert_eq!(
        check_path_for_system(&long_path(1024), &NameRules::macos()),
        Ok(())
    );
    assert_eq!(
        check_path_for_system(&long_path(1025), &NameRules::macos()),
        Err(NameProblem::PathTooLong)
    );
    assert_eq!(
        check_path_for_system(&long_path(1025), &NameRules::linux()),
        Ok(())
    );
}

#[test]
fn the_collision_key_ignores_case_only_where_the_system_does() {
    // Р9, Д61, Д63: `Note.md` and `note.md` are one file on macOS and Windows, two on Linux.
    for rules in [NameRules::windows(), NameRules::macos()] {
        assert_eq!(
            collision_key("Notes/Note.md", &rules),
            collision_key("Notes/note.md", &rules)
        );
        assert_ne!(
            collision_key("Notes/Note.md", &rules),
            collision_key("Notes/Other.md", &rules)
        );
    }
    let linux = NameRules::linux();
    assert_ne!(
        collision_key("Notes/Note.md", &linux),
        collision_key("Notes/note.md", &linux)
    );
}

#[test]
fn the_collision_key_normalises_to_nfc_everywhere() {
    // Р9, Д61: macOS gives NFD; one file must not become two.
    let nfc = "Caf\u{e9}.md";
    let nfd = "Cafe\u{301}.md";
    for rules in [NameRules::windows(), NameRules::macos(), NameRules::linux()] {
        assert_eq!(collision_key(nfc, &rules), collision_key(nfd, &rules));
    }
}

fn expected_id(item: &ItemId, hash: &[u8; 32], version: u64, attempt: u32) -> String {
    let mut data = b"amby-sync/conflict/1".to_vec();
    data.extend_from_slice(item.as_bytes());
    data.extend_from_slice(hash);
    data.extend_from_slice(&version.to_be_bytes());
    if attempt != 0 {
        data.extend_from_slice(&attempt.to_be_bytes());
    }
    hex::encode(&blake3_hash(&data)[..6])
}

#[test]
fn the_conflict_id_is_the_documented_hash() {
    // Р7, Д46: 12 lowercase hex characters, the first 6 bytes of the documented BLAKE3.
    let item = ItemId::from_bytes([7; 16]);
    let hash = blake3_hash(b"local content");
    for (version, attempt) in [(1, 0), (2, 0), (u64::MAX, 0), (3, 1), (3, 2), (3, u32::MAX)] {
        let id = conflict_id(&item, &hash, version, attempt);
        assert_eq!(id, expected_id(&item, &hash, version, attempt));
        assert_eq!(id.len(), 12);
        assert!(id
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }
}

#[test]
fn the_conflict_id_depends_on_every_input_and_on_nothing_else() {
    // Р7, Д46, Д4: deterministic for a repeat after a crash, different for different conflicts.
    let item = ItemId::from_bytes([7; 16]);
    let hash = blake3_hash(b"local content");
    let base = conflict_id(&item, &hash, 5, 0);
    assert_eq!(base, conflict_id(&item, &hash, 5, 0));
    assert_ne!(base, conflict_id(&ItemId::from_bytes([8; 16]), &hash, 5, 0));
    assert_ne!(base, conflict_id(&item, &blake3_hash(b"other"), 5, 0));
    assert_ne!(base, conflict_id(&item, &hash, 6, 0));
    assert_ne!(base, conflict_id(&item, &hash, 5, 1));
}

#[test]
fn a_conflict_copy_is_named_name_id_conflict_extension() {
    // Р7, Д46: `Name.<id>-conflict.ext` in the same folder; split at the last dot.
    let id = "0123456789ab";
    let cases = [
        ("Notes/a.md", "Notes/a.0123456789ab-conflict.md"),
        ("a.md", "a.0123456789ab-conflict.md"),
        (
            "Deep/er/Report.final.txt",
            "Deep/er/Report.final.0123456789ab-conflict.txt",
        ),
        ("README", "README.0123456789ab-conflict"),
        ("dir.d/file", "dir.d/file.0123456789ab-conflict"),
        (".env", ".env.0123456789ab-conflict"),
        ("conf/.env", "conf/.env.0123456789ab-conflict"),
        (".env.local", ".env.0123456789ab-conflict.local"),
        ("Заметка.md", "Заметка.0123456789ab-conflict.md"),
    ];
    for (original, copy) in cases {
        assert_eq!(conflict_copy_path(original, id), copy, "{original}");
    }
}
