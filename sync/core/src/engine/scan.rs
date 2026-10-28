//! The local overview of a pass (Д10 step 3, Д12, Д61, Д64): what is on disk, with a hash for
//! every file the engine can synchronise, read only when the fast check says it may have changed.

use std::collections::{BTreeMap, BTreeSet};

use crate::crypto::header::ItemKind;
use crate::crypto::padme::sealed_body_len;

use super::flow::{Flow, Res};
use super::model::{ItemRecord, StopReason, UnsyncedReason, UnsyncedRecord};
use super::ports::{FsError, LimitSource, LocalFs, LocalKind, RootState};
use super::rules::is_excluded_path;
use super::util::{hash_of, is_unmaterialised, nfc, parent};

/// A file on disk that the engine can synchronise.
#[derive(Debug, Clone)]
pub(super) struct LFile {
    /// The spelling the system gave (Д61); every operation on an existing file uses it.
    pub disk: String,
    /// Size as the listing gave it, before reading (Д12).
    pub size: u64,
    /// Modification time as the listing gave it, before reading (Д12).
    pub mtime_ns: i64,
    /// BLAKE3 of the content, from the base when size and time are the base's (Д12).
    pub hash: [u8; 32],
}

/// A folder on disk.
#[derive(Debug, Clone)]
pub(super) struct LDir {
    /// The spelling the system gave.
    pub disk: String,
    /// There is nothing in it at all (a folder record is made only for these, Р2).
    pub empty: bool,
}

/// Everything the pass knows about the disk.
#[derive(Debug, Default)]
pub(super) struct Scan {
    /// Files by NFC path.
    pub files: BTreeMap<String, LFile>,
    /// Folders by NFC path.
    pub dirs: BTreeMap<String, LDir>,
    /// Files the engine does not synchronise for a local reason (Д64): links, names, sizes.
    pub unsynced: Vec<UnsyncedRecord>,
    /// NFC paths of files that exist but are too big to read here (Д71, Д11).
    pub blocked: BTreeSet<String>,
}

/// Lists the vault and hashes what changed.
pub(super) fn scan(
    fs: &mut dyn LocalFs,
    records: &BTreeMap<[u8; 16], ItemRecord>,
    max_file_bytes: u64,
    limit: (u64, LimitSource),
) -> Res<Scan> {
    let (max_blob_bytes, limit_source) = limit;
    let listing = match fs.list() {
        Ok(listing) => listing,
        Err(FsError::NotFound(_)) if fs.root_state()? == RootState::Missing => {
            return Err(Flow::Stop(StopReason::VaultMissing));
        }
        Err(error) => return Err(error.into()),
    };
    let by_path: BTreeMap<&str, &ItemRecord> = records
        .values()
        .filter(|r| !r.deleted && r.kind == ItemKind::File && !is_unmaterialised(r))
        .map(|r| (r.path.as_str(), r))
        .collect();

    // A folder is empty when no entry of the listing, of whatever kind, lies below it.
    let mut occupied: BTreeSet<String> = BTreeSet::new();
    for entry in &listing.entries {
        let mut rest = nfc(&entry.path);
        while let Some(up) = parent(&rest).map(str::to_string) {
            if !occupied.insert(up.clone()) {
                break;
            }
            rest = up;
        }
    }
    for shown in &listing.not_utf8 {
        let mut rest = shown.as_str();
        while let Some(up) = parent(rest) {
            occupied.insert(up.to_string());
            rest = up;
        }
    }

    let listed: BTreeSet<String> = listing.entries.iter().map(|e| nfc(&e.path)).collect();
    let missing_sizes: BTreeSet<u64> = by_path
        .iter()
        .filter(|(path, _)| !listed.contains(**path))
        .map(|(_, record)| record.size)
        .collect();

    let mut out = Scan::default();
    let mut entries = listing.entries;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    for entry in entries {
        let path = nfc(&entry.path);
        if is_excluded_path(&path) {
            continue;
        }
        match entry.kind {
            LocalKind::Symlink => out.unsynced.push(UnsyncedRecord {
                path,
                reason: UnsyncedReason::Symlink,
            }),
            LocalKind::Folder => {
                let empty = !occupied.contains(&path);
                out.dirs.insert(
                    path,
                    LDir {
                        disk: entry.path,
                        empty,
                    },
                );
            }
            LocalKind::File => {
                if out.files.contains_key(&path) || out.blocked.contains(&path) {
                    // Two spellings of one name (Linux): the second by bytes is not synchronised.
                    out.unsynced.push(UnsyncedRecord {
                        path: entry.path,
                        reason: UnsyncedReason::NameCollision,
                    });
                    continue;
                }
                if entry.size > max_file_bytes {
                    out.unsynced.push(UnsyncedRecord {
                        path: path.clone(),
                        reason: UnsyncedReason::TooBigForMemory,
                    });
                    out.blocked.insert(path);
                    continue;
                }
                // Д74: a file the base already holds is read as any other: an unchanged one stays as
                // it is even when the limit fell below its size, and a changed one takes part in
                // the rules of Р7 (a foreign edit makes a conflict, nothing is lost); the push
                // refuses to send it and lists it. Only a file without a base is set aside here,
                // unread: nothing else can happen to it.
                // A file of the size of a base whose path is gone may be that file renamed: it is
                // read, so that the rename is seen as a rename and not as a deletion (a limit
                // deletes nothing on the server).
                if !by_path.contains_key(path.as_str())
                    && !missing_sizes.contains(&entry.size)
                    && sealed_body_len(entry.size).map_or(true, |len| len > max_blob_bytes)
                {
                    out.unsynced.push(UnsyncedRecord {
                        path: path.clone(),
                        reason: UnsyncedReason::TooLarge {
                            max_bytes: max_blob_bytes,
                            source: limit_source,
                        },
                    });
                    out.blocked.insert(path);
                    continue;
                }
                let known = by_path.get(path.as_str()).and_then(|record| {
                    (record.size == entry.size && record.mtime_ns == entry.mtime_ns)
                        .then_some(record.content_hash)
                        .flatten()
                });
                let hash = match known {
                    Some(hash) => hash,
                    None => match fs.read(&entry.path) {
                        Ok(bytes) => hash_of(&bytes),
                        // It vanished between the listing and the reading: not there.
                        Err(FsError::NotFound(_)) => continue,
                        // The system refuses this one file: it is listed, left alone and tried
                        // again by every pass; the others go on (Э4, from Э3).
                        Err(FsError::AccessDenied(_)) => {
                            out.unsynced.push(UnsyncedRecord {
                                path: path.clone(),
                                reason: UnsyncedReason::NoAccess,
                            });
                            out.blocked.insert(path);
                            continue;
                        }
                        Err(error) => return Err(error.into()),
                    },
                };
                out.files.insert(
                    path,
                    LFile {
                        disk: entry.path,
                        size: entry.size,
                        mtime_ns: entry.mtime_ns,
                        hash,
                    },
                );
            }
        }
    }
    for shown in listing.not_utf8 {
        out.unsynced.push(UnsyncedRecord {
            path: shown,
            reason: UnsyncedReason::NotUtf8,
        });
    }
    Ok(out)
}
