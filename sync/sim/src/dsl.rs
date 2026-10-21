//! Short helpers for the directed scenarios (one row of Р7, one rule of Р8, one line of раздел 5
//! per test): saving a file as text, reading it back, passes that must finish, and the final
//! invariants of раздел 7 after every scenario.

use std::collections::BTreeMap;

use amby_sync_core::crypto::header::{Header, ItemKind};
use amby_sync_core::crypto::keys::{BodyId, ItemId};
use amby_sync_core::crypto::primitives::{hkdf_sha256, xchacha20poly1305_seal};
use amby_sync_core::engine::{
    Approvals, CycleOutcome, CycleReport, CycleRequest, EngineBuilder, StopReason,
};
use serde_json::{json, Value};

use crate::invariants::{check_final, check_pass, CheckOptions};
use crate::world::{World, WorldOptions};

/// Text of a file, lossily.
pub fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Is `path` a conflict copy of `original` (Р7, Д46): the same folder, `Name.<12 hex>-conflict.ext`?
pub fn is_copy_of(path: &str, original: &str) -> bool {
    let (dir, name) = split_dir(original);
    let (copy_dir, copy_name) = split_dir(path);
    if dir != copy_dir {
        return false;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let Some(rest) = copy_name.strip_prefix(&format!("{stem}.")) else {
        return false;
    };
    let Some(id) = rest.strip_suffix(&format!("-conflict{ext}")) else {
        return false;
    };
    id.len() == 12
        && id
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

fn split_dir(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path),
    }
}

impl World {
    /// The user of device `d` saves a text file.
    pub fn save(&self, d: usize, path: &str, content: &str) {
        self.dev(d).fs.user_write(path, content.as_bytes());
    }

    /// The text of a file of device `d`.
    pub fn read(&self, d: usize, path: &str) -> Option<String> {
        self.dev(d).fs.content(path).map(|b| text(&b))
    }

    /// Files of device `d` as text.
    pub fn texts(&self, d: usize) -> BTreeMap<String, String> {
        self.dev(d)
            .fs
            .files()
            .into_iter()
            .map(|(p, b)| (p, text(&b)))
            .collect()
    }

    /// The conflict copies of `original` on device `d`: path → text.
    pub fn copies(&self, d: usize, original: &str) -> BTreeMap<String, String> {
        self.texts(d)
            .into_iter()
            .filter(|(p, _)| is_copy_of(p, original))
            .collect()
    }

    /// One pass of device `d` that must end in `Done`.
    pub fn pass(&self, d: usize) -> CycleReport {
        self.dev(d).sync_ok()
    }

    /// One pass with the given approvals.
    pub fn pass_with(&self, d: usize, approvals: Approvals) -> CycleReport {
        match self.dev(d).sync_with(&CycleRequest { approvals }) {
            Ok(report) => report,
            Err(error) => panic!("device {d}: the pass failed: {error}"),
        }
    }

    /// One pass that must stop; returns the reason.
    pub fn stop(&self, d: usize) -> StopReason {
        match self.dev(d).sync() {
            Ok(CycleReport {
                outcome: CycleOutcome::Stopped(reason),
                ..
            }) => reason,
            other => panic!("device {d}: expected a stop, got {other:?}"),
        }
    }

    /// Each device once, in order.
    pub fn round(&self) {
        for d in 0..self.devices.len() {
            self.pass(d);
        }
    }

    /// The id and the version of the live item at `path` on the server.
    pub fn item_at(&self, path: &str) -> (ItemId, u64) {
        for item in self.server_items(false) {
            let latest = &item.versions[0];
            if latest.header.path == path && !latest.header.deleted {
                return (item.item_id, latest.version);
            }
        }
        panic!("the server has no live item at {path}");
    }

    /// All versions of the item at `path` on the server, newest first (live or not).
    pub fn versions_at(&self, path: &str) -> Vec<crate::world::ServerVersion> {
        self.server_items(true)
            .into_iter()
            .find(|i| i.versions.iter().any(|v| v.header.path == path))
            .map(|i| i.versions)
            .unwrap_or_default()
    }

    /// How many items (live or deleted) the server has.
    pub fn server_item_count(&self) -> usize {
        self.server_items(false).len()
    }

    /// A cheaper `finish` for scenarios with hundreds of files: settles and checks the rules of
    /// every pass, but does not decrypt the whole server.
    pub fn finish_light(&self) {
        self.settle_ok();
        for d in 0..self.devices.len() {
            if let Err(v) = check_pass(self, d) {
                panic!("{v}");
            }
        }
        let first = self.dev(0).fs.files();
        for d in 1..self.devices.len() {
            assert_eq!(
                first,
                self.dev(d).fs.files(),
                "device {d} differs from device 0"
            );
        }
    }

    /// Lowers the mass-change threshold of every device so that the boundaries of Р8 (a whole
    /// number of files and "more than 10%") can be tested on a few files: at least `min_files`.
    pub fn scale_mass_threshold(&self, min_files: usize) {
        for device in &self.devices {
            *device.config_tweak.borrow_mut() = Some(Box::new(move |config| {
                config.mass_min_files = min_files;
            }));
        }
    }

    /// Settles, then checks the invariants of раздел 7 and the rules of Р8 on every pass so far.
    /// `folders`: compare the folders of the devices as well.
    pub fn finish(&self, folders: bool) {
        self.settle_ok();
        for d in 0..self.devices.len() {
            if let Err(v) = check_pass(self, d) {
                panic!("{v}");
            }
        }
        if let Err(v) = check_final(self, CheckOptions { folders }) {
            panic!("{v}");
        }
    }
}

/// Two devices on the shared server.
pub fn two(builder: EngineBuilder) -> World {
    World::new(builder, WorldOptions::new(2))
}

/// Three devices on the shared server.
pub fn three(builder: EngineBuilder) -> World {
    World::new(builder, WorldOptions::new(3))
}

/// Two devices with a vault that already holds `Keep/k.md` (it keeps the vault from being empty,
/// Д55) and `Notes/a.md` = `base`, synchronised on both.
pub fn pair_with_a(builder: EngineBuilder) -> World {
    let w = two(builder);
    w.save(0, "Keep/k.md", "keep");
    w.save(0, "Notes/a.md", "base");
    w.pass(0);
    w.pass(1);
    assert_eq!(w.read(1, "Notes/a.md").as_deref(), Some("base"));
    w
}

/// A header sealed by hand with the format of a newer Amby (Р13, С13): `json` is its plain
/// canonical text, padded to 256 bytes and encrypted exactly as Ф17 and Ф18 say.
pub fn forge_envelope(w: &World, item: &ItemId, version: u64, json: &str) -> Vec<u8> {
    let mut plain = json.as_bytes().to_vec();
    while plain.len() % 256 != 0 {
        plain.push(0);
    }
    let key: [u8; 32] = hkdf_sha256(&[], w.vk.as_bytes(), b"amby-sync/header-key/1", 32)
        .expect("hkdf")
        .try_into()
        .expect("32 bytes");
    let mut aad = b"amby-sync/header/1".to_vec();
    aad.extend_from_slice(w.space_id.as_bytes());
    aad.extend_from_slice(item.as_bytes());
    aad.extend_from_slice(&w.vk.epoch().to_be_bytes());
    aad.extend_from_slice(&version.to_be_bytes());
    let nonce = [0x42u8; 24];
    let sealed = xchacha20poly1305_seal(&key, &nonce, &aad, &plain);
    let mut out = vec![1u8];
    out.extend_from_slice(&w.vk.epoch().to_be_bytes());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    out
}

/// A commit entry made of a header envelope and a body reference, as raw JSON for `POST /commit`.
pub fn commit_entry(
    item: &ItemId,
    base_version: u64,
    envelope: &[u8],
    blob: Option<&BodyId>,
    deleted: bool,
) -> Value {
    json!({
        "item_id": hex::encode(item.as_bytes()),
        "base_version": base_version,
        "header": hex::encode(envelope),
        "blob_id": blob.map(|b| hex::encode(b.as_bytes())),
        "deleted": deleted,
    })
}

impl World {
    /// Someone else commits raw entries (anything, including contradictory headers).
    pub fn inject_raw(&self, entries: Vec<Value>) -> u64 {
        let space = self.space(0);
        let body = json!({
            "commit_id": hex::encode(crate::world::fresh_id()),
            "items": entries,
        });
        space.post("/commit", body).expect(200).json()["seq"]
            .as_u64()
            .expect("seq")
    }

    /// Someone else makes a folder.
    pub fn inject_folder(&self, item: &ItemId, base_version: u64, path: &str) -> u64 {
        let space = self.space(0);
        space.commit_ok(&[space.folder(item, base_version, path)])
    }

    /// A header of this world for an arbitrary combination of fields (a contradictory one too).
    pub fn header(
        &self,
        version: u64,
        kind: ItemKind,
        path: &str,
        body: Option<BodyId>,
        hash: Option<[u8; 32]>,
        size: u64,
        deleted: bool,
    ) -> Header {
        Header {
            format: 1,
            version,
            kind,
            path: path.to_string(),
            size,
            mtime_ms: 0,
            content_hash: hash,
            body_id: body,
            deleted,
            extra: Default::default(),
        }
    }
}
