//! Shared by the tests of the archive and of its migration (appendix К): a vault in a temporary
//! folder and a fake system trash.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use ulid::Ulid;

use crate::system_recycle_bin::SystemTrash;

/// A vault in a temporary folder, removed when the test ends.
pub struct Vault {
    pub root: PathBuf,
}

impl Vault {
    pub fn new() -> Self {
        let root = std::env::temp_dir().join(format!("amby-archive-{}", Ulid::generate()));
        fs::create_dir_all(&root).unwrap();
        Self {
            root: root.canonicalize().unwrap(),
        }
    }

    /// Writes a file (making folders) and returns its absolute path.
    pub fn put(&self, rel: &str, bytes: &[u8]) -> PathBuf {
        let path = self.root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }

    pub fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }

    pub fn read(&self, rel: &str) -> Option<Vec<u8>> {
        fs::read(self.root.join(rel)).ok()
    }

    pub fn exists(&self, rel: &str) -> bool {
        fs::symlink_metadata(self.root.join(rel)).is_ok()
    }

    /// Every file of the vault: relative path (`/`) → bytes.
    pub fn files(&self) -> BTreeMap<String, Vec<u8>> {
        files_under(&self.root, &self.root)
    }

    /// The files under `.amby/archive/` without the records: archive path → bytes.
    pub fn archived(&self) -> BTreeMap<String, Vec<u8>> {
        let prefix = ".amby/archive/";
        self.files()
            .into_iter()
            .filter(|(path, _)| {
                path.starts_with(prefix) && !path.starts_with(".amby/archive/.meta/")
            })
            .map(|(path, bytes)| (path[prefix.len()..].to_string(), bytes))
            .collect()
    }

    /// The records of `.amby/archive/.meta/` as `(path, archivedAtMs)`, sorted.
    pub fn metas(&self) -> Vec<(String, u64)> {
        let mut found: Vec<(String, u64)> = self
            .files()
            .into_iter()
            .filter(|(path, _)| path.starts_with(".amby/archive/.meta/"))
            .map(|(_, bytes)| {
                let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                (
                    value["path"].as_str().unwrap().to_string(),
                    value["archivedAtMs"].as_u64().unwrap(),
                )
            })
            .collect();
        found.sort();
        found
    }
}

impl Drop for Vault {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub fn files_under(base: &Path, dir: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut found = BTreeMap::new();
    let Ok(read) = fs::read_dir(dir) else {
        return found;
    };
    for entry in read.flatten() {
        let path = entry.path();
        if entry.file_type().unwrap().is_dir() {
            found.extend(files_under(base, &path));
        } else {
            let rel = path
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            found.insert(rel, fs::read(&path).unwrap());
        }
    }
    found
}

/// A copy of a whole folder (for comparing two runs of a migration from one start).
pub fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap().flatten() {
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
            // The time of the last change is data here (the archive dates entries by it): keep it,
            // as macOS does and Linux does not.
            let modified = entry.metadata().unwrap().modified().unwrap();
            fs::File::options()
                .write(true)
                .open(&target)
                .unwrap()
                .set_modified(modified)
                .unwrap();
        }
    }
}

/// A fake system trash: it takes the item into a folder of its own (as the system would) or
/// refuses, and it remembers what it was asked to take.
pub struct FakeTrash {
    pub shelf: PathBuf,
    pub refuse: bool,
    pub asked: Mutex<Vec<PathBuf>>,
}

impl FakeTrash {
    pub fn taking() -> Self {
        Self::new(false)
    }

    pub fn refusing() -> Self {
        Self::new(true)
    }

    fn new(refuse: bool) -> Self {
        let shelf = std::env::temp_dir().join(format!("amby-fake-trash-{}", Ulid::generate()));
        fs::create_dir_all(&shelf).unwrap();
        Self {
            shelf,
            refuse,
            asked: Mutex::new(Vec::new()),
        }
    }

    pub fn asked(&self) -> Vec<PathBuf> {
        self.asked.lock().unwrap().clone()
    }

    /// The files the fake trash holds: relative path in the shelf → bytes.
    pub fn held(&self) -> BTreeMap<String, Vec<u8>> {
        files_under(&self.shelf, &self.shelf)
    }
}

impl SystemTrash for FakeTrash {
    fn trash(&self, path: &Path) -> Result<(), String> {
        self.asked.lock().unwrap().push(path.to_path_buf());
        if self.refuse {
            return Err("the system trash refused".to_string());
        }
        let slot = self.shelf.join(Ulid::generate().to_string());
        fs::create_dir_all(&slot).map_err(|e| e.to_string())?;
        fs::rename(path, slot.join(path.file_name().unwrap())).map_err(|e| e.to_string())
    }
}

impl Drop for FakeTrash {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.shelf);
    }
}
