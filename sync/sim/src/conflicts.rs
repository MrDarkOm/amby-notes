//! Conflict sets as the simulation sees them (docs/sync-plan.md, appendix Г, К2: Г20–Г23): an
//! **independent** reader of the layout of `.amby/conflicts/<id>/` (it does not call
//! `sync/core/src/engine/conflict_set.rs`, which is `todo!()` until the engine of stage Э4б is
//! written), the writer of a set for the mini-engine, and the finders the invariants and the tests
//! use.

use std::collections::BTreeMap;

use amby_sync_core::crypto::primitives::blake3_hash;
use serde_json::Value;

use crate::vfs::Hash;

/// The folder of all sets (Г21).
pub const DIR: &str = ".amby/conflicts";

/// A complete set (Г23).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetView {
    pub id: String,
    /// `"bothEdited"` or `"bothCreated"`.
    pub kind: String,
    pub item_id: String,
    /// The path of the original, from `meta.json`.
    pub path: String,
    pub other_name: String,
    pub other: Vec<u8>,
    pub base: Option<Vec<u8>>,
    pub meta: Vec<u8>,
}

/// Everything found in the folders of sets.
#[derive(Debug, Default)]
pub struct Found {
    pub complete: Vec<SetView>,
    /// Folders that are not a set yet (Г23): no `meta.json`, or no `other` that matches it.
    pub incomplete: Vec<String>,
    /// A `meta.json` that is there but wrong (not the layout of Г21).
    pub problems: Vec<String>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Reads the sets in a map of files (a device, or the server).
pub fn read_sets(files: &BTreeMap<String, Vec<u8>>) -> Found {
    let mut found = Found::default();
    let mut folders: BTreeMap<String, Vec<(&str, &Vec<u8>)>> = BTreeMap::new();
    for (path, bytes) in files {
        let Some(rest) = path.strip_prefix(".amby/conflicts/") else {
            continue;
        };
        let Some((id, name)) = rest.split_once('/') else {
            continue;
        };
        folders
            .entry(id.to_string())
            .or_default()
            .push((name, bytes));
    }
    for (id, entries) in folders {
        let find = |name: &str| entries.iter().find(|(n, _)| *n == name).map(|(_, b)| *b);
        let Some(meta_bytes) = find("meta.json") else {
            found.incomplete.push(id);
            continue;
        };
        let Ok(meta) = serde_json::from_slice::<Value>(meta_bytes) else {
            found.problems.push(format!("{id}: meta.json is not JSON"));
            continue;
        };
        let text = |key: &str| meta[key].as_str().map(str::to_string);
        let (Some(mid), Some(kind), Some(item_id), Some(path), Some(other_name), Some(other_hash)) = (
            text("id"),
            text("kind"),
            text("item_id"),
            text("path"),
            text("other"),
            text("other_hash"),
        ) else {
            found
                .problems
                .push(format!("{id}: meta.json lacks a field"));
            continue;
        };
        if meta["v"] != 1
            || mid != id
            || !is_hex(&id, 12)
            || !is_hex(&item_id, 32)
            || !is_hex(&other_hash, 64)
            || !matches!(kind.as_str(), "bothEdited" | "bothCreated")
            || meta["other_size"].as_u64().is_none()
        {
            found
                .problems
                .push(format!("{id}: meta.json is not the layout of Г21"));
            continue;
        }
        let Some(other) = find(&other_name) else {
            found.incomplete.push(id);
            continue;
        };
        if hex(&blake3_hash(other)) != other_hash
            || meta["other_size"].as_u64() != Some(other.len() as u64)
        {
            found.incomplete.push(id);
            continue;
        }
        let base = match (text("base"), text("base_hash")) {
            (Some(name), Some(hash)) => match find(&name) {
                Some(bytes) if hex(&blake3_hash(bytes)) == hash => Some(bytes.clone()),
                _ => {
                    found.incomplete.push(id);
                    continue;
                }
            },
            (None, None) if meta["base"].is_null() && meta["base_hash"].is_null() => None,
            _ => {
                found
                    .problems
                    .push(format!("{id}: base and base_hash do not agree"));
                continue;
            }
        };
        found.complete.push(SetView {
            id,
            kind,
            item_id,
            path,
            other_name,
            other: other.clone(),
            base,
            meta: meta_bytes.clone(),
        });
    }
    found
}

/// Is the last segment `Name.<12 hex>-conflict.ext`: a copy beside the file as it was made before
/// stage Э4б (Д46)?
pub fn is_old_style_copy(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    let Some(at) = name.find("-conflict") else {
        return false;
    };
    let before = &name[..at];
    before.len() > 13
        && is_hex(&before[before.len() - 12..], 12)
        && before[..before.len() - 12].ends_with('.')
}

/// The old-style copies in a map of files, outside the folder of sets (Г19).
pub fn old_style_copies(files: &BTreeMap<String, Vec<u8>>) -> Vec<String> {
    files
        .keys()
        .filter(|p| is_old_style_copy(p) && !p.starts_with(".amby/conflicts/"))
        .cloned()
        .collect()
}

/// The extension of Г21: the dot and 1–8 characters of `A–Z a–z 0–9` after the last dot of the
/// last segment.
pub fn extension(original: &str) -> String {
    let name = original.rsplit('/').next().unwrap_or(original);
    match name.rfind('.') {
        Some(dot) if dot > 0 => {
            let ext = &name[dot + 1..];
            if (1..=8).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
                format!(".{ext}")
            } else {
                String::new()
            }
        }
        _ => String::new(),
    }
}

/// The paths of a set (Г21): `(dir, other, base, meta)`.
pub fn paths(id: &str, original: &str) -> (String, String, String, String) {
    let dir = format!("{DIR}/{id}");
    let ext = extension(original);
    (
        dir.clone(),
        format!("{dir}/other{ext}"),
        format!("{dir}/base{ext}"),
        format!("{dir}/meta.json"),
    )
}

/// The identifier of a set (Г22), written out again here.
pub fn set_id(
    item_id: &[u8; 16],
    other_hash: &Hash,
    version: u64,
    base_hash: Option<&Hash>,
    attempt: u32,
) -> String {
    let mut data = b"amby-sync/conflict/2".to_vec();
    data.extend_from_slice(item_id);
    data.extend_from_slice(other_hash);
    data.extend_from_slice(&version.to_be_bytes());
    data.extend_from_slice(base_hash.unwrap_or(&[0u8; 32]));
    if attempt != 0 {
        data.extend_from_slice(&attempt.to_be_bytes());
    }
    hex(&blake3_hash(&data)[..6])
}

/// The exact bytes of `meta.json` (Г21).
pub fn meta_bytes(
    id: &str,
    kind: &str,
    item_id: &[u8; 16],
    path: &str,
    other_name: &str,
    other: &[u8],
    base: Option<(&str, &[u8])>,
) -> Vec<u8> {
    let q = |t: &str| serde_json::to_string(t).expect("a string is JSON");
    let (base_name, base_hash) = match base {
        Some((name, bytes)) => (q(name), format!("\"{}\"", hex(&blake3_hash(bytes)))),
        None => ("null".to_string(), "null".to_string()),
    };
    format!(
        "{{\"v\":1,\"id\":{},\"kind\":{},\"item_id\":\"{}\",\"path\":{},\"other\":{},\"other_hash\":\"{}\",\"other_size\":{},\"base\":{},\"base_hash\":{}}}",
        q(id),
        q(kind),
        hex(item_id),
        q(path),
        q(other_name),
        hex(&blake3_hash(other)),
        other.len(),
        base_name,
        base_hash,
    )
    .into_bytes()
}

/// The files of a set in the order they are written (Г23): `other`, `base`, `meta.json`.
pub fn set_files(
    id: &str,
    kind: &str,
    item_id: &[u8; 16],
    original: &str,
    other: &[u8],
    base: Option<&[u8]>,
) -> Vec<(String, Vec<u8>)> {
    let (_, other_path, base_path, meta_path) = paths(id, original);
    let other_name = other_path.rsplit('/').next().unwrap_or("other").to_string();
    let base_name = base_path.rsplit('/').next().unwrap_or("base").to_string();
    let mut files = vec![(other_path, other.to_vec())];
    if let Some(bytes) = base {
        files.push((base_path, bytes.to_vec()));
    }
    let meta = meta_bytes(
        id,
        kind,
        item_id,
        original,
        &other_name,
        other,
        base.map(|b| (base_name.as_str(), b)),
    );
    files.push((meta_path, meta));
    files
}
