//! What happened to every base on disk since the last pass (Д13, Д16): untouched, edited, moved,
//! gone. Renames are recognised by a unique pair of hashes, by a whole folder that moved, or by a
//! hint of the application.

use std::collections::{BTreeMap, BTreeSet};

use crate::crypto::header::ItemKind;

use super::model::{ItemRecord, RenameHint};
use super::scan::Scan;
use super::util::{is_unmaterialised, nfc};

/// The local state of one base (the columns of the table Р7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Lc {
    /// As in the base.
    Same,
    /// The content is not the base's.
    Edited,
    /// Moved to `to`; `edited` when the content changed too (a hint of the application, Д70).
    Moved { to: String, edited: bool },
    /// Gone.
    Deleted,
    /// The file is there but too big to look at (Д71): left alone.
    Blocked,
}

/// Classifies every live base that exists on this disk.
pub(super) fn classify(
    records: &BTreeMap<[u8; 16], ItemRecord>,
    scan: &Scan,
    hints: &[RenameHint],
) -> BTreeMap<[u8; 16], Lc> {
    let mut out: BTreeMap<[u8; 16], Lc> = BTreeMap::new();
    let live: Vec<&ItemRecord> = records
        .values()
        .filter(|r| !r.deleted && !is_unmaterialised(r))
        .collect();
    let all_by_path: BTreeMap<&str, &ItemRecord> =
        live.iter().map(|r| (r.path.as_str(), *r)).collect();

    // Present or missing.
    let mut missing: BTreeMap<&str, &ItemRecord> = BTreeMap::new();
    for record in &live {
        let key = *record.item_id.as_bytes();
        match record.kind {
            ItemKind::File => match scan.files.get(&record.path) {
                Some(file) => {
                    let same = Some(file.hash) == record.content_hash;
                    out.insert(key, if same { Lc::Same } else { Lc::Edited });
                }
                None if scan.blocked.contains(&record.path) => {
                    out.insert(key, Lc::Blocked);
                }
                None => {
                    missing.insert(&record.path, record);
                }
            },
            ItemKind::Folder => {
                if scan.dirs.contains_key(&record.path) {
                    out.insert(key, Lc::Same);
                } else {
                    missing.insert(&record.path, record);
                }
            }
        }
    }

    // The pools of things without a base.
    let file_record_paths: BTreeSet<&str> = live
        .iter()
        .filter(|r| r.kind == ItemKind::File)
        .map(|r| r.path.as_str())
        .collect();
    let folder_record_paths: BTreeSet<&str> = live
        .iter()
        .filter(|r| r.kind == ItemKind::Folder)
        .map(|r| r.path.as_str())
        .collect();
    let mut new_files: BTreeMap<&str, &super::scan::LFile> = scan
        .files
        .iter()
        .filter(|(path, _)| !file_record_paths.contains(path.as_str()))
        .map(|(path, file)| (path.as_str(), file))
        .collect();
    let mut new_dirs: BTreeSet<&str> = scan
        .dirs
        .iter()
        .filter(|(path, dir)| dir.empty && !folder_record_paths.contains(path.as_str()))
        .map(|(path, _)| path.as_str())
        .collect();

    // 1. The application says so (Д70).
    for hint in hints {
        let (from, to) = (nfc(&hint.from), nfc(&hint.to));
        let Some(record) = missing.get(from.as_str()).copied() else {
            continue;
        };
        if record.kind != ItemKind::File {
            continue;
        }
        let Some((&target, file)) = new_files.get_key_value(to.as_str()) else {
            continue;
        };
        let edited = Some(file.hash) != record.content_hash;
        out.insert(
            *record.item_id.as_bytes(),
            Lc::Moved {
                to: target.to_string(),
                edited,
            },
        );
        missing.remove(from.as_str());
        new_files.remove(target);
    }

    // 2. A whole folder moved: the same files with the same hashes under a new name (Д13).
    let mut candidates: BTreeSet<String> = BTreeSet::new();
    for (path, record) in &missing {
        if record.kind == ItemKind::Folder {
            candidates.insert((*path).to_string());
        }
        let mut rest = *path;
        while let Some(at) = rest.rfind('/') {
            rest = &rest[..at];
            candidates.insert(rest.to_string());
        }
    }
    for dir in candidates {
        let prefix = format!("{dir}/");
        let under_all = all_by_path
            .range(dir.as_str()..)
            .take_while(|(path, _)| **path == dir || path.starts_with(&prefix))
            .count();
        let under_missing: Vec<(&str, &ItemRecord)> = missing
            .range(dir.as_str()..)
            .take_while(|(path, _)| **path == dir.as_str() || path.starts_with(&prefix))
            .map(|(path, record)| (*path, *record))
            .collect();
        if under_missing.is_empty() || under_missing.len() != under_all {
            continue; // something under it is still here or already paired
        }
        // What lies under the old folder: relative path → hash (None for a folder).
        let old: BTreeMap<String, Option<[u8; 32]>> = under_missing
            .iter()
            .map(|(path, record)| {
                let rel = path.strip_prefix(&prefix).unwrap_or("").to_string();
                (rel, record.content_hash)
            })
            .collect();
        let Some((probe_rel, probe_hash)) = old
            .iter()
            .find_map(|(rel, hash)| hash.map(|h| (rel.clone(), h)))
        else {
            continue;
        };
        let suffix = format!("/{probe_rel}");
        let mut found: Vec<String> = Vec::new();
        for (path, file) in &new_files {
            if file.hash == probe_hash && path.ends_with(&suffix) {
                let root = &path[..path.len() - suffix.len()];
                if !root.is_empty() && root != dir && !found.iter().any(|f| f == root) {
                    found.push(root.to_string());
                }
            }
        }
        let mut matched: Vec<String> = Vec::new();
        for root in found {
            let root_prefix = format!("{root}/");
            let mut now: BTreeMap<String, Option<[u8; 32]>> = BTreeMap::new();
            for (path, file) in &new_files {
                if let Some(rel) = path.strip_prefix(&root_prefix) {
                    now.insert(rel.to_string(), Some(file.hash));
                }
            }
            for path in &new_dirs {
                if let Some(rel) = path.strip_prefix(&root_prefix) {
                    now.insert(rel.to_string(), None);
                } else if *path == root {
                    now.insert(String::new(), None);
                }
            }
            if now == old {
                matched.push(root);
            }
        }
        if matched.len() != 1 {
            continue;
        }
        let root = &matched[0];
        for (path, record) in &under_missing {
            let rel = path.strip_prefix(&prefix).unwrap_or("");
            let to = if rel.is_empty() {
                root.clone()
            } else {
                format!("{root}/{rel}")
            };
            out.insert(
                *record.item_id.as_bytes(),
                Lc::Moved {
                    to: to.clone(),
                    edited: false,
                },
            );
            new_files.remove(to.as_str());
            new_dirs.remove(to.as_str());
        }
        for (path, _) in &under_missing {
            missing.remove(*path);
        }
    }

    // 3. One file gone and one new file with the same content (Д13).
    let mut gone: BTreeMap<([u8; 32], u64), Vec<&ItemRecord>> = BTreeMap::new();
    for record in missing.values() {
        if let (ItemKind::File, Some(hash)) = (record.kind, record.content_hash) {
            gone.entry((hash, record.size)).or_default().push(record);
        }
    }
    let mut fresh: BTreeMap<([u8; 32], u64), Vec<&str>> = BTreeMap::new();
    for (path, file) in &new_files {
        fresh.entry((file.hash, file.size)).or_default().push(path);
    }
    for (key, records) in &gone {
        if let (1, Some(paths)) = (records.len(), fresh.get(key)) {
            if paths.len() == 1 {
                let record = records[0];
                out.insert(
                    *record.item_id.as_bytes(),
                    Lc::Moved {
                        to: paths[0].to_string(),
                        edited: false,
                    },
                );
                missing.remove(record.path.as_str());
            }
        }
    }
    // One empty folder gone and one new empty folder.
    let lone: Vec<&ItemRecord> = missing
        .values()
        .filter(|r| r.kind == ItemKind::Folder)
        .copied()
        .collect();
    if let ([record], [target]) = (
        lone.as_slice(),
        new_dirs.iter().collect::<Vec<_>>().as_slice(),
    ) {
        // Only when no file is a candidate too: a folder that held files is handled above.
        if missing.values().all(|r| r.kind == ItemKind::Folder) {
            out.insert(
                *record.item_id.as_bytes(),
                Lc::Moved {
                    to: (*target).to_string(),
                    edited: false,
                },
            );
            missing.remove(record.path.as_str());
        }
    }

    // 4. The rest is gone.
    for record in missing.values() {
        out.insert(*record.item_id.as_bytes(), Lc::Deleted);
    }
    out
}
