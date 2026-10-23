//! The store of the conflicts of a vault, as the interface sees it (docs/sync-plan.md, appendix Г,
//! stage Э4б, К2: Г25–Г36). The interface (К3, К4) asks this port for the list, the versions and
//! the resolution and does not know where the second version lies: today in
//! `.amby/conflicts/<id>/` (a set, Г21), for conflicts made before stage Э4б in a copy
//! `Name.<id>-conflict.ext` beside the file (Г29).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::engine::conflict_set::{
    decode_meta, is_in_conflicts_dir, SetMeta, CONFLICTS_DIR,
};
use amby_sync_core::engine::merge::{is_mergeable_path, MERGE_MAX_BYTES};
use amby_sync_core::engine::rules::is_excluded_path;
use amby_sync_core::engine::{ConflictKind, FsError, LocalFs, SnapshotReason, TrashReason};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use walkdir::WalkDir;

use crate::index::identity::{is_sync_conflict_copy, original_of_conflict_copy};
use crate::sync::vault_fs::{FsHooks, VaultFs};

/// Where a conflict is kept (Г29).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ConflictSource {
    /// A set in `.amby/conflicts/<id>/` (Г21).
    Bundle,
    /// A copy `Name.<id>-conflict.ext` beside the file, made before stage Э4б.
    LegacyCopy,
}

/// One line of the list (Г32).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictEntry {
    /// The id (twelve hex characters): the folder of the set, or, for a legacy copy, the digest of
    /// its path.
    pub id: String,
    /// `bothEdited` or `bothCreated`.
    pub kind: String,
    /// The current path of the original (Г27).
    pub path: String,
    /// Where the second version lies (information).
    pub other_path: String,
    /// When the set or the copy was made, Unix milliseconds (display only).
    pub created_ms: i64,
    /// Set or legacy copy.
    pub source: ConflictSource,
    /// Both versions can be compared line by line and assembled (Г28).
    pub text: bool,
    /// The set has a common base (Г21).
    pub has_base: bool,
    /// This computer made the set (its entry is in the state, Г25, Г34).
    pub created_here: bool,
}

/// One version of a file for the comparison (Г33).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictVersion {
    /// Size in bytes (a JSON number, never above 2^53 in practice: files are at most 512 MiB).
    pub size: u32,
    /// BLAKE3, lowercase hex.
    pub hash: String,
    /// The text exactly as the bytes read as UTF-8 (BOM as U+FEFF, `\r\n` kept), only when the
    /// conflict is `text`.
    pub text: Option<String>,
}

/// What `read` answers (Г33).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDetails {
    /// The line of the list.
    pub entry: ConflictEntry,
    /// The file at the path now.
    pub current: ConflictVersion,
    /// The second version.
    pub other: ConflictVersion,
    /// The common base, when the set has one.
    pub base: Option<ConflictVersion>,
}

/// How the person resolves a conflict (Г33).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Resolution {
    /// Keep the file as it is.
    Current,
    /// The second version replaces the file.
    Other,
    /// This text is written to the file, byte for byte (UTF-8, nothing added or normalised).
    #[serde(rename_all = "camelCase")]
    Assembled {
        /// The text assembled by the interface from the source text of the chosen blocks.
        text: String,
    },
}

/// Why the store refused (Г35). The interface translates the code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConflictError {
    /// No conflict with this id.
    NotFound,
    /// The set is incomplete (Г23).
    Incomplete,
    /// The original is not there and cannot be made (Г27).
    OriginalMissing,
    /// `Assembled` for a file that is not text (Г28).
    NotText,
    /// The disk failed.
    Storage(String),
}

impl std::fmt::Display for ConflictError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl ConflictError {
    /// The machine code the interface gets (Г35).
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::Incomplete => "incomplete",
            Self::OriginalMissing => "original_missing",
            Self::NotText => "not_text",
            Self::Storage(_) => "storage_error",
        }
    }
}

/// The port (Г31).
pub trait ConflictStore {
    /// Every open conflict of the vault, sets and legacy copies, by `created_ms` then `id` (Г25,
    /// Г29, Г32). Nothing is read from the network.
    fn list(&mut self) -> Result<Vec<ConflictEntry>, ConflictError>;

    /// The versions of one conflict (Г33). `NotFound`, `Incomplete`.
    fn read(&mut self, id: &str) -> Result<ConflictDetails, ConflictError>;

    /// Resolves one conflict (Г26): writes the result into the original with a history snapshot,
    /// moves the files of the conflict to the vault trash, and forgets it. Safe to repeat.
    fn resolve(&mut self, id: &str, resolution: Resolution) -> Result<(), ConflictError>;
}

/// The store on the files of a vault.
pub struct FileConflictStore {
    vault: PathBuf,
    /// The current path of each item (hex of the `item_id`), from the state (Г27).
    paths: BTreeMap<String, String>,
    /// The ids the state lists as made here (Г25).
    created_here: BTreeSet<String>,
    hooks: Option<Arc<dyn FsHooks>>,
}

/// A conflict as it lies on the disk.
enum Located {
    Bundle { meta: SetMeta, dir: String },
    Legacy { copy: String },
}

/// Is `bytes` something both sides of a comparison can show as text (Г28, Г5)?
fn is_text(path: &str, bytes: &[u8]) -> bool {
    is_mergeable_path(path)
        && bytes.len() <= MERGE_MAX_BYTES
        && !bytes.contains(&0)
        && std::str::from_utf8(bytes).is_ok()
}

fn modified_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| {
            i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
        })
}

/// The id of a conflict listed from its copy alone: twelve hex characters of a digest of the
/// copy's path (as before stage Э4б).
fn listing_id(copy: &str) -> String {
    let digest = Sha256::digest(format!("amby-sync/conflict-listing/1\n{copy}"));
    hex::encode(&digest[..6])
}

/// A name inside a set folder: no path, no way out of the folder.
fn is_plain_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\'])
}

impl FileConflictStore {
    /// A store of the vault `vault`. `paths` maps the hex of an `item_id` to its current path in
    /// the vault; `created_here` is the set of ids in `SyncState.conflicts` (Г25).
    pub fn new(
        vault: PathBuf,
        paths: BTreeMap<String, String>,
        created_here: BTreeSet<String>,
    ) -> Self {
        Self {
            vault,
            paths,
            created_here,
            hooks: None,
        }
    }

    /// Writes and removals go through the hooks of the application (the watcher, the index), as
    /// those of a pass do.
    #[must_use]
    pub fn with_hooks(mut self, hooks: Arc<dyn FsHooks>) -> Self {
        self.hooks = Some(hooks);
        self
    }

    fn files(&self) -> VaultFs {
        match &self.hooks {
            Some(hooks) => VaultFs::with_hooks(self.vault.clone(), hooks.clone()),
            None => VaultFs::new(self.vault.clone()),
        }
    }

    fn read_file(&self, relative: &str) -> Option<Vec<u8>> {
        fs::read(self.vault.join(relative)).ok()
    }

    /// The sets that are complete (Г23): `meta.json` that reads, and an `other` (and a base, when
    /// the meta names one) with the bytes the meta says.
    fn sets(&self) -> (Vec<(SetMeta, String)>, BTreeSet<String>) {
        let mut complete = Vec::new();
        let mut incomplete = BTreeSet::new();
        let Ok(folders) = fs::read_dir(self.vault.join(CONFLICTS_DIR)) else {
            return (complete, incomplete);
        };
        for folder in folders.flatten() {
            let Some(name) = folder.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !folder.path().is_dir() {
                continue;
            }
            let dir = format!("{CONFLICTS_DIR}/{name}");
            // A set made on this computer stays open when its files were edited since (the
            // person edited the second version): it is theirs, and the comparison must see
            // the change. A set from elsewhere must match its `meta.json` (Г23).
            let lenient = self.created_here.contains(&name);
            match self.read_set(&dir, &name, lenient) {
                Some(meta) => complete.push((meta, dir)),
                None => {
                    incomplete.insert(name);
                }
            }
        }
        (complete, incomplete)
    }

    fn read_set(&self, dir: &str, name: &str, lenient: bool) -> Option<SetMeta> {
        let meta = decode_meta(&self.read_file(&format!("{dir}/meta.json"))?).ok()?;
        if meta.id != name || !is_plain_name(&meta.other) {
            return None;
        }
        let other = self.read_file(&format!("{dir}/{}", meta.other))?;
        let matches =
            blake3_hash(&other) == meta.other_hash && other.len() as u64 == meta.other_size;
        if !matches && !lenient {
            return None;
        }
        if let (Some(base_name), Some(base_hash)) = (&meta.base, &meta.base_hash) {
            if !is_plain_name(base_name) {
                return None;
            }
            let base = self.read_file(&format!("{dir}/{base_name}"))?;
            if &blake3_hash(&base) != base_hash && !lenient {
                return None;
            }
        }
        Some(meta)
    }

    /// The copies of conflicts made before stage Э4б (Г29): the copy and its file are both
    /// there; a copy that repeats the `amby-id` of its file is a conflict, and so is one the
    /// state lists as made here; a copy with an identity of its own is a note of its own.
    fn legacy(&self) -> Vec<(String, String)> {
        let mut found = Vec::new();
        let walk = WalkDir::new(&self.vault).into_iter().filter_entry(|entry| {
            entry.depth() == 0 || {
                let relative = relative_name(&self.vault, entry.path());
                !is_excluded_path(&relative) || is_in_conflicts_dir(&relative)
            }
        });
        for entry in walk.filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            let copy = relative_name(&self.vault, entry.path());
            if is_in_conflicts_dir(&copy) || !is_sync_conflict_copy(&copy) {
                continue;
            }
            let Some(original) = original_of_conflict_copy(&copy) else {
                continue;
            };
            if self.legacy_is_open(&original, &copy) {
                found.push((original, copy));
            }
        }
        found
    }

    fn legacy_is_open(&self, original: &str, copy: &str) -> bool {
        let (copy_file, original_file) = (self.vault.join(copy), self.vault.join(original));
        if !copy_file.is_file() || !original_file.is_file() {
            return false;
        }
        let recorded = copy_name_id(copy).is_some_and(|id| self.created_here.contains(&id));
        let (Ok(copy_text), Ok(original_text)) = (
            fs::read_to_string(&copy_file),
            fs::read_to_string(&original_file),
        ) else {
            return recorded;
        };
        let copy_id = claimed_amby_id(&copy_text);
        let original_id = claimed_amby_id(&original_text);
        if copy_id.is_some() && copy_id != original_id {
            return false;
        }
        recorded || copy_id.is_some()
    }

    fn current_path(&self, meta: &SetMeta) -> String {
        self.paths
            .get(&hex::encode(meta.item_id.as_bytes()))
            .cloned()
            .unwrap_or_else(|| meta.path.clone())
    }

    fn bundle_entry(&self, meta: &SetMeta, dir: &str) -> ConflictEntry {
        let path = self.current_path(meta);
        let other = self
            .read_file(&format!("{dir}/{}", meta.other))
            .unwrap_or_default();
        let current = self.read_file(&path);
        let text = is_text(&path, &other)
            && current.as_deref().is_none_or(|bytes| is_text(&path, bytes))
            && meta.base.as_ref().is_none_or(|name| {
                self.read_file(&format!("{dir}/{name}"))
                    .is_some_and(|bytes| is_text(&path, &bytes))
            });
        ConflictEntry {
            id: meta.id.clone(),
            kind: match meta.kind {
                ConflictKind::BothEdited => "bothEdited",
                ConflictKind::BothCreated => "bothCreated",
            }
            .to_string(),
            path,
            other_path: format!("{dir}/{}", meta.other),
            created_ms: modified_ms(&self.vault.join(format!("{dir}/meta.json"))),
            source: ConflictSource::Bundle,
            text,
            has_base: meta.base.is_some(),
            created_here: self.created_here.contains(&meta.id),
        }
    }

    fn legacy_entry(&self, original: &str, copy: &str) -> ConflictEntry {
        let text = match (self.read_file(original), self.read_file(copy)) {
            (Some(a), Some(b)) => is_text(original, &a) && is_text(original, &b),
            _ => false,
        };
        ConflictEntry {
            id: listing_id(copy),
            kind: "bothEdited".to_string(),
            path: original.to_string(),
            other_path: copy.to_string(),
            created_ms: modified_ms(&self.vault.join(copy)),
            source: ConflictSource::LegacyCopy,
            text,
            has_base: false,
            created_here: copy_name_id(copy).is_some_and(|id| self.created_here.contains(&id)),
        }
    }

    fn locate(&self, id: &str) -> Result<(ConflictEntry, Located), ConflictError> {
        let (sets, incomplete) = self.sets();
        if let Some((meta, dir)) = sets.into_iter().find(|(meta, _)| meta.id == id) {
            return Ok((
                self.bundle_entry(&meta, &dir),
                Located::Bundle { meta, dir },
            ));
        }
        if incomplete.contains(id) {
            return Err(ConflictError::Incomplete);
        }
        for (original, copy) in self.legacy() {
            if listing_id(&copy) == id {
                return Ok((
                    self.legacy_entry(&original, &copy),
                    Located::Legacy { copy },
                ));
            }
        }
        Err(ConflictError::NotFound)
    }

    fn version(bytes: &[u8], text: bool) -> ConflictVersion {
        ConflictVersion {
            size: u32::try_from(bytes.len()).unwrap_or(u32::MAX),
            hash: hex::encode(blake3_hash(bytes)),
            text: if text {
                String::from_utf8(bytes.to_vec()).ok()
            } else {
                None
            },
        }
    }

    /// Writes `bytes` to `path` as an ordinary write with a snapshot of what it replaces (Г26).
    fn write_original(&self, path: &str, bytes: &[u8]) -> Result<(), ConflictError> {
        let mut files = self.files();
        files.batch_begin();
        let result = (|| {
            let mut staged = files.begin_write(path)?;
            for chunk in bytes.chunks(64 * 1024) {
                if let Err(error) = staged.write(chunk) {
                    staged.abort();
                    return Err(error);
                }
            }
            staged.publish(Some(SnapshotReason::SyncOverwrite))
        })();
        files.batch_end();
        result.map_err(storage_fs)
    }

    /// Moves files to the trash of the vault; a file that is not there is fine (Г26 (2)).
    fn trash(&self, paths: &[String]) -> Result<(), ConflictError> {
        let mut files = self.files();
        files.batch_begin();
        let mut outcome = Ok(());
        for path in paths {
            match files.move_to_trash(path, TrashReason::RemoteDeletion) {
                Ok(()) | Err(FsError::NotFound(_)) => {}
                Err(error) => {
                    outcome = Err(storage_fs(error));
                    break;
                }
            }
        }
        files.batch_end();
        outcome
    }
}

fn storage_fs(error: FsError) -> ConflictError {
    ConflictError::Storage(error.to_string())
}

/// A path inside the vault with `/` separators and NFC, as the engine names files.
fn relative_name(vault: &Path, path: &Path) -> String {
    let rel = path.strip_prefix(vault).unwrap_or(path);
    rel.components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
        .nfc()
        .collect()
}

/// The `amby-id` a note claims in its YAML header, as written (an invalid one is still a claim):
/// a copy repeats the claim of its file (Г29).
fn claimed_amby_id(text: &str) -> Option<String> {
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    for line in lines {
        let line = line.trim_end();
        if line == "---" || line == "..." {
            return None;
        }
        if let Some(value) = line.strip_prefix("amby-id:") {
            let value = value.trim().trim_matches(['"', '\'']);
            return (!value.is_empty()).then(|| value.to_string());
        }
    }
    None
}

/// The twelve hex characters inside the name of an old copy.
pub(crate) fn copy_name_id(copy: &str) -> Option<String> {
    let name = copy.rsplit('/').next()?;
    let at = name.rfind("-conflict")?;
    let dot = name[..at].rfind('.')?;
    Some(name[dot + 1..at].to_string())
}

impl ConflictStore for FileConflictStore {
    fn list(&mut self) -> Result<Vec<ConflictEntry>, ConflictError> {
        let (sets, _) = self.sets();
        let mut entries: Vec<ConflictEntry> = sets
            .iter()
            .map(|(meta, dir)| self.bundle_entry(meta, dir))
            .collect();
        for (original, copy) in self.legacy() {
            entries.push(self.legacy_entry(&original, &copy));
        }
        entries.sort_by(|a, b| {
            a.created_ms
                .cmp(&b.created_ms)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(entries)
    }

    fn read(&mut self, id: &str) -> Result<ConflictDetails, ConflictError> {
        let (entry, located) = self.locate(id)?;
        let current = self
            .read_file(&entry.path)
            .ok_or(ConflictError::OriginalMissing)?;
        let other = self
            .read_file(&entry.other_path)
            .ok_or(ConflictError::Incomplete)?;
        let base = match &located {
            Located::Bundle { meta, dir } => meta
                .base
                .as_ref()
                .and_then(|name| self.read_file(&format!("{dir}/{name}"))),
            Located::Legacy { .. } => None,
        };
        Ok(ConflictDetails {
            current: Self::version(&current, entry.text),
            other: Self::version(&other, entry.text),
            base: base.map(|bytes| Self::version(&bytes, entry.text)),
            entry,
        })
    }

    fn resolve(&mut self, id: &str, resolution: Resolution) -> Result<(), ConflictError> {
        let (entry, located) = self.locate(id)?;
        if matches!(resolution, Resolution::Assembled { .. }) && !entry.text {
            return Err(ConflictError::NotText);
        }
        let original = self.vault.join(&entry.path);
        // (1) The file gets the chosen content (Г26), by an ordinary write with a snapshot.
        match &resolution {
            Resolution::Current => {
                if !original.is_file() {
                    return Err(ConflictError::OriginalMissing);
                }
            }
            Resolution::Other => {
                let bytes = self
                    .read_file(&entry.other_path)
                    .ok_or(ConflictError::Incomplete)?;
                if original.is_dir() {
                    return Err(ConflictError::OriginalMissing);
                }
                self.write_original(&entry.path, &bytes)?;
            }
            Resolution::Assembled { text } => {
                if original.is_dir() {
                    return Err(ConflictError::OriginalMissing);
                }
                self.write_original(&entry.path, text.as_bytes())?;
            }
        }
        // (2) The files of the conflict go to the trash of the vault, the meta first: the
        // conflict is gone at one moment, and a crash leaves nothing but loose files.
        let doomed: Vec<String> = match &located {
            Located::Bundle { dir, .. } => {
                let mut names: Vec<String> = fs::read_dir(self.vault.join(dir))
                    .map(|entries| {
                        entries
                            .flatten()
                            .filter(|e| e.path().is_file())
                            .filter_map(|e| e.file_name().to_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                names.sort_by_key(|name| name != "meta.json");
                names
                    .into_iter()
                    .map(|name| format!("{dir}/{name}"))
                    .collect()
            }
            Located::Legacy { copy, .. } => vec![copy.clone()],
        };
        self.trash(&doomed)?;
        if let Located::Bundle { dir, .. } = &located {
            let mut files = self.files();
            let _ = files.remove_empty_dir(dir);
        }
        Ok(())
    }
}
