//! The virtual file system of the simulation: files in memory, with a history of snapshots and a
//! trash, so that "nothing is lost" can be checked (раздел 7). It behaves like a real system
//! where the plan cares: temporary files are visible in the listing until they are published or
//! cleaned, a write is atomic, a rename never overwrites, names follow the [`NameRules`], and on
//! case-insensitive systems `Note.md` and `note.md` are the same file.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::engine::{
    FsError, Listing, LocalEntry, LocalFs, LocalKind, NameRules, RootState, SnapshotReason,
    StagedWrite, TrashReason,
};
use unicode_normalization::UnicodeNormalization;

pub type Hash = [u8; 32];

#[derive(Clone, Debug, PartialEq)]
enum Node {
    File { bytes: Vec<u8>, mtime_ns: i64 },
    Dir,
    Symlink,
}

/// A snapshot kept in the history of the device (Р8, Д53).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryEntry {
    pub path: String,
    pub bytes: Vec<u8>,
    pub reason: SnapshotReason,
}

/// A file moved to the trash (Р8, О4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrashEntry {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// What the engine did to the disk, in order; the tests and the invariants read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FsEvent {
    /// A temporary file became the target. `old` is the content that was replaced, if any.
    Publish {
        path: String,
        old: Option<Vec<u8>>,
        snapshot: bool,
    },
    Abort {
        path: String,
    },
    Trash {
        path: String,
        bytes: Vec<u8>,
    },
    Rename {
        from: String,
        to: String,
    },
    CreateDir {
        path: String,
    },
    RemoveDir {
        path: String,
    },
    /// The system refused to create this name.
    Refused {
        path: String,
    },
    BatchBegin,
    BatchEnd,
}

struct Staged {
    target: String,
    tmp_path: String,
}

struct Inner {
    root_present: bool,
    nodes: BTreeMap<String, Node>,
    rules: NameRules,
    nfc_insensitive: bool,
    history: Vec<HistoryEntry>,
    trash: Vec<TrashEntry>,
    staged: BTreeMap<u64, Staged>,
    next_staged: u64,
    clock: i64,
    recovery_pending: bool,
    disk_full: bool,
    /// Paths (as the engine names them) the system refuses access to (Э4).
    denied: BTreeSet<String>,
    not_utf8: Vec<String>,
    events: Vec<FsEvent>,
    batch_depth: i32,
    max_batch_depth: i32,
    /// Contents the user saved that no pass has seen yet (key → hash).
    unobserved: BTreeMap<String, Hash>,
    /// Contents a pass has seen: all of them must be somewhere at the end (раздел 7, 2).
    required: BTreeMap<Hash, Vec<u8>>,
    reads: u64,
}

/// A handle to the virtual file system; cloning shares it.
#[derive(Clone)]
pub struct Vfs(Rc<RefCell<Inner>>);

/// Windows reserved device names, for the simulated system's own refusal.
fn windows_reserved(segment: &str) -> bool {
    let stem = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

fn parent_of(path: &str) -> Option<&str> {
    path.rfind('/').map(|i| &path[..i])
}

fn name_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub fn hash_of(bytes: &[u8]) -> Hash {
    blake3_hash(bytes)
}

impl Vfs {
    /// An empty vault on a system with these rules.
    pub fn new(rules: NameRules) -> Self {
        Self(Rc::new(RefCell::new(Inner {
            root_present: true,
            nodes: BTreeMap::new(),
            rules,
            nfc_insensitive: rules.case_insensitive,
            history: Vec::new(),
            trash: Vec::new(),
            staged: BTreeMap::new(),
            next_staged: 1,
            clock: 1_700_000_000_000_000_000,
            recovery_pending: false,
            disk_full: false,
            denied: BTreeSet::new(),
            not_utf8: Vec::new(),
            events: Vec::new(),
            batch_depth: 0,
            max_batch_depth: 0,
            unobserved: BTreeMap::new(),
            required: BTreeMap::new(),
            reads: 0,
        })))
    }

    pub fn linux() -> Self {
        Self::new(NameRules::linux())
    }

    pub fn macos() -> Self {
        Self::new(NameRules::macos())
    }

    pub fn windows() -> Self {
        Self::new(NameRules::windows())
    }

    // ----- lookups -----

    fn key_of(inner: &Inner, path: &str) -> String {
        let nfc: String = path.nfc().collect();
        if inner.rules.case_insensitive {
            nfc.to_lowercase()
        } else if inner.nfc_insensitive {
            nfc
        } else {
            path.to_string()
        }
    }

    /// The stored spelling of `path`, if something is there.
    fn find(inner: &Inner, path: &str) -> Option<String> {
        if inner.nodes.contains_key(path) {
            return Some(path.to_string());
        }
        let key = Self::key_of(inner, path);
        if !inner.rules.case_insensitive && !inner.nfc_insensitive {
            return None;
        }
        inner
            .nodes
            .keys()
            .find(|stored| Self::key_of(inner, stored) == key)
            .cloned()
    }

    /// `path` with every existing parent written the way the system stores it.
    fn resolve(inner: &Inner, path: &str) -> String {
        let segments: Vec<&str> = path.split('/').collect();
        let mut out = String::new();
        for (index, segment) in segments.iter().enumerate() {
            let candidate = if out.is_empty() {
                (*segment).to_string()
            } else {
                format!("{out}/{segment}")
            };
            if index + 1 < segments.len() {
                if let Some(stored) = Self::find(inner, &candidate) {
                    out = stored;
                    continue;
                }
            }
            out = candidate;
        }
        out
    }

    fn check_name(inner: &Inner, path: &str) -> Result<(), FsError> {
        let rules = inner.rules;
        let bad = |why: &str| {
            Err(FsError::Io(format!(
                "the system refuses the name {path}: {why}"
            )))
        };
        if path.len() > rules.max_path_bytes {
            return bad("path too long");
        }
        for segment in path.split('/') {
            if segment.len() > rules.max_segment_bytes {
                return bad("name too long");
            }
            if rules.windows_names {
                if segment.chars().any(|c| "<>:\"\\|?*".contains(c)) {
                    return bad("forbidden character");
                }
                if segment.ends_with('.') || segment.ends_with(' ') {
                    return bad("trailing dot or space");
                }
                if windows_reserved(segment) {
                    return bad("reserved name");
                }
            }
        }
        Ok(())
    }

    fn tick(inner: &mut Inner) -> i64 {
        inner.clock += 1_000_003;
        inner.clock
    }

    fn ensure_parents(inner: &mut Inner, stored: &str) {
        let mut prefix = String::new();
        let segments: Vec<&str> = stored.split('/').collect();
        for segment in &segments[..segments.len().saturating_sub(1)] {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(segment);
            inner.nodes.entry(prefix.clone()).or_insert(Node::Dir);
        }
    }

    fn observe_key(inner: &mut Inner, key: &str) {
        if let Some(hash) = inner.unobserved.remove(key) {
            if let Some(Node::File { bytes, .. }) = inner
                .nodes
                .iter()
                .find(|(stored, _)| Self::key_of(inner, stored) == key)
                .map(|(_, node)| node.clone())
            {
                inner.required.insert(hash, bytes);
            }
        }
    }

    fn observe_all(inner: &mut Inner) {
        let keys: Vec<String> = inner.unobserved.keys().cloned().collect();
        for key in keys {
            Self::observe_key(inner, &key);
        }
    }

    // ----- what the user does (outside the engine) -----

    /// The user saves a file (creates or replaces), parents are created.
    pub fn user_write(&self, path: &str, bytes: &[u8]) {
        let mut inner = self.0.borrow_mut();
        Self::check_name(&inner, path).unwrap_or_else(|e| panic!("the test wrote a bad name: {e}"));
        let stored = Self::find(&inner, path).unwrap_or_else(|| Self::resolve(&inner, path));
        let key = Self::key_of(&inner, &stored);
        inner.unobserved.remove(&key);
        if let Some(Node::File { bytes: old, .. }) = inner.nodes.get(&stored) {
            // The user replaced it: no duty of the engine for that content any more.
            let old = hash_of(old);
            inner.required.remove(&old);
        }
        Self::ensure_parents(&mut inner, &stored);
        let mtime_ns = Self::tick(&mut inner);
        inner.nodes.insert(
            stored,
            Node::File {
                bytes: bytes.to_vec(),
                mtime_ns,
            },
        );
        inner.unobserved.insert(key, hash_of(bytes));
    }

    /// The user deletes a file or a folder with everything in it.
    pub fn user_delete(&self, path: &str) {
        let mut inner = self.0.borrow_mut();
        let Some(stored) = Self::find(&inner, path) else {
            return;
        };
        let prefix = format!("{stored}/");
        let doomed: Vec<String> = inner
            .nodes
            .keys()
            .filter(|k| **k == stored || k.starts_with(&prefix))
            .cloned()
            .collect();
        for key in doomed {
            let k = Self::key_of(&inner, &key);
            inner.unobserved.remove(&k);
            if let Some(Node::File { bytes, .. }) = inner.nodes.remove(&key) {
                // The user deleted it: no duty of the engine for that content any more.
                inner.required.remove(&hash_of(&bytes));
            }
        }
    }

    /// The user renames a file or a folder (a folder moves with everything in it).
    pub fn user_rename(&self, from: &str, to: &str) {
        let mut inner = self.0.borrow_mut();
        let Some(stored) = Self::find(&inner, from) else {
            panic!("the test renames {from}, which is not there");
        };
        let target = Self::resolve(&inner, to);
        let prefix = format!("{stored}/");
        let moving: Vec<String> = inner
            .nodes
            .keys()
            .filter(|k| **k == stored || k.starts_with(&prefix))
            .cloned()
            .collect();
        for old in moving {
            let node = inner.nodes.remove(&old).unwrap();
            let new = format!("{target}{}", &old[stored.len()..]);
            let old_key = Self::key_of(&inner, &old);
            let hash = inner.unobserved.remove(&old_key);
            Self::ensure_parents(&mut inner, &new);
            let new_key = Self::key_of(&inner, &new);
            inner.nodes.insert(new, node);
            if let Some(hash) = hash {
                inner.unobserved.insert(new_key, hash);
            }
        }
    }

    /// The user makes a folder.
    pub fn user_mkdir(&self, path: &str) {
        let mut inner = self.0.borrow_mut();
        let stored = Self::find(&inner, path).unwrap_or_else(|| Self::resolve(&inner, path));
        Self::ensure_parents(&mut inner, &stored);
        inner.nodes.entry(stored).or_insert(Node::Dir);
    }

    /// A symbolic link appears (never synchronised, Р4).
    pub fn user_symlink(&self, path: &str) {
        let mut inner = self.0.borrow_mut();
        let stored = Self::resolve(&inner, path);
        Self::ensure_parents(&mut inner, &stored);
        inner.nodes.insert(stored, Node::Symlink);
    }

    /// A name that is not UTF-8 appears (shown lossily, Р4).
    pub fn user_not_utf8(&self, shown: &str) {
        self.0.borrow_mut().not_utf8.push(shown.to_string());
    }

    /// The disk with the vault is unplugged or plugged back (Р8, С8).
    pub fn set_root_present(&self, present: bool) {
        self.0.borrow_mut().root_present = present;
    }

    /// The disk is full: every write fails with `NoSpace` (С4).
    pub fn set_disk_full(&self, full: bool) {
        self.0.borrow_mut().disk_full = full;
    }

    /// The system refuses to read, write, rename or trash this one file (permissions, a lock):
    /// the call fails with [`FsError::AccessDenied`] while `denied` is on.
    pub fn set_access_denied(&self, path: &str, denied: bool) {
        let mut inner = self.0.borrow_mut();
        let key = Self::key_of(&inner, path);
        if denied {
            inner.denied.insert(key);
        } else {
            inner.denied.remove(&key);
        }
    }

    fn deny_check(inner: &Inner, path: &str) -> Result<(), FsError> {
        if inner.denied.contains(&Self::key_of(inner, path)) {
            Err(FsError::AccessDenied(path.to_string()))
        } else {
            Ok(())
        }
    }

    /// An unfinished journal of a multi-file operation is there (Р8, Д59).
    pub fn set_recovery_pending(&self, pending: bool) {
        self.0.borrow_mut().recovery_pending = pending;
    }

    /// Makes the file system treat names the macOS way (NFC and NFD are the same name).
    pub fn set_nfc_insensitive(&self, on: bool) {
        self.0.borrow_mut().nfc_insensitive = on;
    }

    /// Replaces the name rules of the system.
    pub fn set_rules(&self, rules: NameRules) {
        self.0.borrow_mut().rules = rules;
    }

    /// Copies the whole vault (files, folders, links) into a new file system, without the
    /// history, the trash and the ledger: the vault copied to another computer (С11).
    pub fn clone_contents(&self) -> Vfs {
        let inner = self.0.borrow();
        let copy = Vfs::new(inner.rules);
        {
            let mut other = copy.0.borrow_mut();
            other.nodes = inner.nodes.clone();
            other.nfc_insensitive = inner.nfc_insensitive;
            other.clock = inner.clock;
        }
        copy
    }

    // ----- what the tests look at -----

    /// The content of a file, if it is there (nothing is recorded).
    pub fn content(&self, path: &str) -> Option<Vec<u8>> {
        let inner = self.0.borrow();
        let stored = Self::find(&inner, path)?;
        match inner.nodes.get(&stored) {
            Some(Node::File { bytes, .. }) => Some(bytes.clone()),
            _ => None,
        }
    }

    pub fn exists(&self, path: &str) -> bool {
        let inner = self.0.borrow();
        Self::find(&inner, path).is_some()
    }

    pub fn is_dir(&self, path: &str) -> bool {
        let inner = self.0.borrow();
        Self::find(&inner, path)
            .and_then(|s| inner.nodes.get(&s).cloned())
            .map(|n| n == Node::Dir)
            .unwrap_or(false)
    }

    /// The stored spelling of a path (how the system keeps the name).
    pub fn stored_name(&self, path: &str) -> Option<String> {
        let inner = self.0.borrow();
        Self::find(&inner, path)
    }

    /// All files (not temporary ones) with their content.
    pub fn files(&self) -> BTreeMap<String, Vec<u8>> {
        let inner = self.0.borrow();
        let tmp: BTreeSet<&String> = inner.staged.values().map(|s| &s.tmp_path).collect();
        inner
            .nodes
            .iter()
            .filter_map(|(path, node)| match node {
                Node::File { bytes, .. } if !tmp.contains(path) && !is_tmp_name(path) => {
                    Some((path.clone(), bytes.clone()))
                }
                _ => None,
            })
            .collect()
    }

    /// All folders.
    pub fn dirs(&self) -> BTreeSet<String> {
        let inner = self.0.borrow();
        inner
            .nodes
            .iter()
            .filter(|(_, node)| **node == Node::Dir)
            .map(|(path, _)| path.clone())
            .collect()
    }

    /// Temporary files left in the vault (`.name.amby-tmp-N`).
    pub fn tmp_files(&self) -> Vec<String> {
        let inner = self.0.borrow();
        inner
            .nodes
            .keys()
            .filter(|path| is_tmp_name(path))
            .cloned()
            .collect()
    }

    pub fn history(&self) -> Vec<HistoryEntry> {
        self.0.borrow().history.clone()
    }

    pub fn trash(&self) -> Vec<TrashEntry> {
        self.0.borrow().trash.clone()
    }

    pub fn events(&self) -> Vec<FsEvent> {
        self.0.borrow().events.clone()
    }

    pub fn clear_events(&self) {
        self.0.borrow_mut().events.clear();
    }

    /// The deepest nesting of `batch_begin` seen, and whether it is balanced now.
    pub fn batch_state(&self) -> (i32, i32) {
        let inner = self.0.borrow();
        (inner.batch_depth, inner.max_batch_depth)
    }

    /// How many times the engine read a file.
    pub fn reads(&self) -> u64 {
        self.0.borrow().reads
    }

    /// Contents the passes have seen (the ledger of "nothing is lost").
    pub fn required(&self) -> BTreeMap<Hash, Vec<u8>> {
        self.0.borrow().required.clone()
    }

    /// Forgets that anything was observed (a copied vault starts a new ledger).
    pub fn reset_ledger(&self) {
        let mut inner = self.0.borrow_mut();
        inner.required.clear();
        inner.unobserved.clear();
    }

    /// A file disappears without the user and without the engine: only for the tests of the
    /// invariants themselves (a bug of the disk, not an action anyone can take).
    pub fn vanish(&self, path: &str) {
        let mut inner = self.0.borrow_mut();
        if let Some(stored) = Self::find(&inner, path) {
            inner.nodes.remove(&stored);
        }
    }

    /// Makes the mtime of a file differ (used to simulate a touched but identical file).
    pub fn touch(&self, path: &str) {
        let mut inner = self.0.borrow_mut();
        let stored = Self::find(&inner, path).expect("touch of a missing file");
        let t = Self::tick(&mut inner);
        if let Some(Node::File { mtime_ns, .. }) = inner.nodes.get_mut(&stored) {
            *mtime_ns = t;
        }
    }

    fn publish_inner(
        inner: &mut Inner,
        target: &str,
        bytes: Vec<u8>,
        snapshot: Option<SnapshotReason>,
    ) -> Result<(), FsError> {
        let stored = Self::find(inner, target).unwrap_or_else(|| Self::resolve(inner, target));
        let old = match inner.nodes.get(&stored) {
            Some(Node::File { bytes, .. }) => Some(bytes.clone()),
            Some(Node::Dir) => return Err(FsError::Io(format!("{target} is a folder"))),
            Some(Node::Symlink) => return Err(FsError::Io(format!("{target} is a link"))),
            None => None,
        };
        if let (Some(old_bytes), Some(reason)) = (&old, snapshot) {
            inner.history.push(HistoryEntry {
                path: stored.clone(),
                bytes: old_bytes.clone(),
                reason,
            });
        }
        Self::ensure_parents(inner, &stored);
        let mtime_ns = Self::tick(inner);
        let key = Self::key_of(inner, &stored);
        inner.unobserved.remove(&key);
        inner
            .nodes
            .insert(stored.clone(), Node::File { bytes, mtime_ns });
        inner.events.push(FsEvent::Publish {
            path: stored,
            old,
            snapshot: snapshot.is_some(),
        });
        Ok(())
    }
}

fn is_tmp_name(path: &str) -> bool {
    let name = name_of(path);
    name.starts_with('.') && name.contains(".amby-tmp-")
}

struct VfsStaged {
    vfs: Vfs,
    id: u64,
}

impl StagedWrite for VfsStaged {
    fn write(&mut self, bytes: &[u8]) -> Result<(), FsError> {
        let mut inner = self.vfs.0.borrow_mut();
        if inner.disk_full {
            return Err(FsError::NoSpace);
        }
        let tmp = inner.staged[&self.id].tmp_path.clone();
        if let Some(Node::File { bytes: have, .. }) = inner.nodes.get_mut(&tmp) {
            have.extend_from_slice(bytes);
        }
        Ok(())
    }

    fn publish(self: Box<Self>, snapshot: Option<SnapshotReason>) -> Result<(), FsError> {
        let mut inner = self.vfs.0.borrow_mut();
        if inner.disk_full {
            return Err(FsError::NoSpace);
        }
        let staged = inner
            .staged
            .remove(&self.id)
            .expect("publish of unknown write");
        let bytes = match inner.nodes.remove(&staged.tmp_path) {
            Some(Node::File { bytes, .. }) => bytes,
            _ => Vec::new(),
        };
        Vfs::publish_inner(&mut inner, &staged.target, bytes, snapshot)
    }

    fn abort(self: Box<Self>) {
        let mut inner = self.vfs.0.borrow_mut();
        if let Some(staged) = inner.staged.remove(&self.id) {
            inner.nodes.remove(&staged.tmp_path);
            inner.events.push(FsEvent::Abort {
                path: staged.target,
            });
        }
    }
}

impl LocalFs for Vfs {
    fn root_state(&mut self) -> Result<RootState, FsError> {
        Ok(if self.0.borrow().root_present {
            RootState::Present
        } else {
            RootState::Missing
        })
    }

    fn list(&mut self) -> Result<Listing, FsError> {
        let mut inner = self.0.borrow_mut();
        if !inner.root_present {
            return Err(FsError::NotFound("the vault folder".into()));
        }
        Self::observe_all(&mut inner);
        let entries = inner
            .nodes
            .iter()
            .map(|(path, node)| match node {
                Node::File { bytes, mtime_ns } => LocalEntry {
                    path: path.clone(),
                    kind: LocalKind::File,
                    size: bytes.len() as u64,
                    mtime_ns: *mtime_ns,
                },
                Node::Dir => LocalEntry {
                    path: path.clone(),
                    kind: LocalKind::Folder,
                    size: 0,
                    mtime_ns: 0,
                },
                Node::Symlink => LocalEntry {
                    path: path.clone(),
                    kind: LocalKind::Symlink,
                    size: 0,
                    mtime_ns: 0,
                },
            })
            .collect();
        Ok(Listing {
            entries,
            not_utf8: inner.not_utf8.clone(),
        })
    }

    fn read(&mut self, path: &str) -> Result<Vec<u8>, FsError> {
        let mut inner = self.0.borrow_mut();
        inner.reads += 1;
        let stored = Self::find(&inner, path).ok_or_else(|| FsError::NotFound(path.into()))?;
        Self::deny_check(&inner, &stored)?;
        let key = Self::key_of(&inner, &stored);
        Self::observe_key(&mut inner, &key);
        match inner.nodes.get(&stored) {
            Some(Node::File { bytes, .. }) => Ok(bytes.clone()),
            _ => Err(FsError::NotFound(path.into())),
        }
    }

    fn begin_write(&mut self, path: &str) -> Result<Box<dyn StagedWrite>, FsError> {
        let mut inner = self.0.borrow_mut();
        if let Err(error) = Self::check_name(&inner, path) {
            inner.events.push(FsEvent::Refused { path: path.into() });
            return Err(error);
        }
        if inner.disk_full {
            return Err(FsError::NoSpace);
        }
        Self::deny_check(&inner, path)?;
        let id = inner.next_staged;
        inner.next_staged += 1;
        let resolved = Self::find(&inner, path).unwrap_or_else(|| Self::resolve(&inner, path));
        let dir = parent_of(&resolved)
            .map(|d| format!("{d}/"))
            .unwrap_or_default();
        let tmp_path = format!("{dir}.{}.amby-tmp-{id}", name_of(&resolved));
        Self::ensure_parents(&mut inner, &tmp_path);
        let mtime_ns = Self::tick(&mut inner);
        inner.nodes.insert(
            tmp_path.clone(),
            Node::File {
                bytes: Vec::new(),
                mtime_ns,
            },
        );
        inner.staged.insert(
            id,
            Staged {
                target: path.to_string(),
                tmp_path,
            },
        );
        Ok(Box::new(VfsStaged {
            vfs: self.clone(),
            id,
        }))
    }

    fn create_dir(&mut self, path: &str) -> Result<(), FsError> {
        let mut inner = self.0.borrow_mut();
        if let Err(error) = Self::check_name(&inner, path) {
            inner.events.push(FsEvent::Refused { path: path.into() });
            return Err(error);
        }
        if let Some(stored) = Self::find(&inner, path) {
            return match inner.nodes.get(&stored) {
                Some(Node::Dir) => Ok(()),
                _ => Err(FsError::AlreadyExists(path.into())),
            };
        }
        let stored = Self::resolve(&inner, path);
        Self::ensure_parents(&mut inner, &stored);
        inner.nodes.insert(stored.clone(), Node::Dir);
        inner.events.push(FsEvent::CreateDir { path: stored });
        Ok(())
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<(), FsError> {
        let mut inner = self.0.borrow_mut();
        let Some(stored) = Self::find(&inner, from) else {
            return Err(FsError::NotFound(from.into()));
        };
        Self::deny_check(&inner, &stored)?;
        if let Err(error) = Self::check_name(&inner, to) {
            inner.events.push(FsEvent::Refused { path: to.into() });
            return Err(error);
        }
        if let Some(existing) = Self::find(&inner, to) {
            // A change of case only is a rename of the same file.
            if existing != stored {
                return Err(FsError::AlreadyExists(to.into()));
            }
        }
        let target = {
            let resolved = Self::resolve(&inner, to);
            // The spelling the caller wants for the last segment wins.
            match parent_of(&resolved) {
                Some(parent) => format!("{parent}/{}", name_of(to)),
                None => name_of(to).to_string(),
            }
        };
        let prefix = format!("{stored}/");
        let moving: Vec<String> = inner
            .nodes
            .keys()
            .filter(|k| **k == stored || k.starts_with(&prefix))
            .cloned()
            .collect();
        for old in moving {
            let node = inner.nodes.remove(&old).unwrap();
            let new = format!("{target}{}", &old[stored.len()..]);
            Self::ensure_parents(&mut inner, &new);
            inner.nodes.insert(new, node);
        }
        inner.events.push(FsEvent::Rename {
            from: stored,
            to: target,
        });
        Ok(())
    }

    fn move_to_trash(&mut self, path: &str, _reason: TrashReason) -> Result<(), FsError> {
        let mut inner = self.0.borrow_mut();
        let stored = Self::find(&inner, path).ok_or_else(|| FsError::NotFound(path.into()))?;
        Self::deny_check(&inner, &stored)?;
        match inner.nodes.get(&stored).cloned() {
            Some(Node::File { bytes, .. }) => {
                inner.nodes.remove(&stored);
                inner.trash.push(TrashEntry {
                    path: stored.clone(),
                    bytes: bytes.clone(),
                });
                inner.events.push(FsEvent::Trash {
                    path: stored,
                    bytes,
                });
                Ok(())
            }
            _ => Err(FsError::Io(format!("{path} is not a file"))),
        }
    }

    fn remove_empty_dir(&mut self, path: &str) -> Result<bool, FsError> {
        let mut inner = self.0.borrow_mut();
        let Some(stored) = Self::find(&inner, path) else {
            return Ok(false);
        };
        if inner.nodes.get(&stored) != Some(&Node::Dir) {
            return Ok(false);
        }
        let prefix = format!("{stored}/");
        if inner.nodes.keys().any(|k| k.starts_with(&prefix)) {
            return Ok(false);
        }
        inner.nodes.remove(&stored);
        inner.events.push(FsEvent::RemoveDir { path: stored });
        Ok(true)
    }

    fn recovery_pending(&mut self) -> Result<bool, FsError> {
        Ok(self.0.borrow().recovery_pending)
    }

    fn cleanup_staged(&mut self) -> Result<(), FsError> {
        let mut inner = self.0.borrow_mut();
        let leftovers: Vec<String> = inner
            .nodes
            .keys()
            .filter(|path| is_tmp_name(path))
            .cloned()
            .collect();
        for path in leftovers {
            inner.nodes.remove(&path);
        }
        inner.staged.clear();
        Ok(())
    }

    fn name_rules(&self) -> NameRules {
        self.0.borrow().rules
    }

    fn batch_begin(&mut self) {
        let mut inner = self.0.borrow_mut();
        inner.batch_depth += 1;
        inner.max_batch_depth = inner.max_batch_depth.max(inner.batch_depth);
        inner.events.push(FsEvent::BatchBegin);
    }

    fn batch_end(&mut self) {
        let mut inner = self.0.borrow_mut();
        inner.batch_depth -= 1;
        inner.events.push(FsEvent::BatchEnd);
    }
}
