//! Shared by the tests of the properties as header plus groups: a vault in a temporary folder with
//! the layout of the groups, notes with headers, and a view of every file on disk. Tests look at
//! bytes on disk and at what the functions answer, not at internals (раздел 6).
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use amby_sync_core::engine::props_groups::group_of;
use rusqlite::Connection;

use super::{Design, Diff, NoteEntry};

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub const LAYOUT_V1: &str =
    "{\"groups\":16,\"hash\":\"blake3-first-hex\",\"template\":1,\"version\":1}\n";

/// A valid note id (a canonical ULID): `id(1)`, `id(2)`, …
pub fn id(n: u32) -> String {
    format!("01JC00000000000000000{n:05}")
}

/// Two ids that live in different groups, and two that live in the same one.
pub fn ids_in_different_groups() -> (String, String) {
    let first = id(1);
    let second = (2..)
        .map(id)
        .find(|candidate| group_of(candidate) != group_of(&first))
        .unwrap();
    (first, second)
}

pub fn ids_in_one_group() -> (String, String) {
    let first = id(1);
    let second = (2..)
        .map(id)
        .find(|candidate| group_of(candidate) == group_of(&first))
        .unwrap();
    (first, second)
}

pub struct Fx {
    pub vault: PathBuf,
    pub conn: Connection,
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.vault);
    }
}

fn blank(layout: bool) -> Fx {
    let vault = std::env::temp_dir().join(format!(
        "amby-propgroups-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&vault);
    fs::create_dir_all(vault.join(".amby")).unwrap();
    let vault = vault.canonicalize().unwrap();
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        r#"
        CREATE TABLE notes (id TEXT PRIMARY KEY, path TEXT NOT NULL);
        CREATE TABLE note_custom_properties (
            id TEXT NOT NULL, note_id TEXT NOT NULL, name TEXT NOT NULL,
            icon TEXT NOT NULL, property_type TEXT NOT NULL, value TEXT NOT NULL,
            settings TEXT NOT NULL, position INTEGER NOT NULL,
            PRIMARY KEY (note_id, id)
        );
        "#,
    )
    .unwrap();
    let fx = Fx { vault, conn };
    if layout {
        fx.write(".amby/properties/layout.json", LAYOUT_V1);
    }
    fx
}

/// A vault already in the groups format (`layout.json` of version 1).
pub fn fx() -> Fx {
    blank(true)
}

/// A vault before the migration: no `layout.json` (З38).
pub fn fx_old() -> Fx {
    blank(false)
}

/// A property the user made with an icon: a non-template name with an icon is a record.
pub fn design(name: &str) -> Design {
    Design {
        name: name.to_string(),
        icon: "📌".to_string(),
        property_type: "text".to_string(),
        settings: String::new(),
    }
}

pub fn design_typed(name: &str, property_type: &str, settings: &str) -> Design {
    Design {
        property_type: property_type.to_string(),
        settings: settings.to_string(),
        ..design(name)
    }
}

/// A record of a note with the given icons per property name.
pub fn entry_of(id: &str, props: &[(&str, &str)]) -> NoteEntry {
    NoteEntry {
        id: id.to_string(),
        props: props
            .iter()
            .map(|(name, icon)| {
                (
                    name.to_string(),
                    Diff {
                        icon: Some(icon.to_string()),
                        ..Diff::default()
                    },
                )
            })
            .collect(),
        ..NoteEntry::default()
    }
}

impl Fx {
    pub fn write(&self, rel: &str, content: &str) {
        self.write_bytes(rel, content.as_bytes());
    }

    pub fn write_bytes(&self, rel: &str, bytes: &[u8]) {
        let path = self.vault.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    pub fn read(&self, rel: &str) -> String {
        fs::read_to_string(self.vault.join(rel)).unwrap()
    }

    pub fn bytes(&self, rel: &str) -> Option<Vec<u8>> {
        fs::read(self.vault.join(rel)).ok()
    }

    pub fn exists(&self, rel: &str) -> bool {
        self.vault.join(rel).exists()
    }

    /// A note with `amby-id` and the extra header lines (each ends with a line feed).
    pub fn note(&self, id: &str, rel: &str, header: &str) {
        self.write(rel, &format!("---\namby-id: {id}\n{header}---\nТекст\n"));
        self.conn
            .execute(
                "INSERT OR REPLACE INTO notes (id, path) VALUES (?1, ?2)",
                [id, rel],
            )
            .unwrap();
    }

    /// A note given as exact text (for malformed headers, BOM, CRLF).
    pub fn note_raw(&self, id: &str, rel: &str, text: &str) {
        self.write(rel, text);
        self.conn
            .execute(
                "INSERT OR REPLACE INTO notes (id, path) VALUES (?1, ?2)",
                [id, rel],
            )
            .unwrap();
    }

    /// The indexer sees a second note with the same `amby-id` (З12, З25).
    pub fn make_duplicate_id(&self, id: &str) {
        self.conn
            .execute(
                "INSERT INTO notes (id, path) VALUES (?1, ?2)",
                [format!("amby-conflict:{id}:Copy.md"), "Copy.md".to_string()],
            )
            .unwrap();
    }

    pub fn group_rel(&self, note_id: &str) -> String {
        format!(".amby/properties/prop_{}.jsonl", group_of(note_id))
    }

    pub fn group_bytes(&self, note_id: &str) -> Option<Vec<u8>> {
        self.bytes(&self.group_rel(note_id))
    }

    /// The lines of the group file of a note, without the first line, as JSON.
    pub fn lines(&self, note_id: &str) -> Vec<serde_json::Value> {
        self.bytes(&self.group_rel(note_id))
            .map(|b| {
                String::from_utf8(b)
                    .unwrap()
                    .lines()
                    .skip(1)
                    .map(|l| serde_json::from_str(l).unwrap())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The line of a note, if the group has it.
    pub fn line(&self, note_id: &str) -> Option<serde_json::Value> {
        self.lines(note_id).into_iter().find(|l| l["id"] == note_id)
    }

    /// `props` of the line of a note: name → differences.
    pub fn props(&self, note_id: &str) -> serde_json::Map<String, serde_json::Value> {
        self.line(note_id)
            .and_then(|l| l["props"].as_object().cloned())
            .unwrap_or_default()
    }

    /// The names of the properties that have differences, ascending.
    pub fn prop_names(&self, note_id: &str) -> Vec<String> {
        self.props(note_id).keys().cloned().collect()
    }

    /// Every file under the vault (relative path → bytes).
    pub fn snapshot(&self) -> BTreeMap<String, Vec<u8>> {
        fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(root, &path, out);
                } else {
                    let rel = path
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    out.insert(rel, fs::read(&path).unwrap());
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(&self.vault, &self.vault, &mut out);
        out
    }

    /// The files of the vault by prefix.
    pub fn files_under(&self, prefix: &str) -> Vec<String> {
        self.snapshot()
            .into_keys()
            .filter(|path| path.starts_with(prefix))
            .collect()
    }

    /// Copies the vault to a second place (a second device) without the given folders.
    pub fn copy_to_second_device(&self, skip_prefixes: &[&str]) -> Fx {
        let other = blank(false);
        for (rel, bytes) in self.snapshot() {
            if skip_prefixes.iter().any(|p| rel.starts_with(p)) {
                continue;
            }
            other.write_bytes(&rel, &bytes);
        }
        let mut statement = self.conn.prepare("SELECT id, path FROM notes").unwrap();
        let rows: Vec<(String, String)> = statement
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        for (id, path) in rows {
            other
                .conn
                .execute("INSERT INTO notes (id, path) VALUES (?1, ?2)", [id, path])
                .unwrap();
        }
        other
    }
}

/// Runs `f` with the `n`-th atomic file write failing; returns the result and how many writes
/// were tried (test-only fault injection of `frontmatter`).
pub fn with_failing_write<T>(n: u64, after_publish: bool, f: impl FnOnce() -> T) -> T {
    crate::frontmatter::inject_nth_atomic_write_failure(n, after_publish);
    let out = f();
    crate::frontmatter::clear_atomic_write_failure();
    out
}

/// How many atomic writes `f` made.
pub fn count_writes<T>(f: impl FnOnce() -> T) -> (T, u64) {
    crate::frontmatter::inject_nth_atomic_write_failure(0, false);
    let out = f();
    let calls = crate::frontmatter::clear_atomic_write_failure();
    (out, calls)
}

/// The paths whose bytes differ between two snapshots, without the history snapshots
/// (`.amby/history/`, which depend on a setting).
pub fn changed_paths(
    before: &BTreeMap<String, Vec<u8>>,
    after: &BTreeMap<String, Vec<u8>>,
) -> Vec<String> {
    let mut paths: Vec<String> = before
        .keys()
        .chain(after.keys())
        .filter(|path| !path.starts_with(".amby/history/"))
        .filter(|path| before.get(*path) != after.get(*path))
        .cloned()
        .collect();
    paths.sort();
    paths.dedup();
    paths
}
