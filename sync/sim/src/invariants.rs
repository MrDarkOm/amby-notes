//! The invariants of the simulation (docs/sync-plan.md, раздел 7) and the rules of Р7/Р8 that can
//! be checked on every pass without knowing the scenario:
//!
//! 1. convergence: when everything is quiet, all devices (and the server) have the same files
//!    with the same bytes;
//! 2. nothing is lost: every content a pass saw on a device is somewhere at the end: a file, a
//!    conflict copy, a snapshot of the history, the trash or a version on the server;
//! 3. the server is blind: no plain text in its database and bodies;
//! 4. protections, see [`check_pass`]: the engine never replaces or trashes a local content that
//!    nobody else has (О5, Р7, Р8) and always makes a snapshot before a replacement (Р8, Д53).
//!    The protections that need a scenario (mass change, reset, empty vault, rollback) are checked
//!    where the scenario makes them happen, see `scenario.rs`.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use crate::vfs::{hash_of, FsEvent, Hash};
use crate::world::World;

/// Which invariant failed. The tests of the broken engines name the one they expect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// 1. Devices do not agree.
    Convergence,
    /// 2. A saved version is nowhere.
    NothingLost,
    /// 4. A local content nobody else has was replaced or trashed without a copy (О5, Р7, Р8).
    Displaced,
    /// 4. A file was replaced without a snapshot (Р8).
    NoSnapshot,
    /// 3. Plain text on the server.
    NotBlind,
    /// 4. A protection did not fire when it had to, or fired when it must not.
    Protection,
    /// К1: edits in different places did not end up together in the file, or a line a side wrote
    /// was dropped by a merge (Г4, Г15 д).
    MergeLoss,
    /// К1: a conflict was raised for edits in different places (Г4).
    NotMerged,
    /// К2: the second version of a real conflict is not kept in a set of `.amby/conflicts/`: it
    /// is a copy beside the file, or the set is damaged, or neither version stands in the tree
    /// (Г20–Г23).
    ConflictNotStored,
    /// К2: conflict marks inside a file (Г15 е, Г20).
    Marks,
    /// Е.9 (1): a local file vanished or changed because of a limit.
    LimitTouchedLocal,
    /// Е.9 (2): a version or a body on the server was removed because of a limit.
    LimitRemovedServer,
    /// Е.9 (3): after the limits were lifted the files did not converge.
    LimitNotConverged,
    /// Е.9 (4): a refusal by a limit stopped the pass as a mass change.
    LimitMassChange,
    /// Е.9 (5): the server accepted growth over the quota.
    QuotaOverrun,
    /// Е.9 (6): a failure of a call lost the record of what is being sent.
    SendRecordLost,
    /// Е.9, ceiling of the history: a latest version was pruned, or the order "oldest first"
    /// was broken.
    HistoryCeiling,
    /// The engine failed in a way the scenario did not expect.
    Unexpected,
}

#[derive(Debug, Clone)]
pub struct Violation {
    pub kind: Kind,
    pub detail: String,
}

impl fmt::Display for Violation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.detail)
    }
}

pub fn violation(kind: Kind, detail: impl Into<String>) -> Violation {
    Violation {
        kind,
        detail: detail.into(),
    }
}

fn shown(bytes: &[u8]) -> String {
    let text: String = String::from_utf8_lossy(&bytes[..bytes.len().min(40)]).into_owned();
    format!("{text:?} ({} bytes)", bytes.len())
}

/// Checked after every pass of a device (rule 4).
pub fn check_pass(world: &World, index: usize) -> Result<(), Violation> {
    let device = world.dev(index);
    let events = device.fs.events();
    let start = device.checked_events.get().min(events.len());
    device.checked_events.set(events.len());
    let present: BTreeSet<Hash> = device.fs.files().values().map(|b| hash_of(b)).collect();
    let mut server: Option<BTreeSet<Hash>> = None;
    for event in &events[start..] {
        let (path, old, snapshot) = match event {
            FsEvent::Publish {
                path,
                old: Some(old),
                snapshot,
            } => (path, old, Some(*snapshot)),
            FsEvent::Trash { path, bytes } => (path, bytes, None),
            _ => continue,
        };
        if snapshot == Some(false) {
            if std::env::var("AMBY_SIM_DEBUG").is_ok() {
                for e in &events {
                    eprintln!("{} event: {e:?}", device.name);
                }
            }
            return Err(violation(
                Kind::NoSnapshot,
                format!(
                    "{}: {path} was replaced without a snapshot (Р8, Д53)",
                    device.name
                ),
            ));
        }
        let hash = hash_of(old);
        if present.contains(&hash) || world.known.borrow().contains(&hash) {
            continue;
        }
        let on_server = server.get_or_insert_with(|| world.server_hashes());
        if !on_server.contains(&hash) {
            // К1, Г16: a merge replaces the local file by a text with the edits of both sides
            // (new to the server, or equal to its version when the other side had them all), and
            // the old content stays in the history. It is not lost if every line that only this
            // side wrote is in the result (the other side may have removed base lines).
            let fresh = device.fs.fresh_replacement(path, &hash);
            if let Some(new) = fresh.clone().or_else(|| device.fs.content(path)) {
                let known = world.server_lines();
                let kept: BTreeSet<&[u8]> = new.split_inclusive(|b| *b == b'\n').collect();
                let lost = old
                    .split_inclusive(|b| *b == b'\n')
                    .find(|line| !kept.contains(line) && !known.contains(*line));
                match (lost, fresh.is_some()) {
                    (None, _) => continue,
                    (Some(lost), true) => {
                        return Err(violation(
                            Kind::MergeLoss,
                            format!(
                                "{}: the merge of {path} dropped the line {} that only this device wrote (Г15 д)",
                                device.name,
                                shown(lost)
                            ),
                        ));
                    }
                    (Some(_), false) => {}
                }
            }
            return Err(violation(
                Kind::Displaced,
                format!(
                    "{}: the local content {} of {path} was {} while nobody else had it and no copy was kept (О5, Р7, Р8)",
                    device.name,
                    shown(old),
                    if snapshot.is_some() { "replaced" } else { "moved to the trash" },
                ),
            ));
        }
    }
    Ok(())
}

/// What to check at the end.
#[derive(Clone, Copy)]
pub struct CheckOptions {
    /// Compare folders too (the real engine synchronises them; the mini-engine does not).
    pub folders: bool,
}

/// Convergence, nothing lost, the server is blind (rules 1–3). Call when everything is quiet.
pub fn check_final(world: &World, options: CheckOptions) -> Result<(), Violation> {
    check_convergence(world, options)?;
    check_sets(world)?;
    check_nothing_lost(world)?;
    check_blind(world)
}

/// К2 (Г20–Г23): no conflict marks, no copy beside a file, every set that is there is whole and
/// has the layout of Г21. (An incomplete folder is not an error: it is not a set yet, Г23.)
pub fn check_sets(world: &World) -> Result<(), Violation> {
    for device in &world.devices {
        let files = device.fs.files();
        for (path, bytes) in &files {
            if !path.starts_with(".amby/")
                && contains(bytes, b"<<<<<<<")
                && contains(bytes, b">>>>>>>")
            {
                return Err(violation(
                    Kind::Marks,
                    format!("{}: {path} holds conflict marks (Г15 е, Г20)", device.name),
                ));
            }
        }
        if let Some(copy) = crate::conflicts::old_style_copies(&files).first() {
            return Err(violation(
                Kind::ConflictNotStored,
                format!(
                    "{}: {copy} is a conflict copy beside a file, the second version belongs in .amby/conflicts/ (Г20)",
                    device.name
                ),
            ));
        }
        let found = crate::conflicts::read_sets(&files);
        if let Some(problem) = found.problems.first() {
            return Err(violation(
                Kind::ConflictNotStored,
                format!("{}: a set is damaged: {problem} (Г21)", device.name),
            ));
        }
    }
    Ok(())
}

/// What one merge episode of a scenario must end in (К1, К2).
#[derive(Debug, Clone)]
pub enum Expect {
    /// The edits are in different places: every device has exactly these bytes, and no set names
    /// the file.
    Merged(Vec<u8>),
    /// The same place was edited: the tree has one of the two versions on every device, and a set
    /// keeps the other, byte for byte; `base` is what the set must hold as the common base, if
    /// anything.
    Conflict { base: Option<Vec<u8>> },
}

/// A merge episode: two versions `a` and `b` of the file at `path`, edited offline from one base.
#[derive(Debug, Clone)]
pub struct Episode {
    pub path: String,
    pub a: Vec<u8>,
    pub b: Vec<u8>,
    pub expect: Expect,
}

/// Checks an episode on every device, when everything is quiet.
pub fn check_episode(world: &World, episode: &Episode) -> Result<(), Violation> {
    for device in &world.devices {
        let files = device.fs.files();
        let tree = files.get(&episode.path);
        let sets: Vec<_> = crate::conflicts::read_sets(&files)
            .complete
            .into_iter()
            .filter(|set| set.path == episode.path)
            .collect();
        let is_version = |bytes: &[u8]| bytes == episode.a || bytes == episode.b;
        match &episode.expect {
            Expect::Merged(expected) => {
                if !sets.is_empty() {
                    return Err(violation(
                        Kind::NotMerged,
                        format!(
                            "{}: edits in different places of {} raised a conflict (Г4)",
                            device.name, episode.path
                        ),
                    ));
                }
                match tree {
                    Some(bytes) if bytes == expected => {}
                    Some(bytes) if is_version(bytes) => {
                        return Err(violation(
                            Kind::NotMerged,
                            format!(
                                "{}: {} holds one version, not both edits: {} (Г4)",
                                device.name,
                                episode.path,
                                shown(bytes)
                            ),
                        ))
                    }
                    other => {
                        return Err(violation(
                            Kind::MergeLoss,
                            format!(
                                "{}: {} should be {}, it is {} (Г15 д)",
                                device.name,
                                episode.path,
                                shown(expected),
                                other.map_or("missing".to_string(), |b| shown(b))
                            ),
                        ))
                    }
                }
            }
            Expect::Conflict { base } => {
                let Some(bytes) = tree.filter(|b| is_version(b)) else {
                    return Err(violation(
                        Kind::ConflictNotStored,
                        format!(
                            "{}: after a real conflict {} is neither version: {} (Г2, Г20)",
                            device.name,
                            episode.path,
                            tree.map_or("missing".to_string(), |b| shown(b))
                        ),
                    ));
                };
                let other = if *bytes == episode.a {
                    &episode.b
                } else {
                    &episode.a
                };
                let Some(set) = sets.iter().find(|set| &set.other == other) else {
                    return Err(violation(
                        Kind::ConflictNotStored,
                        format!(
                            "{}: the other version {} of {} is in no set of .amby/conflicts/ (Г20)",
                            device.name,
                            shown(other),
                            episode.path
                        ),
                    ));
                };
                if let Some(base) = base {
                    if set.base.as_ref() != Some(base) {
                        return Err(violation(
                            Kind::ConflictNotStored,
                            format!(
                                "{}: the set {} of {} lacks the common base (Г21)",
                                device.name, set.id, episode.path
                            ),
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

/// The folders of a device that the engine synchronises. A folder it never synchronises (`.amby`
/// itself, `.obsidian`, Р4, Д11) is not part of the convergence: the person may leave an empty
/// `.amby` behind by moving `.amby/conflicts` away, and the other device has none (seed 3006).
fn synchronised_dirs(device: &crate::world::Device) -> BTreeSet<String> {
    device
        .fs
        .dirs()
        .into_iter()
        .filter(|path| !amby_sync_core::engine::rules::is_excluded_path(path))
        .collect()
}

pub fn check_convergence(world: &World, options: CheckOptions) -> Result<(), Violation> {
    let first = world.dev(0).fs.files();
    for (i, device) in world.devices.iter().enumerate().skip(1) {
        let other = device.fs.files();
        if first != other {
            return Err(violation(
                Kind::Convergence,
                format!(
                    "device 0 and device {i} differ: {}",
                    describe_diff(&first, &other)
                ),
            ));
        }
        if options.folders && synchronised_dirs(world.dev(0)) != synchronised_dirs(device) {
            return Err(violation(
                Kind::Convergence,
                format!(
                    "folders of device 0 {:?} and device {i} {:?} differ",
                    synchronised_dirs(world.dev(0)),
                    synchronised_dirs(device)
                ),
            ));
        }
    }
    let server = world.server_files();
    if server != first {
        return Err(violation(
            Kind::Convergence,
            format!(
                "the devices and the server differ: {}",
                describe_diff(&first, &server)
            ),
        ));
    }
    Ok(())
}

fn describe_diff(a: &BTreeMap<String, Vec<u8>>, b: &BTreeMap<String, Vec<u8>>) -> String {
    let mut out = Vec::new();
    for (path, content) in a {
        match b.get(path) {
            None => out.push(format!("{path} only in the first")),
            Some(other) if other != content => {
                out.push(format!("{path}: {} vs {}", shown(content), shown(other)))
            }
            _ => {}
        }
    }
    for path in b.keys() {
        if !a.contains_key(path) {
            out.push(format!("{path} only in the second"));
        }
    }
    out.join("; ")
}

pub fn check_nothing_lost(world: &World) -> Result<(), Violation> {
    let mut required: BTreeMap<Hash, Vec<u8>> = BTreeMap::new();
    for device in &world.devices {
        required.extend(device.fs.required());
    }
    if required.is_empty() {
        return Ok(());
    }
    let mut places: BTreeSet<Hash> = BTreeSet::new();
    for device in &world.devices {
        places.extend(device.fs.files().values().map(|b| hash_of(b)));
        places.extend(device.fs.history().iter().map(|h| hash_of(&h.bytes)));
        places.extend(device.fs.trash().iter().map(|t| hash_of(&t.bytes)));
    }
    let mut server_checked = false;
    for (hash, content) in &required {
        if places.contains(hash) {
            continue;
        }
        if !server_checked {
            // Only versions whose body really opens count (a corrupt upload is a loss).
            for item in world.server_items(true) {
                for version in item.versions {
                    if let Some(bytes) = version.content {
                        places.insert(hash_of(&bytes));
                    }
                }
            }
            server_checked = true;
        }
        if !places.contains(hash) {
            return Err(violation(
                Kind::NothingLost,
                format!(
                    "a saved version {} is not a file, a copy, a snapshot, in the trash or on the server (О4)",
                    shown(content)
                ),
            ));
        }
    }
    Ok(())
}

fn files_under(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    if let Ok(read) = std::fs::read_dir(dir) {
        for entry in read.flatten() {
            let path = entry.path();
            if path.is_dir() {
                files_under(&path, out);
            } else {
                out.push(path);
            }
        }
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

/// No path and no content (and nothing with the marker of the simulation) in the data of the
/// server (О1, Р1, раздел 7, 3).
pub fn check_blind(world: &World) -> Result<(), Violation> {
    let Some(control) = world.target().control() else {
        return Ok(());
    };
    let mut secrets: Vec<(String, Vec<u8>)> = vec![("the marker".into(), crate::MARKER.to_vec())];
    for device in &world.devices {
        for (path, content) in device.fs.files() {
            if content.len() >= 12 {
                secrets.push((format!("content of {path}"), content));
            }
            for segment in path.split('/') {
                if segment.len() >= 6 {
                    secrets.push((format!("name {segment}"), segment.as_bytes().to_vec()));
                }
            }
        }
    }
    for (label, bytes) in secrets.clone() {
        secrets.push((format!("{label} in hex"), hex::encode(&bytes).into_bytes()));
    }
    let mut files = Vec::new();
    files_under(control.data_dir(), &mut files);
    for file in files {
        let Ok(data) = std::fs::read(&file) else {
            continue;
        };
        for (label, secret) in &secrets {
            if contains(&data, secret) {
                return Err(violation(
                    Kind::NotBlind,
                    format!("{label} is in {} on the server (О1)", file.display()),
                ));
            }
        }
    }
    Ok(())
}
