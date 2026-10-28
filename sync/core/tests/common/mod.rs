//! Helpers shared by the crypto tests: vector loading, a scripted random source, error names.
//!
//! The tests check behaviour seen from outside (bytes in, bytes or errors out), never internals.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;

use amby_sync_core::crypto::header::{Header, ItemKind};
use amby_sync_core::crypto::keys::BodyId;
use amby_sync_core::crypto::random::Random;
use amby_sync_core::crypto::CryptoError;
use serde_json::Value;

pub const FORMAT_VECTORS: &str = include_str!("../../../vectors/format-v1.json");
pub const STANDARD_VECTORS: &str = include_str!("../../../vectors/standards.json");

pub fn format_vectors() -> Value {
    serde_json::from_str(FORMAT_VECTORS).unwrap()
}

pub fn standard_vectors() -> Value {
    serde_json::from_str(STANDARD_VECTORS).unwrap()
}

pub fn unhex(text: &str) -> Vec<u8> {
    hex::decode(text).unwrap()
}

pub fn unhex_array<const N: usize>(text: &str) -> [u8; N] {
    unhex(text).try_into().unwrap()
}

pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key]
        .as_str()
        .unwrap_or_else(|| panic!("vector field {key} is not a string"))
}

pub fn number(value: &Value, key: &str) -> u64 {
    value[key]
        .as_u64()
        .unwrap_or_else(|| panic!("vector field {key} is not a number"))
}

pub fn bytes_of(value: &Value, key: &str) -> Vec<u8> {
    unhex(text(value, key))
}

pub fn array_of<const N: usize>(value: &Value, key: &str) -> [u8; N] {
    unhex_array(text(value, key))
}

/// Byte `i` of the pattern content used by the vectors and by the tests.
pub fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| ((i * 31 + 7) % 256) as u8).collect()
}

/// A random source that serves a prepared stream and refuses to run dry (Ф31): the order and the
/// amount of random bytes an operation draws are part of the format.
pub struct Scripted {
    stream: Vec<u8>,
    position: usize,
}

impl Scripted {
    pub fn new(stream: Vec<u8>) -> Self {
        Self {
            stream,
            position: 0,
        }
    }

    pub fn from_hex(stream: &str) -> Self {
        Self::new(unhex(stream))
    }

    pub fn assert_spent(&self) {
        assert_eq!(
            self.position,
            self.stream.len(),
            "the operation drew {} of {} scripted random bytes",
            self.position,
            self.stream.len()
        );
    }
}

impl Random for Scripted {
    fn fill(&mut self, dest: &mut [u8]) {
        let end = self.position + dest.len();
        assert!(
            end <= self.stream.len(),
            "the operation drew more random bytes than scripted"
        );
        dest.copy_from_slice(&self.stream[self.position..end]);
        self.position = end;
    }
}

/// A deterministic random source for property tests (splitmix64), seeded by proptest.
pub struct SeedRandom(pub u64);

impl Random for SeedRandom {
    fn fill(&mut self, dest: &mut [u8]) {
        for byte in dest {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            *byte = ((z ^ (z >> 31)) >> 24) as u8;
        }
    }
}

/// The variant name of an error, without its fields: `UnsupportedFormat(2)` → `UnsupportedFormat`.
pub fn error_name(error: &CryptoError) -> String {
    let debug = format!("{error:?}");
    debug.split(['(', ' ', '{']).next().unwrap().to_string()
}

/// Builds a [`Header`] from the JSON object the reference writes: known fields become fields,
/// everything else is an unknown field.
pub fn header_from_value(value: &Value) -> Header {
    let object = value.as_object().unwrap();
    let mut extra = BTreeMap::new();
    for (key, field) in object {
        if ![
            "format",
            "version",
            "kind",
            "path",
            "size",
            "mtime_ms",
            "content_hash",
            "body_id",
            "deleted",
        ]
        .contains(&key.as_str())
        {
            extra.insert(key.clone(), field.clone());
        }
    }
    Header {
        format: object["format"].as_u64().unwrap(),
        version: object["version"].as_u64().unwrap(),
        kind: match object["kind"].as_str().unwrap() {
            "file" => ItemKind::File,
            "folder" => ItemKind::Folder,
            other => panic!("unknown kind {other}"),
        },
        path: object["path"].as_str().unwrap().to_string(),
        size: object["size"].as_u64().unwrap(),
        mtime_ms: object["mtime_ms"].as_i64().unwrap(),
        content_hash: object["content_hash"].as_str().map(unhex_array::<32>),
        body_id: object["body_id"]
            .as_str()
            .map(|id| BodyId::from_bytes(unhex_array::<16>(id))),
        deleted: object["deleted"].as_bool().unwrap(),
        extra,
    }
}

/// A plain file header for tests that do not care about the details.
pub fn file_header(version: u64, path: &str) -> Header {
    Header {
        format: 1,
        version,
        kind: ItemKind::File,
        path: path.to_string(),
        size: 5,
        mtime_ms: 1_760_000_000_000,
        content_hash: Some([7u8; 32]),
        body_id: Some(BodyId::from_bytes([9u8; 16])),
        deleted: false,
        extra: BTreeMap::new(),
    }
}
