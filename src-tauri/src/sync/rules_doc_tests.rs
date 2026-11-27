//! `docs/vault-format.md` says which files of `.amby/` travel to the other devices (docs/sync-plan.md,
//! Р4: "every new file in `.amby/` states whether it is synchronised; by default it is not"). The
//! engine decides by `rules::is_excluded_path`; this test holds the document and the rules together,
//! so a file cannot start travelling — or stop — without the document saying so.

use std::fs;
use std::path::PathBuf;

use amby_sync_core::engine::rules::is_excluded_path;

fn document() -> Option<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../docs/vault-format.md");
    fs::read_to_string(path).ok()
}

/// The rows `| `entry`, `entry2` | yes/no | why |` of the table "Which files of `.amby/` are
/// synchronised".
fn rows(text: &str) -> Vec<(Vec<String>, bool)> {
    let start = text
        .find("### Which files of `.amby/` are synchronised")
        .expect("the section exists");
    text[start..]
        .lines()
        .filter(|line| line.starts_with("| `"))
        .map(|line| {
            let cells: Vec<&str> = line.split('|').map(str::trim).collect();
            let names = cells[1]
                .split(',')
                .map(|name| name.trim().trim_matches('`').to_string())
                .collect();
            (names, cells[2] == "yes")
        })
        .collect()
}

/// A path inside the entry: a folder entry (`blocks/`) is tried with a file below it.
fn probe(name: &str) -> String {
    match name.strip_suffix('/') {
        Some(folder) => format!(".amby/{folder}/x.json"),
        None => format!(".amby/{name}"),
    }
}

#[test]
fn the_document_and_the_rules_of_the_engine_agree_on_amby_files() {
    // Р4
    let Some(text) = document() else {
        return; // a branch without the docs folder
    };
    let table = rows(&text);
    assert!(table.len() >= 10, "the table is read: {table:?}");
    for (names, synchronised) in table {
        for name in names {
            if name.starts_with("workspace.json") {
                continue; // "others": checked below
            }
            assert_eq!(
                !is_excluded_path(&probe(&name)),
                synchronised,
                "docs/vault-format.md says {name}: {}",
                if synchronised { "yes" } else { "no" }
            );
        }
    }
}

#[test]
fn a_file_nobody_named_stays_on_this_computer() {
    // Р4: "by default — no"; the document says the same
    for path in [
        ".amby/workspace.json",
        ".amby/a-future-file.json",
        ".amby/modules/x.json",
        ".amby/sync/state.db",
    ] {
        assert!(is_excluded_path(path), "{path}");
    }
    if let Some(text) = document() {
        assert!(text.contains("A new file\nthat does not say so is not synchronised"));
    }
}
