//! Paths that Rust itself handed out, and nothing else (IPC-03, CORE-06).
//!
//! A folder from the system dialog, a file from the system dialog and the paths of a drag-and-drop
//! pass through the webview as plain strings, so a script in a window could write any other string
//! (`~`, `~/.ssh/id_ed25519`) in their place. The commands that act on such a path therefore do not
//! take the string on trust: the dialogs and the drop handler record what they gave out here, and
//! the commands accept only that, for a short time, and only until the vault changes.
//!
//! Two kinds of path are kept apart. A *folder* is a vault the person picked (or a restored backup);
//! a *source* is a file or folder the person picked or dropped to be copied into a vault. A grant of
//! one kind never authorizes the other.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::lock_util::LockExt;

/// The code the webview sees when a path was not handed out by Rust.
pub const ERR_PATH_NOT_GRANTED: &str = "PathNotGranted";

/// A picked vault folder may wait for a profile choice or a migration question.
const FOLDER_TTL: Duration = Duration::from_secs(60 * 60);
/// A picked or dropped file is copied right away.
const SOURCE_TTL: Duration = Duration::from_secs(15 * 60);
/// A drop brings a handful of paths; this only bounds the memory of a runaway sender.
const MAX_GRANTS: usize = 1024;

/// The list of known vaults the app keeps in its data folder.
pub const WORKSPACES_FILE: &str = "workspaces.json";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Folder,
    Source,
}

struct Grant {
    kind: Kind,
    raw: PathBuf,
    real: Option<PathBuf>,
    issued: Instant,
}

impl Grant {
    fn expired(&self, now: Instant) -> bool {
        let ttl = match self.kind {
            Kind::Folder => FOLDER_TTL,
            Kind::Source => SOURCE_TTL,
        };
        now.saturating_duration_since(self.issued) > ttl
    }

    fn matches(&self, candidate: &Path, candidate_real: Option<&PathBuf>) -> bool {
        self.raw == candidate
            || matches!((&self.real, candidate_real), (Some(a), Some(b)) if a == b)
    }
}

#[derive(Default)]
pub struct PathGrants {
    entries: Mutex<Vec<Grant>>,
    /// The native contract harness opens disposable vaults without a dialog.
    #[cfg(feature = "native-contract")]
    trust_everything: bool,
}

impl PathGrants {
    /// For the native contract harness only: there is no dialog to drive in it.
    #[cfg(feature = "native-contract")]
    pub fn trust_everything() -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
            trust_everything: true,
        }
    }

    #[cfg(feature = "native-contract")]
    fn trusts_everything(&self) -> bool {
        self.trust_everything
    }

    #[cfg(not(feature = "native-contract"))]
    fn trusts_everything(&self) -> bool {
        false
    }

    /// A vault folder the system dialog returned.
    pub fn grant_folder(&self, path: &Path) {
        self.grant(Kind::Folder, [path], Instant::now());
    }

    /// Files or folders the system dialog returned or the person dropped on a window.
    pub fn grant_sources<P: AsRef<Path>>(&self, paths: impl IntoIterator<Item = P>) {
        self.grant(Kind::Source, paths, Instant::now());
    }

    pub fn folder_granted(&self, path: &Path) -> bool {
        self.trusts_everything() || self.granted(Kind::Folder, path, Instant::now())
    }

    pub fn source_granted(&self, path: &Path) -> bool {
        self.trusts_everything() || self.granted(Kind::Source, path, Instant::now())
    }

    /// The vault changed: nothing that was picked for the old one carries over.
    pub fn forget_all(&self) {
        self.entries.lock_or_recover().clear();
    }

    fn grant<P: AsRef<Path>>(&self, kind: Kind, paths: impl IntoIterator<Item = P>, now: Instant) {
        let mut entries = self.entries.lock_or_recover();
        entries.retain(|grant| !grant.expired(now));
        for path in paths {
            let raw = path.as_ref().to_path_buf();
            let real = raw.canonicalize().ok();
            entries.push(Grant {
                kind,
                raw,
                real,
                issued: now,
            });
        }
        let excess = entries.len().saturating_sub(MAX_GRANTS);
        if excess > 0 {
            entries.drain(..excess);
        }
    }

    fn granted(&self, kind: Kind, path: &Path, now: Instant) -> bool {
        let real = path.canonicalize().ok();
        self.entries.lock_or_recover().iter().any(|grant| {
            grant.kind == kind && !grant.expired(now) && grant.matches(path, real.as_ref())
        })
    }
}

/// Whether the list of known vaults (`workspaces.json`) names this folder, as a recent vault or as
/// the last opened one. The list is the app's own file in its data folder.
pub fn registry_lists(registry: &str, candidate: &Path) -> bool {
    let Ok(registry) = serde_json::from_str::<serde_json::Value>(registry) else {
        return false;
    };
    let real = candidate.canonicalize().ok();
    let names = |listed: &str| -> bool {
        if listed.is_empty() {
            return false;
        }
        let listed = Path::new(listed);
        listed == candidate
            || matches!((listed.canonicalize().ok(), real.as_ref()), (Some(a), Some(b)) if &a == b)
    };
    let recent = registry
        .get("recent")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|vault| vault.get("path").and_then(serde_json::Value::as_str));
    let last = registry
        .get("lastOpened")
        .and_then(serde_json::Value::as_str);
    recent.chain(last).any(names)
}

/// Whether a vault folder given by the webview may be opened, migrated or recovered: the open
/// vault itself, a folder the system dialog gave out, or one of the known vaults.
pub fn vault_path_trusted(
    candidate: &Path,
    active_root: Option<&Path>,
    grants: &PathGrants,
    registry: &str,
) -> bool {
    if let Some(root) = active_root {
        if candidate == root || candidate.canonicalize().ok().as_deref() == Some(root) {
            return true;
        }
    }
    grants.folder_granted(candidate) || registry_lists(registry, candidate)
}

#[cfg(test)]
#[path = "path_grants_tests.rs"]
mod tests;
