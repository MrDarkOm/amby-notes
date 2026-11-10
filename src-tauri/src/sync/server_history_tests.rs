//! Earlier versions and deleted files from the server, on the application side (docs/sync-plan.md,
//! appendix И, Э5): И1–И6, И11–И13, И15, И17. The server is a fake port that serves what the
//! tests put on it, sealed with the real functions of the core; the vault is a real folder and the
//! writes go through the real history and trash. Red until `server_history` is written
//! (раздел 6). Each test names the requirement it checks.

use std::collections::{BTreeMap, HashMap};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use amby_sync_core::crypto::body::seal_body;
use amby_sync_core::crypto::header::{seal_header, Header, ItemKind};
use amby_sync_core::crypto::keys::{BodyId, ItemId, SpaceId, SpaceKey};
use amby_sync_core::crypto::padme::sealed_body_len;
use amby_sync_core::crypto::primitives::blake3_hash;
use amby_sync_core::crypto::random::OsRandom;
use amby_sync_core::engine::{
    AccountInfo, BlobState, ChangesPage, CommitItem, CommitReply, ItemRecord, Remote, RemoteError,
    ServerInfo, SyncState, VersionEntry,
};

use super::server_history::{
    deleted_files, note_versions, read_server_version, restore_deleted, restore_server_version,
    RestoreFileStatus, RestoreVersionStatus, ServerAccess, ServerHistoryCache,
    ServerListUnavailable, ServerVersionState, VersionDevice, MAX_DELETED_ROWS,
    MAX_PARALLEL_VERSION_REQUESTS,
};
use crate::history;
use crate::recycle_bin;

// ----- a vault in a temporary folder -----

struct TempVault(PathBuf);

impl TempVault {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let unique = format!(
            "amby-server-history-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        );
        let path = std::env::temp_dir().join(unique);
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn file(&self, relative: &str) -> PathBuf {
        self.0.join(relative)
    }

    fn write(&self, relative: &str, bytes: &[u8]) -> PathBuf {
        let path = self.file(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn read(&self, relative: &str) -> Option<Vec<u8>> {
        std::fs::read(self.file(relative)).ok()
    }

    /// History switched off in `.amby/workspace.json` (И6: a `restore` snapshot is made anyway).
    fn switch_history_off(&self) {
        std::fs::create_dir_all(self.0.join(".amby")).unwrap();
        std::fs::write(
            self.0.join(".amby").join("workspace.json"),
            br#"{"history":{"enabled":false}}"#,
        )
        .unwrap();
    }
}

impl Drop for TempVault {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ----- a fake server -----

fn space() -> SpaceId {
    SpaceId::from_bytes([0x51; 16])
}
fn vk() -> SpaceKey {
    SpaceKey::from_bytes([0x21; 32], 1)
}
fn item(n: u32) -> ItemId {
    let mut bytes = [0u8; 16];
    bytes[..4].copy_from_slice(&n.to_be_bytes());
    bytes[15] = 0xA5;
    ItemId::from_bytes(bytes)
}
fn body_id(item: u32, version: u64) -> BodyId {
    let mut bytes = [0u8; 16];
    bytes[..4].copy_from_slice(&item.to_be_bytes());
    bytes[8..].copy_from_slice(&version.to_be_bytes());
    BodyId::from_bytes(bytes)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn item_hex(n: u32) -> String {
    hex(item(n).as_bytes())
}

const THIS_DEVICE: [u8; 16] = [0x01; 16];
const OTHER_DEVICE: [u8; 16] = [0x02; 16];

#[derive(Default)]
struct Inner {
    versions: Mutex<HashMap<[u8; 16], Vec<VersionEntry>>>,
    bodies: Mutex<HashMap<[u8; 16], Vec<u8>>>,
    offline: AtomicBool,
    version_calls: AtomicUsize,
    download_calls: AtomicUsize,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
    delay_ms: AtomicUsize,
}

#[derive(Clone, Default)]
struct Server(Arc<Inner>);

impl Server {
    fn push(&self, n: u32, entry: VersionEntry) {
        let mut all = self.0.versions.lock().unwrap();
        let list = all.entry(*item(n).as_bytes()).or_default();
        list.push(entry);
        list.sort_by_key(|e| std::cmp::Reverse(e.version));
    }

    /// A live version with a body that matches its header.
    fn add_live(&self, n: u32, version: u64, path: &str, content: &[u8], device: [u8; 16]) {
        self.add_live_body(n, version, path, content, content, device);
    }

    /// A live version whose header describes `declared` but whose body holds `actual`: authentic
    /// bytes that do not match the header (И5, Д14).
    fn add_live_body(
        &self,
        n: u32,
        version: u64,
        path: &str,
        declared: &[u8],
        actual: &[u8],
        device: [u8; 16],
    ) {
        let header = Header {
            format: 1,
            version,
            kind: ItemKind::File,
            path: path.into(),
            size: declared.len() as u64,
            mtime_ms: 0,
            content_hash: Some(blake3_hash(declared)),
            body_id: Some(body_id(n, version)),
            deleted: false,
            extra: BTreeMap::new(),
        };
        let sealed = seal_body(&vk(), &body_id(n, version), actual, &mut OsRandom).unwrap();
        self.0
            .bodies
            .lock()
            .unwrap()
            .insert(*body_id(n, version).as_bytes(), sealed);
        self.push(n, self.entry(n, &header, device, version * 10, false));
    }

    fn add_deleted(&self, n: u32, version: u64, path: &str, device: [u8; 16], seq: u64) {
        let header = Header {
            format: 1,
            version,
            kind: ItemKind::File,
            path: path.into(),
            size: 0,
            mtime_ms: 0,
            content_hash: None,
            body_id: None,
            deleted: true,
            extra: BTreeMap::new(),
        };
        self.push(n, self.entry(n, &header, device, seq, true));
    }

    fn entry(
        &self,
        n: u32,
        header: &Header,
        device: [u8; 16],
        seq: u64,
        deleted: bool,
    ) -> VersionEntry {
        VersionEntry {
            item_id: item(n),
            version: header.version,
            seq,
            header: seal_header(&vk(), &space(), &item(n), header, &mut OsRandom).unwrap(),
            blob_id: header.body_id,
            blob_size: header
                .body_id
                .map(|_| sealed_body_len(header.size).unwrap()),
            deleted,
            device_id: device,
            committed_ms: (1_000_000 + seq * 1_000) as i64,
            superseded_ms: None,
        }
    }

    /// A file that was written, then deleted (the normal archive row).
    fn add_deleted_file(&self, n: u32, path: &str, content: &[u8], seq: u64) {
        self.add_live(n, 1, path, content, THIS_DEVICE);
        self.add_deleted(n, 2, path, OTHER_DEVICE, seq);
    }

    fn set_offline(&self, offline: bool) {
        self.0.offline.store(offline, Ordering::SeqCst);
    }

    fn connector(&self) -> impl Fn() -> Box<dyn Remote + Send> + Sync {
        let inner = self.0.clone();
        move || Box::new(FakeRemote(inner.clone())) as Box<dyn Remote + Send>
    }

    fn version_calls(&self) -> usize {
        self.0.version_calls.load(Ordering::SeqCst)
    }
    fn download_calls(&self) -> usize {
        self.0.download_calls.load(Ordering::SeqCst)
    }
    fn max_in_flight(&self) -> usize {
        self.0.max_in_flight.load(Ordering::SeqCst)
    }
    fn set_delay_ms(&self, ms: usize) {
        self.0.delay_ms.store(ms, Ordering::SeqCst);
    }
}

struct FakeRemote(Arc<Inner>);

impl Remote for FakeRemote {
    fn info(&mut self) -> Result<ServerInfo, RemoteError> {
        unreachable!("not used by the history flows")
    }
    fn changes(&mut self, _since: u64, _limit: Option<u32>) -> Result<ChangesPage, RemoteError> {
        unreachable!("not used by the history flows")
    }
    fn account(&mut self) -> Result<AccountInfo, RemoteError> {
        unreachable!("not used by the history flows")
    }
    fn blob_start(
        &mut self,
        _blob: &BodyId,
        _size: u64,
        _replaces: Option<&ItemId>,
    ) -> Result<BlobState, RemoteError> {
        unreachable!("history never writes to the server")
    }
    fn blob_delete(&mut self, _blob: &BodyId) -> Result<(), RemoteError> {
        unreachable!("history never writes to the server")
    }
    fn blob_put_part(&mut self, _b: &BodyId, _p: u64, _bytes: &[u8]) -> Result<(), RemoteError> {
        unreachable!("history never writes to the server")
    }
    fn blob_complete(&mut self, _blob: &BodyId) -> Result<(), RemoteError> {
        unreachable!("history never writes to the server")
    }
    fn blob_download(&mut self, blob: &BodyId) -> Result<Box<dyn Read + '_>, RemoteError> {
        self.0.download_calls.fetch_add(1, Ordering::SeqCst);
        if self.0.offline.load(Ordering::SeqCst) {
            return Err(RemoteError::Network("offline".into()));
        }
        match self.0.bodies.lock().unwrap().get(blob.as_bytes()) {
            Some(bytes) => Ok(Box::new(Cursor::new(bytes.clone()))),
            None => Err(RemoteError::Rejected {
                status: 404,
                code: "not_found".into(),
            }),
        }
    }
    fn versions(&mut self, item: &ItemId) -> Result<Vec<VersionEntry>, RemoteError> {
        self.0.version_calls.fetch_add(1, Ordering::SeqCst);
        let now = self.0.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.0.max_in_flight.fetch_max(now, Ordering::SeqCst);
        let delay = self.0.delay_ms.load(Ordering::SeqCst);
        if delay > 0 {
            std::thread::sleep(Duration::from_millis(delay as u64));
        }
        self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
        if self.0.offline.load(Ordering::SeqCst) {
            return Err(RemoteError::Network("offline".into()));
        }
        self.0
            .versions
            .lock()
            .unwrap()
            .get(item.as_bytes())
            .cloned()
            .ok_or(RemoteError::Rejected {
                status: 404,
                code: "not_found".into(),
            })
    }
    fn commit(
        &mut self,
        _commit_id: &[u8; 16],
        _items: &[CommitItem],
    ) -> Result<CommitReply, RemoteError> {
        unreachable!("history never writes to the server")
    }
}

// ----- the state of the engine and the access -----

fn record(n: u32, path: &str, deleted: bool, content: Option<&[u8]>) -> ItemRecord {
    ItemRecord {
        item_id: item(n),
        kind: ItemKind::File,
        path: path.into(),
        content_hash: content.map(blake3_hash),
        size: content.map_or(0, |c| c.len() as u64),
        mtime_ns: 0,
        version: 9,
        body_id: None,
        deleted,
        newer_format: false,
        extra: BTreeMap::new(),
    }
}

fn state_of(records: Vec<ItemRecord>) -> SyncState {
    let mut state = SyncState::default();
    for record in records {
        state.items.insert(*record.item_id.as_bytes(), record);
    }
    state
}

const HISTORY_DAYS: u32 = 30;

fn access<'a>(
    connect: &'a (dyn Fn() -> Box<dyn Remote + Send> + Sync),
    state: SyncState,
) -> ServerAccess<'a> {
    ServerAccess {
        connect,
        space: space(),
        keys: vec![vk()],
        state,
        this_device: THIS_DEVICE,
        device_names: vec![(OTHER_DEVICE, "Рабочий ноутбук".to_string())],
        history_days: HISTORY_DAYS,
    }
}

const NOW_MS: u64 = 5_000_000;

fn hash_hex(bytes: &[u8]) -> String {
    hex(&blake3_hash(bytes))
}

// ----- И1–И4: the server part of the history list of a note -----

#[test]
fn i4_without_sync_the_list_says_so_and_is_not_an_error() {
    // И4, docs/notices.md: a calm line, no notice.
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", b"now");
    let list = note_versions(vault.path(), &note, None);
    assert!(!list.available);
    assert_eq!(list.reason, Some(ServerListUnavailable::SyncOff));
    assert!(list.versions.is_empty());
}

#[test]
fn i4_a_lost_connection_says_offline_and_is_not_an_error() {
    // И4: a network error is the same calm line.
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", b"now");
    let server = Server::default();
    server.add_live(1, 1, "Notes/a.md", b"old", THIS_DEVICE);
    server.set_offline(true);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(b"now"))]),
    );
    let list = note_versions(vault.path(), &note, Some(&access));
    assert!(!list.available);
    assert_eq!(list.reason, Some(ServerListUnavailable::Offline));
    assert!(list.versions.is_empty());
}

#[test]
fn i4_the_list_is_asked_for_once_when_the_panel_opens() {
    // И4: one request, no repeats of its own.
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", b"now");
    let server = Server::default();
    server.add_live(1, 1, "Notes/a.md", b"old", THIS_DEVICE);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(b"now"))]),
    );
    let _ = note_versions(vault.path(), &note, Some(&access));
    assert_eq!(server.version_calls(), 1);
}

#[test]
fn i1_a_server_version_carries_the_device_label_and_the_time_of_the_server() {
    // И1: "this computer" / "another device" with the name when the server knows it.
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", b"now");
    let server = Server::default();
    server.add_live(1, 1, "Notes/a.md", b"mine", THIS_DEVICE);
    server.add_live(1, 2, "Notes/a.md", b"theirs", OTHER_DEVICE);
    server.add_live(1, 3, "Notes/a.md", b"unknown device", [0x77; 16]);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(b"now"))]),
    );
    let list = note_versions(vault.path(), &note, Some(&access));
    assert!(list.available);
    assert_eq!(list.reason, None);
    let versions: Vec<u64> = list.versions.iter().map(|v| v.version).collect();
    assert_eq!(versions, vec![3, 2, 1], "newest first");
    let by_version = |n: u64| list.versions.iter().find(|v| v.version == n).unwrap();
    assert_eq!(by_version(1).device, VersionDevice::ThisDevice);
    assert_eq!(by_version(1).device_name, None);
    assert_eq!(by_version(2).device, VersionDevice::OtherDevice);
    assert_eq!(
        by_version(2).device_name.as_deref(),
        Some("Рабочий ноутбук")
    );
    assert_eq!(by_version(3).device, VersionDevice::OtherDevice);
    assert_eq!(by_version(3).device_name, None);
    assert_eq!(by_version(2).item_id, item_hex(1));
    assert_eq!(by_version(2).content_hash, hash_hex(b"theirs"));
    assert_eq!(by_version(2).size_bytes, 6);
    assert_eq!(by_version(2).committed_ms, 1_000_000 + 20 * 1_000);
}

#[test]
fn i2_the_item_of_the_note_comes_from_the_state_of_the_engine_by_its_path() {
    // И2: the versions asked for are those of the item the engine has at this path.
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", b"now");
    let server = Server::default();
    server.add_live(1, 1, "Notes/a.md", b"item one", THIS_DEVICE);
    server.add_live(2, 1, "Notes/b.md", b"item two", THIS_DEVICE);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![
            record(1, "Notes/a.md", false, Some(b"now")),
            record(2, "Notes/b.md", false, Some(b"other")),
        ]),
    );
    let list = note_versions(vault.path(), &note, Some(&access));
    assert_eq!(list.versions.len(), 1);
    assert_eq!(list.versions[0].item_id, item_hex(1));
}

#[test]
fn i2_a_renamed_note_shows_its_older_versions_under_the_earlier_path() {
    // И2-г: the engine knows the note as Notes/new.md; version 1 had another path.
    let vault = TempVault::new();
    let note = vault.write("Notes/new.md", b"now");
    let server = Server::default();
    server.add_live(1, 1, "Notes/old.md", b"before the rename", THIS_DEVICE);
    server.add_live(1, 2, "Notes/new.md", b"after the rename", THIS_DEVICE);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/new.md", false, Some(b"now"))]),
    );
    let list = note_versions(vault.path(), &note, Some(&access));
    let paths: Vec<&str> = list.versions.iter().map(|v| v.path.as_str()).collect();
    assert_eq!(paths, vec!["Notes/new.md", "Notes/old.md"]);
}

#[test]
fn i2_a_forged_header_is_not_listed_and_the_rest_still_is() {
    // И2-в: a version sealed with another key is skipped silently for the person.
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", b"now");
    let server = Server::default();
    server.add_live(1, 1, "Notes/a.md", b"honest", THIS_DEVICE);
    let forged_key = SpaceKey::from_bytes([0xEE; 32], 1);
    let header = Header {
        format: 1,
        version: 2,
        kind: ItemKind::File,
        path: "Notes/a.md".into(),
        size: 6,
        mtime_ms: 0,
        content_hash: Some(blake3_hash(b"forged")),
        body_id: Some(body_id(1, 2)),
        deleted: false,
        extra: BTreeMap::new(),
    };
    let mut entry = server.entry(1, &header, THIS_DEVICE, 20, false);
    entry.header = seal_header(&forged_key, &space(), &item(1), &header, &mut OsRandom).unwrap();
    server.push(1, entry);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(b"now"))]),
    );
    let list = note_versions(vault.path(), &note, Some(&access));
    assert!(list.available);
    let versions: Vec<u64> = list.versions.iter().map(|v| v.version).collect();
    assert_eq!(versions, vec![1]);
}

#[test]
fn i3_a_version_equal_to_the_file_or_to_a_local_snapshot_is_not_listed() {
    // И3: the hash of the file on the disk and of every local snapshot of this note.
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", b"current");
    // A local snapshot of the text "snapshotted".
    std::fs::write(&note, b"snapshotted").unwrap();
    history::snapshot_before_write(vault.path(), &note, b"replacement", "note-save")
        .unwrap()
        .expect("a snapshot was made");
    std::fs::write(&note, b"current").unwrap();

    let server = Server::default();
    server.add_live(1, 1, "Notes/a.md", b"only on the server", OTHER_DEVICE);
    server.add_live(1, 2, "Notes/a.md", b"snapshotted", OTHER_DEVICE);
    server.add_live(1, 3, "Notes/a.md", b"current", OTHER_DEVICE);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(b"current"))]),
    );
    let list = note_versions(vault.path(), &note, Some(&access));
    let versions: Vec<u64> = list.versions.iter().map(|v| v.version).collect();
    assert_eq!(versions, vec![1]);
}

// ----- И5: preview -----

#[test]
fn i5_a_good_version_is_read_as_text_and_nothing_is_written() {
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", b"now");
    let server = Server::default();
    server.add_live(1, 1, "Notes/a.md", "старый текст".as_bytes(), THIS_DEVICE);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(b"now"))]),
    );
    let text = read_server_version(Some(&access), &item_hex(1), 1).unwrap();
    assert_eq!(text.state, ServerVersionState::Ok);
    assert_eq!(text.content.as_deref(), Some("старый текст"));
    assert_eq!(vault.read("Notes/a.md").unwrap(), b"now");
    assert!(history::list_snapshots(vault.path(), &note)
        .unwrap()
        .is_empty());
}

#[test]
fn i5_a_body_that_does_not_match_its_header_is_damaged_and_shows_no_text() {
    // И5, Д14: authentic bytes, other content than the header promised.
    let server = Server::default();
    server.add_live_body(1, 1, "Notes/a.md", b"promised", b"delivered", THIS_DEVICE);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(b"now"))]),
    );
    let text = read_server_version(Some(&access), &item_hex(1), 1).unwrap();
    assert_eq!(text.state, ServerVersionState::Damaged);
    assert_eq!(text.content, None);
}

#[test]
fn i5_a_body_beyond_the_memory_limit_is_not_downloaded() {
    // И5, Д71: "слишком большой файл для просмотра".
    let server = Server::default();
    let huge = Header {
        format: 1,
        version: 1,
        kind: ItemKind::File,
        path: "Notes/huge.md".into(),
        size: 300 * 1024 * 1024,
        mtime_ms: 0,
        content_hash: Some([7; 32]),
        body_id: Some(body_id(1, 1)),
        deleted: false,
        extra: BTreeMap::new(),
    };
    let mut entry = server.entry(1, &huge, THIS_DEVICE, 10, false);
    entry.blob_size = Some(sealed_body_len(huge.size).unwrap());
    server.push(1, entry);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/huge.md", false, None)]),
    );
    let text = read_server_version(Some(&access), &item_hex(1), 1).unwrap();
    assert_eq!(text.state, ServerVersionState::TooLarge);
    assert_eq!(text.content, None);
    assert_eq!(
        server.download_calls(),
        0,
        "the body was not even asked for"
    );
}

#[test]
fn i5_a_lost_connection_is_offline_not_an_error() {
    let server = Server::default();
    server.add_live(1, 1, "Notes/a.md", b"old", THIS_DEVICE);
    server.set_offline(true);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(b"now"))]),
    );
    let text = read_server_version(Some(&access), &item_hex(1), 1).unwrap();
    assert_eq!(text.state, ServerVersionState::Offline);
}

// ----- И6: restore a version -----

fn snapshot_bytes(vault: &TempVault, note: &Path) -> Vec<(String, Vec<u8>)> {
    history::list_snapshots(vault.path(), note)
        .unwrap()
        .into_iter()
        .map(|entry| {
            let bytes = history::prepare_snapshot_restore(vault.path(), &entry.id)
                .unwrap()
                .bytes;
            (entry.reason, bytes)
        })
        .collect()
}

#[test]
fn i6_a_restore_saves_the_current_content_then_writes_the_version_byte_for_byte() {
    // И6-а, И6-б: BOM, CRLF and a trailing space survive; the current file is in a `restore`
    // snapshot; the path is the current path of the note.
    let old: &[u8] = b"\xEF\xBB\xBFold line\r\nsecond line \r\n";
    let current: &[u8] = b"current text\n";
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", current);
    let server = Server::default();
    server.add_live(1, 1, "Notes/a.md", old, OTHER_DEVICE);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(current))]),
    );
    let outcome = restore_server_version(
        vault.path(),
        &note,
        Some(&access),
        &item_hex(1),
        1,
        &hash_hex(current),
    )
    .unwrap();
    assert_eq!(outcome.status, RestoreVersionStatus::Restored);
    assert_eq!(vault.read("Notes/a.md").unwrap(), old);
    let snapshots = snapshot_bytes(&vault, &note);
    assert_eq!(snapshots.len(), 1);
    assert_eq!(snapshots[0].0, "restore");
    assert_eq!(snapshots[0].1, current);
}

#[test]
fn i6_the_restore_snapshot_is_made_also_when_history_is_off() {
    let current: &[u8] = b"current text\n";
    let vault = TempVault::new();
    vault.switch_history_off();
    let note = vault.write("Notes/a.md", current);
    let server = Server::default();
    server.add_live(1, 1, "Notes/a.md", b"old", OTHER_DEVICE);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(current))]),
    );
    let outcome = restore_server_version(
        vault.path(),
        &note,
        Some(&access),
        &item_hex(1),
        1,
        &hash_hex(current),
    )
    .unwrap();
    assert_eq!(outcome.status, RestoreVersionStatus::Restored);
    assert_eq!(
        snapshot_bytes(&vault, &note),
        vec![("restore".to_string(), current.to_vec())]
    );
}

#[test]
fn i6_a_version_of_an_earlier_path_is_written_to_the_current_path_of_the_note() {
    // И6-б, И2-г: the renamed note gets the old text at its current path; the old path stays free.
    let vault = TempVault::new();
    let note = vault.write("Notes/new.md", b"now");
    let server = Server::default();
    server.add_live(1, 1, "Notes/old.md", b"before the rename", OTHER_DEVICE);
    server.add_live(1, 2, "Notes/new.md", b"now", OTHER_DEVICE);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/new.md", false, Some(b"now"))]),
    );
    let outcome = restore_server_version(
        vault.path(),
        &note,
        Some(&access),
        &item_hex(1),
        1,
        &hash_hex(b"now"),
    )
    .unwrap();
    assert_eq!(outcome.status, RestoreVersionStatus::Restored);
    assert_eq!(vault.read("Notes/new.md").unwrap(), b"before the rename");
    assert!(vault.read("Notes/old.md").is_none());
}

#[test]
fn i6_a_file_that_changed_since_the_list_is_not_overwritten() {
    // И6: another hash than the one read when the list was shown: nothing is written.
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", b"edited meanwhile");
    let server = Server::default();
    server.add_live(1, 1, "Notes/a.md", b"old", OTHER_DEVICE);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(b"x"))]),
    );
    let outcome = restore_server_version(
        vault.path(),
        &note,
        Some(&access),
        &item_hex(1),
        1,
        &hash_hex(b"what the list was shown for"),
    )
    .unwrap();
    assert_eq!(outcome.status, RestoreVersionStatus::NoteChanged);
    assert_eq!(vault.read("Notes/a.md").unwrap(), b"edited meanwhile");
    assert!(history::list_snapshots(vault.path(), &note)
        .unwrap()
        .is_empty());
}

#[test]
fn i6_a_damaged_version_writes_nothing_and_makes_no_snapshot() {
    // И5, И6.
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", b"now");
    let server = Server::default();
    server.add_live_body(1, 1, "Notes/a.md", b"promised", b"delivered", OTHER_DEVICE);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(b"now"))]),
    );
    let outcome = restore_server_version(
        vault.path(),
        &note,
        Some(&access),
        &item_hex(1),
        1,
        &hash_hex(b"now"),
    )
    .unwrap();
    assert_eq!(outcome.status, RestoreVersionStatus::Damaged);
    assert_eq!(vault.read("Notes/a.md").unwrap(), b"now");
    assert!(history::list_snapshots(vault.path(), &note)
        .unwrap()
        .is_empty());
}

#[test]
fn i6_without_a_connection_nothing_is_written() {
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", b"now");
    let server = Server::default();
    server.add_live(1, 1, "Notes/a.md", b"old", OTHER_DEVICE);
    server.set_offline(true);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(b"now"))]),
    );
    let outcome = restore_server_version(
        vault.path(),
        &note,
        Some(&access),
        &item_hex(1),
        1,
        &hash_hex(b"now"),
    )
    .unwrap();
    assert_eq!(outcome.status, RestoreVersionStatus::Offline);
    assert_eq!(vault.read("Notes/a.md").unwrap(), b"now");
    assert!(history::list_snapshots(vault.path(), &note)
        .unwrap()
        .is_empty());
}

// ----- И9–И13: the "on the server" part of the archive -----

fn paths_of(list: &super::server_history::DeletedOnServer) -> Vec<String> {
    list.files.iter().map(|f| f.path.clone()).collect()
}

#[test]
fn i4_without_sync_the_archive_part_is_not_available() {
    // И9, И13: no sync, no section; as data: `available = false`, no error.
    let vault = TempVault::new();
    let list = deleted_files(vault.path(), None, &ServerHistoryCache::default(), NOW_MS);
    assert!(!list.available);
    assert_eq!(list.reason, Some(ServerListUnavailable::SyncOff));
    assert!(list.files.is_empty());
    assert!(!list.truncated);
}

#[test]
fn i13_without_a_connection_the_archive_part_says_offline_and_is_not_an_error() {
    let vault = TempVault::new();
    let server = Server::default();
    server.add_deleted_file(1, "Notes/gone.md", b"text", 100);
    server.set_offline(true);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/gone.md", true, None)]),
    );
    let list = deleted_files(
        vault.path(),
        Some(&access),
        &ServerHistoryCache::default(),
        NOW_MS,
    );
    assert!(!list.available);
    assert_eq!(list.reason, Some(ServerListUnavailable::Offline));
    assert!(list.files.is_empty());
}

#[test]
fn i10_i12_a_row_has_the_path_the_size_the_deleting_device_and_the_keeping_time() {
    let vault = TempVault::new();
    let server = Server::default();
    server.add_deleted_file(1, "Notes/gone.md", "text".as_bytes(), 100);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/gone.md", true, None)]),
    );
    let list = deleted_files(
        vault.path(),
        Some(&access),
        &ServerHistoryCache::default(),
        NOW_MS,
    );
    assert!(list.available);
    assert_eq!(list.files.len(), 1);
    let row = &list.files[0];
    assert_eq!(row.item_id, item_hex(1));
    assert_eq!(row.path, "Notes/gone.md");
    assert_eq!(row.size_bytes, 4);
    assert_eq!(row.deleted_ms, 1_000_000 + 100 * 1_000);
    assert_eq!(
        row.kept_until_ms,
        Some(row.deleted_ms + u64::from(HISTORY_DAYS) * 86_400_000),
        "И12: the time of the deletion plus history_days"
    );
    assert_eq!(row.device, VersionDevice::OtherDevice);
    assert_eq!(row.device_name.as_deref(), Some("Рабочий ноутбук"));
}

#[test]
fn k5_a_file_in_the_service_trash_with_the_same_content_still_shows_in_the_server_list() {
    // К5, К6 (rewritten from И11 by К11 (з)): only the archive hides a server file; the service
    // `.amby/trash/` is not the archive and the person does not see it, so the server list is
    // the one place to get that file back.
    let vault = TempVault::new();
    let path = vault.write("Notes/trashed.md", b"same text");
    recycle_bin::move_to_trash(vault.path(), &path).unwrap();
    assert!(!path.exists());
    vault.write("Notes/other.md", b"keep alive");
    let server = Server::default();
    server.add_deleted_file(1, "Notes/trashed.md", b"same text", 100);
    server.add_deleted_file(2, "Notes/not-in-trash.md", b"never trashed here", 200);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![
            record(1, "Notes/trashed.md", true, None),
            record(2, "Notes/not-in-trash.md", true, None),
        ]),
    );
    let list = deleted_files(
        vault.path(),
        Some(&access),
        &ServerHistoryCache::default(),
        NOW_MS,
    );
    let mut paths = paths_of(&list);
    paths.sort();
    assert_eq!(paths, vec!["Notes/not-in-trash.md", "Notes/trashed.md"]);
}

#[test]
fn i11_a_trash_entry_with_other_content_does_not_hide_the_server_file() {
    // И11: same path, other content: the server copy is still the only one of its text.
    let vault = TempVault::new();
    let path = vault.write("Notes/a.md", b"a different text in the trash");
    recycle_bin::move_to_trash(vault.path(), &path).unwrap();
    let server = Server::default();
    server.add_deleted_file(1, "Notes/a.md", b"the text on the server", 100);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", true, None)]),
    );
    let list = deleted_files(
        vault.path(),
        Some(&access),
        &ServerHistoryCache::default(),
        NOW_MS,
    );
    assert_eq!(paths_of(&list), vec!["Notes/a.md"]);
}

#[test]
fn i11_a_file_that_already_lies_at_its_path_with_the_same_content_is_not_listed() {
    let vault = TempVault::new();
    vault.write("Notes/back.md", b"same text");
    vault.write("Notes/changed.md", b"edited since");
    let server = Server::default();
    server.add_deleted_file(1, "Notes/back.md", b"same text", 100);
    server.add_deleted_file(2, "Notes/changed.md", b"the text that was deleted", 200);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![
            record(1, "Notes/back.md", true, None),
            record(2, "Notes/changed.md", true, None),
        ]),
    );
    let list = deleted_files(
        vault.path(),
        Some(&access),
        &ServerHistoryCache::default(),
        NOW_MS,
    );
    assert_eq!(paths_of(&list), vec!["Notes/changed.md"]);
}

#[test]
fn i13_one_request_per_tombstone_and_never_more_than_eight_at_the_same_time() {
    let vault = TempVault::new();
    let server = Server::default();
    server.set_delay_ms(15);
    let mut records = Vec::new();
    for n in 1..=40u32 {
        let path = format!("Notes/f{n}.md");
        server.add_deleted_file(n, &path, format!("text {n}").as_bytes(), u64::from(n));
        records.push(record(n, &path, true, None));
    }
    let connect = server.connector();
    let access = access(&connect, state_of(records));
    let list = deleted_files(
        vault.path(),
        Some(&access),
        &ServerHistoryCache::default(),
        NOW_MS,
    );
    assert_eq!(list.files.len(), 40);
    assert_eq!(server.version_calls(), 40, "one request per tombstone");
    assert!(
        server.max_in_flight() <= MAX_PARALLEL_VERSION_REQUESTS,
        "{} at the same time",
        server.max_in_flight()
    );
}

#[test]
fn i13_more_than_five_hundred_show_the_newest_five_hundred_by_the_seq_of_the_deletion() {
    let vault = TempVault::new();
    let server = Server::default();
    let mut records = Vec::new();
    let total = (MAX_DELETED_ROWS + 1) as u32;
    for n in 1..=total {
        let path = format!("Notes/f{n}.md");
        // The seq of the deletion grows with n: item 1 was deleted first, so it is the one cut.
        server.add_deleted_file(
            n,
            &path,
            format!("text {n}").as_bytes(),
            1_000 + u64::from(n),
        );
        records.push(record(n, &path, true, None));
    }
    let connect = server.connector();
    let access = access(&connect, state_of(records));
    let list = deleted_files(
        vault.path(),
        Some(&access),
        &ServerHistoryCache::default(),
        NOW_MS,
    );
    assert!(list.available);
    assert!(list.truncated);
    assert_eq!(list.files.len(), MAX_DELETED_ROWS);
    assert_eq!(
        list.files[0].path,
        format!("Notes/f{total}.md"),
        "newest first"
    );
    assert!(
        list.files.iter().all(|f| f.path != "Notes/f1.md"),
        "the oldest deletion is the one that is cut"
    );
}

#[test]
fn i13_exactly_five_hundred_are_not_truncated() {
    let vault = TempVault::new();
    let server = Server::default();
    let mut records = Vec::new();
    for n in 1..=MAX_DELETED_ROWS as u32 {
        let path = format!("Notes/f{n}.md");
        server.add_deleted_file(n, &path, format!("text {n}").as_bytes(), u64::from(n));
        records.push(record(n, &path, true, None));
    }
    let connect = server.connector();
    let access = access(&connect, state_of(records));
    let list = deleted_files(
        vault.path(),
        Some(&access),
        &ServerHistoryCache::default(),
        NOW_MS,
    );
    assert_eq!(list.files.len(), MAX_DELETED_ROWS);
    assert!(!list.truncated);
}

#[test]
fn i13_the_list_is_cached_until_the_next_pass_of_the_sync() {
    let vault = TempVault::new();
    let server = Server::default();
    server.add_deleted_file(1, "Notes/gone.md", b"text", 100);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/gone.md", true, None)]),
    );
    let cache = ServerHistoryCache::default();
    let first = deleted_files(vault.path(), Some(&access), &cache, NOW_MS);
    let calls = server.version_calls();
    let second = deleted_files(vault.path(), Some(&access), &cache, NOW_MS);
    assert_eq!(first, second);
    assert_eq!(
        server.version_calls(),
        calls,
        "the second call used the cache"
    );
    cache.invalidate();
    let _ = deleted_files(vault.path(), Some(&access), &cache, NOW_MS);
    assert!(server.version_calls() > calls, "a new pass asks again");
}

#[test]
fn i13_a_lost_connection_is_not_cached() {
    let vault = TempVault::new();
    let server = Server::default();
    server.add_deleted_file(1, "Notes/gone.md", b"text", 100);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/gone.md", true, None)]),
    );
    let cache = ServerHistoryCache::default();
    server.set_offline(true);
    let offline = deleted_files(vault.path(), Some(&access), &cache, NOW_MS);
    assert!(!offline.available);
    server.set_offline(false);
    let online = deleted_files(vault.path(), Some(&access), &cache, NOW_MS);
    assert!(online.available);
    assert_eq!(online.files.len(), 1);
}

#[test]
fn i10_a_tombstone_the_server_no_longer_has_is_not_listed_and_is_not_an_error() {
    // И10: 404 after the cleanup of the server (П36).
    let vault = TempVault::new();
    let server = Server::default();
    server.add_deleted_file(1, "Notes/kept.md", b"text", 100);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![
            record(1, "Notes/kept.md", true, None),
            record(2, "Notes/cleaned-up.md", true, None),
        ]),
    );
    let list = deleted_files(
        vault.path(),
        Some(&access),
        &ServerHistoryCache::default(),
        NOW_MS,
    );
    assert!(list.available);
    assert_eq!(paths_of(&list), vec!["Notes/kept.md"]);
}

// ----- И15, И17: restore deleted files -----

#[test]
fn i15_a_deleted_file_is_written_byte_for_byte_at_its_path_and_missing_folders_are_made() {
    let content: &[u8] = b"\xEF\xBB\xBFline\r\nline two\r\n";
    let vault = TempVault::new();
    vault.write("Keep/k.md", b"keep");
    let server = Server::default();
    server.add_deleted_file(1, "Deep/er/tree/x.md", content, 100);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Deep/er/tree/x.md", true, None)]),
    );
    let outcome = restore_deleted(vault.path(), Some(&access), &[item_hex(1)]).unwrap();
    assert_eq!(outcome.requested, 1);
    assert_eq!(outcome.restored, 1);
    assert_eq!(outcome.results[0].status, RestoreFileStatus::Restored);
    assert_eq!(
        outcome.results[0].final_path.as_deref(),
        Some("Deep/er/tree/x.md")
    );
    assert_eq!(vault.read("Deep/er/tree/x.md").unwrap(), content);
}

#[test]
fn i15_a_taken_path_is_never_replaced_the_file_goes_next_to_it_as_name_2() {
    // И15, О4: the person's file stays exactly as it is; the name rule is that of the import.
    let vault = TempVault::new();
    vault.write("Notes/a.md", b"what is there now");
    let server = Server::default();
    server.add_deleted_file(1, "Notes/a.md", b"the deleted text", 100);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", true, None)]),
    );
    let outcome = restore_deleted(vault.path(), Some(&access), &[item_hex(1)]).unwrap();
    assert_eq!(outcome.restored, 1);
    let result = &outcome.results[0];
    assert_eq!(result.status, RestoreFileStatus::RestoredRenamed);
    assert_eq!(result.final_path.as_deref(), Some("Notes/a 2.md"));
    assert_eq!(vault.read("Notes/a.md").unwrap(), b"what is there now");
    assert_eq!(vault.read("Notes/a 2.md").unwrap(), b"the deleted text");
}

#[test]
fn i15_when_name_2_is_taken_too_the_file_becomes_name_3() {
    let vault = TempVault::new();
    vault.write("Notes/a.md", b"first");
    vault.write("Notes/a 2.md", b"second");
    let server = Server::default();
    server.add_deleted_file(1, "Notes/a.md", b"the deleted text", 100);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", true, None)]),
    );
    let outcome = restore_deleted(vault.path(), Some(&access), &[item_hex(1)]).unwrap();
    assert_eq!(
        outcome.results[0].final_path.as_deref(),
        Some("Notes/a 3.md")
    );
    assert_eq!(vault.read("Notes/a.md").unwrap(), b"first");
    assert_eq!(vault.read("Notes/a 2.md").unwrap(), b"second");
    assert_eq!(vault.read("Notes/a 3.md").unwrap(), b"the deleted text");
}

#[test]
fn i15_a_damaged_file_writes_nothing() {
    let vault = TempVault::new();
    vault.write("Keep/k.md", b"keep");
    let server = Server::default();
    server.add_live_body(1, 1, "Notes/bad.md", b"promised", b"delivered", THIS_DEVICE);
    server.add_deleted(1, 2, "Notes/bad.md", OTHER_DEVICE, 100);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/bad.md", true, None)]),
    );
    let outcome = restore_deleted(vault.path(), Some(&access), &[item_hex(1)]).unwrap();
    assert_eq!(outcome.restored, 0);
    assert_eq!(outcome.damaged, 1);
    assert_eq!(outcome.results[0].status, RestoreFileStatus::Damaged);
    assert_eq!(outcome.results[0].final_path, None);
    assert!(vault.read("Notes/bad.md").is_none());
}

#[test]
fn i17_one_damaged_file_does_not_stop_the_others_and_the_counts_are_right() {
    // И17: "Возвращено 5 из 6, одна повреждена": the damaged one is second, so the four after it
    // prove that an error of one does not cancel the rest.
    let vault = TempVault::new();
    vault.write("Keep/k.md", b"keep");
    let server = Server::default();
    let mut records = Vec::new();
    let mut asked = Vec::new();
    for n in 1..=6u32 {
        let path = format!("Notes/f{n}.md");
        if n == 2 {
            server.add_live_body(n, 1, &path, b"promised", b"delivered", THIS_DEVICE);
            server.add_deleted(n, 2, &path, OTHER_DEVICE, u64::from(n) * 10);
        } else {
            server.add_deleted_file(n, &path, format!("text {n}").as_bytes(), u64::from(n) * 10);
        }
        records.push(record(n, &path, true, None));
        asked.push(item_hex(n));
    }
    let connect = server.connector();
    let access = access(&connect, state_of(records));
    let outcome = restore_deleted(vault.path(), Some(&access), &asked).unwrap();
    assert_eq!(outcome.requested, 6);
    assert_eq!(outcome.restored, 5);
    assert_eq!(outcome.damaged, 1);
    let statuses: Vec<RestoreFileStatus> = outcome.results.iter().map(|r| r.status).collect();
    assert_eq!(
        statuses,
        vec![
            RestoreFileStatus::Restored,
            RestoreFileStatus::Damaged,
            RestoreFileStatus::Restored,
            RestoreFileStatus::Restored,
            RestoreFileStatus::Restored,
            RestoreFileStatus::Restored,
        ],
        "in the order asked"
    );
    for n in [1u32, 3, 4, 5, 6] {
        assert_eq!(
            vault.read(&format!("Notes/f{n}.md")).unwrap(),
            format!("text {n}").as_bytes()
        );
    }
    assert!(vault.read("Notes/f2.md").is_none());
}

#[test]
fn i17_an_item_that_is_not_a_deleted_file_of_the_server_is_gone_and_the_rest_goes_on() {
    let vault = TempVault::new();
    vault.write("Keep/k.md", b"keep");
    let server = Server::default();
    server.add_deleted_file(1, "Notes/a.md", b"text a", 100);
    server.add_deleted_file(2, "Notes/b.md", b"text b", 200);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![
            record(1, "Notes/a.md", true, None),
            record(2, "Notes/b.md", true, None),
        ]),
    );
    let outcome = restore_deleted(
        vault.path(),
        Some(&access),
        &[item_hex(1), item_hex(99), item_hex(2)],
    )
    .unwrap();
    assert_eq!(outcome.requested, 3);
    assert_eq!(outcome.restored, 2);
    assert_eq!(outcome.results[1].status, RestoreFileStatus::Gone);
    assert_eq!(vault.read("Notes/a.md").unwrap(), b"text a");
    assert_eq!(vault.read("Notes/b.md").unwrap(), b"text b");
}

#[test]
fn i17_the_mass_change_stop_of_the_sync_does_not_hold_a_restore_back() {
    // И17, Р8: creating files is not deleting. Many files at once are all written.
    let vault = TempVault::new();
    vault.write("Keep/k.md", b"keep");
    let server = Server::default();
    let mut records = Vec::new();
    let mut asked = Vec::new();
    for n in 1..=60u32 {
        let path = format!("Notes/many{n}.md");
        server.add_deleted_file(n, &path, format!("text {n}").as_bytes(), u64::from(n));
        records.push(record(n, &path, true, None));
        asked.push(item_hex(n));
    }
    let connect = server.connector();
    let access = access(&connect, state_of(records));
    let outcome = restore_deleted(vault.path(), Some(&access), &asked).unwrap();
    assert_eq!(outcome.requested, 60);
    assert_eq!(outcome.restored, 60);
}

#[test]
fn i6_without_sync_a_version_restore_answers_sync_off_and_writes_nothing() {
    // И6: no access means sync is off: no write, no snapshot.
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", b"now");
    let outcome = restore_server_version(
        vault.path(),
        &note,
        None,
        &item_hex(1),
        1,
        &hash_hex(b"now"),
    )
    .unwrap();
    assert_eq!(outcome.status, RestoreVersionStatus::SyncOff);
    assert_eq!(vault.read("Notes/a.md").unwrap(), b"now");
    assert!(history::list_snapshots(vault.path(), &note)
        .unwrap()
        .is_empty());
}

#[test]
fn i15_without_sync_a_restore_of_deleted_files_answers_sync_off_and_writes_nothing() {
    let vault = TempVault::new();
    vault.write("Keep/k.md", b"keep");
    let outcome = restore_deleted(vault.path(), None, &[item_hex(1), item_hex(2)]).unwrap();
    assert_eq!(outcome.requested, 2);
    assert_eq!(outcome.restored, 0);
    assert!(outcome
        .results
        .iter()
        .all(|r| r.status == RestoreFileStatus::SyncOff && r.final_path.is_none()));
    assert!(vault.read("Notes/f1.md").is_none());
}

// ----- И3а, И11а: a cloud mark on what the person already has -----

#[test]
fn i3a_a_snapshot_equal_to_a_server_version_is_marked_and_the_version_gets_no_row() {
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", b"current");
    std::fs::write(&note, b"snapshotted").unwrap();
    let snapshot = history::snapshot_before_write(vault.path(), &note, b"replacement", "note-save")
        .unwrap()
        .expect("a snapshot was made");
    std::fs::write(&note, b"current").unwrap();
    let server = Server::default();
    server.add_live(1, 1, "Notes/a.md", b"only on the server", OTHER_DEVICE);
    server.add_live(1, 2, "Notes/a.md", b"snapshotted", OTHER_DEVICE);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(b"current"))]),
    );
    let list = note_versions(vault.path(), &note, Some(&access));
    let listed: Vec<u64> = list.versions.iter().map(|v| v.version).collect();
    assert_eq!(listed, vec![1], "no separate row for the match (И3)");
    assert_eq!(list.snapshots_on_server.len(), 1);
    let mark = &list.snapshots_on_server[0];
    assert_eq!(mark.snapshot_id, snapshot);
    assert_eq!(mark.version, 2);
    assert_eq!(mark.device, VersionDevice::OtherDevice);
    assert_eq!(mark.device_name.as_deref(), Some("Рабочий ноутбук"));
    assert_eq!(mark.committed_ms, 1_000_000 + 20 * 1_000);
    assert!(
        !list.current_on_server,
        "the file is not the latest version"
    );
}

#[test]
fn i3a_the_newest_of_several_equal_versions_gives_the_label() {
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", b"current");
    std::fs::write(&note, b"snapshotted").unwrap();
    history::snapshot_before_write(vault.path(), &note, b"replacement", "note-save")
        .unwrap()
        .unwrap();
    std::fs::write(&note, b"current").unwrap();
    let server = Server::default();
    server.add_live(1, 1, "Notes/a.md", b"snapshotted", THIS_DEVICE);
    server.add_live(1, 2, "Notes/a.md", b"snapshotted", OTHER_DEVICE);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(b"current"))]),
    );
    let list = note_versions(vault.path(), &note, Some(&access));
    assert_eq!(list.snapshots_on_server.len(), 1, "one mark per snapshot");
    assert_eq!(list.snapshots_on_server[0].version, 2);
}

#[test]
fn i3a_the_current_text_equal_to_the_latest_server_version_is_reported() {
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", b"current");
    let server = Server::default();
    server.add_live(1, 1, "Notes/a.md", b"older", THIS_DEVICE);
    server.add_live(1, 2, "Notes/a.md", b"current", THIS_DEVICE);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(b"current"))]),
    );
    let list = note_versions(vault.path(), &note, Some(&access));
    assert!(list.current_on_server);
    assert!(list.snapshots_on_server.is_empty());
}

#[test]
fn i3a_without_sync_or_a_connection_there_are_no_marks() {
    let vault = TempVault::new();
    let note = vault.write("Notes/a.md", b"current");
    std::fs::write(&note, b"snapshotted").unwrap();
    history::snapshot_before_write(vault.path(), &note, b"replacement", "note-save")
        .unwrap()
        .unwrap();
    std::fs::write(&note, b"current").unwrap();
    let off = note_versions(vault.path(), &note, None);
    assert!(off.snapshots_on_server.is_empty());
    assert!(!off.current_on_server);
    let server = Server::default();
    server.add_live(1, 1, "Notes/a.md", b"snapshotted", OTHER_DEVICE);
    server.set_offline(true);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", false, Some(b"current"))]),
    );
    let down = note_versions(vault.path(), &note, Some(&access));
    assert!(!down.available);
    assert!(down.snapshots_on_server.is_empty());
    assert!(!down.current_on_server);
}

#[test]
fn k6_a_trash_entry_matching_a_deleted_file_has_no_cloud_mark() {
    // К6 replaces И11а: "Облачка у строк архива (И11а) больше нет". The panel shows the archive
    // only; the service trash is not on it, so there is nothing to mark.
    let vault = TempVault::new();
    let path = vault.write("Notes/trashed.md", b"same text");
    recycle_bin::move_to_trash(vault.path(), &path).unwrap();
    let server = Server::default();
    server.add_deleted_file(1, "Notes/trashed.md", b"same text", 100);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/trashed.md", true, None)]),
    );
    let list = deleted_files(
        vault.path(),
        Some(&access),
        &ServerHistoryCache::default(),
        NOW_MS,
    );
    assert!(list.available);
    assert!(list.trash_on_server.is_empty(), "К6: no marks any more");
}

#[test]
fn k6_a_file_in_the_archive_with_the_same_content_is_not_in_the_server_list() {
    // К6: "файл, который лежит в архиве с тем же содержимым, в списке сервера не показывается".
    let vault = TempVault::new();
    vault.write(".amby/archive/Notes/archived.md", b"same text");
    vault.write(".amby/archive/Proj/sub/deep.md", b"deep text");
    vault.write(
        ".amby/archive/Notes/changed.md",
        b"the archived version differs",
    );
    let server = Server::default();
    server.add_deleted_file(1, "Notes/archived.md", b"same text", 100);
    server.add_deleted_file(2, "Proj/sub/deep.md", b"deep text", 110);
    server.add_deleted_file(3, "Notes/changed.md", b"the text on the server", 120);
    server.add_deleted_file(4, "Notes/not-archived.md", b"never archived", 130);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![
            record(1, "Notes/archived.md", true, None),
            record(2, "Proj/sub/deep.md", true, None),
            record(3, "Notes/changed.md", true, None),
            record(4, "Notes/not-archived.md", true, None),
        ]),
    );
    let list = deleted_files(
        vault.path(),
        Some(&access),
        &ServerHistoryCache::default(),
        NOW_MS,
    );
    let mut paths = paths_of(&list);
    paths.sort();
    assert_eq!(paths, vec!["Notes/changed.md", "Notes/not-archived.md"]);
    assert!(list.trash_on_server.is_empty());
}

#[test]
fn k6_the_archive_hides_a_server_file_only_at_the_same_path() {
    // К6, И11: the same content at another path does not hide the file of the server.
    let vault = TempVault::new();
    vault.write(".amby/archive/Other/place.md", b"same text");
    let server = Server::default();
    server.add_deleted_file(1, "Notes/a.md", b"same text", 100);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/a.md", true, None)]),
    );
    let list = deleted_files(
        vault.path(),
        Some(&access),
        &ServerHistoryCache::default(),
        NOW_MS,
    );
    assert_eq!(paths_of(&list), vec!["Notes/a.md"]);
}

#[test]
fn i11a_a_file_lying_at_its_path_and_a_trash_entry_with_other_content_are_not_marks() {
    let vault = TempVault::new();
    vault.write("Notes/back.md", b"same text");
    let path = vault.write("Notes/a.md", b"a different text in the trash");
    recycle_bin::move_to_trash(vault.path(), &path).unwrap();
    let server = Server::default();
    server.add_deleted_file(1, "Notes/back.md", b"same text", 100);
    server.add_deleted_file(2, "Notes/a.md", b"the text on the server", 200);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![
            record(1, "Notes/back.md", true, None),
            record(2, "Notes/a.md", true, None),
        ]),
    );
    let list = deleted_files(
        vault.path(),
        Some(&access),
        &ServerHistoryCache::default(),
        NOW_MS,
    );
    assert_eq!(paths_of(&list), vec!["Notes/a.md"]);
    assert!(list.trash_on_server.is_empty());
}

#[test]
fn i11a_without_sync_or_a_connection_there_are_no_marks() {
    let vault = TempVault::new();
    let path = vault.write("Notes/trashed.md", b"same text");
    recycle_bin::move_to_trash(vault.path(), &path).unwrap();
    let off = deleted_files(vault.path(), None, &ServerHistoryCache::default(), NOW_MS);
    assert!(off.trash_on_server.is_empty());
    let server = Server::default();
    server.add_deleted_file(1, "Notes/trashed.md", b"same text", 100);
    server.set_offline(true);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![record(1, "Notes/trashed.md", true, None)]),
    );
    let down = deleted_files(
        vault.path(),
        Some(&access),
        &ServerHistoryCache::default(),
        NOW_MS,
    );
    assert!(!down.available);
    assert!(down.trash_on_server.is_empty());
}

// ----- И10а, И10б: service files, one row per path, a fresh tombstone -----

#[test]
fn i10a_service_files_get_no_row_and_no_cloud_mark() {
    let vault = TempVault::new();
    let service = ".amby/conflicts/c1/meta.json";
    let path = vault.write(service, b"closed set");
    recycle_bin::move_exact_to_trash(vault.path(), &path).unwrap();
    let server = Server::default();
    server.add_deleted_file(1, service, b"closed set", 100);
    server.add_deleted_file(2, ".amby/properties/prop_01.jsonl", b"{}", 110);
    server.add_deleted_file(3, "Notes/a.md", b"human text", 120);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![
            record(1, service, true, None),
            record(2, ".amby/properties/prop_01.jsonl", true, None),
            record(3, "Notes/a.md", true, None),
        ]),
    );
    let list = deleted_files(
        vault.path(),
        Some(&access),
        &ServerHistoryCache::default(),
        NOW_MS,
    );
    assert!(list.available);
    assert_eq!(paths_of(&list), vec!["Notes/a.md"]);
    assert!(
        list.trash_on_server.is_empty(),
        "no cloud on a service entry"
    );
    assert!(vault.read(service).is_none());
    assert_eq!(
        recycle_bin::list(vault.path()).len(),
        1,
        "the entry stays on disk"
    );
}

#[test]
fn i10a_a_service_file_is_never_restored_even_when_asked_for() {
    let vault = TempVault::new();
    let server = Server::default();
    server.add_deleted_file(1, ".amby/properties/prop_01.jsonl", b"{}", 100);
    // A tombstone whose last body sits under a service path, though the record says otherwise.
    server.add_deleted_file(2, ".amby/conflicts/c1/base", b"base", 110);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![
            record(1, ".amby/properties/prop_01.jsonl", true, None),
            record(2, "Notes/innocent.md", true, None),
        ]),
    );
    let outcome =
        restore_deleted(vault.path(), Some(&access), &[item_hex(1), item_hex(2)]).unwrap();
    assert_eq!(outcome.restored, 0);
    assert_eq!(outcome.results.len(), 2);
    for result in &outcome.results {
        assert_eq!(result.status, RestoreFileStatus::NotRestorable);
        assert!(result.final_path.is_none());
    }
    assert!(vault.read(".amby/properties/prop_01.jsonl").is_none());
    assert!(vault.read(".amby/conflicts/c1/base").is_none());
    assert!(vault.read("Notes/innocent.md").is_none());
    assert_eq!(server.download_calls(), 0, "nothing was even downloaded");
}

#[test]
fn i10b_a_note_deleted_and_restored_three_times_is_one_row_for_the_newest_deletion() {
    let vault = TempVault::new();
    let server = Server::default();
    server.add_deleted_file(1, "Notes/again.md", b"text", 100);
    server.add_deleted_file(2, "Notes/again.md", b"text", 300);
    server.add_deleted_file(3, "Notes/again.md", b"text", 200);
    let connect = server.connector();
    let access = access(
        &connect,
        state_of(vec![
            record(1, "Notes/again.md", true, None),
            record(2, "Notes/again.md", true, None),
            record(3, "Notes/again.md", true, None),
        ]),
    );
    let list = deleted_files(
        vault.path(),
        Some(&access),
        &ServerHistoryCache::default(),
        NOW_MS,
    );
    assert_eq!(list.files.len(), 1);
    assert_eq!(list.files[0].item_id, item_hex(2));
    assert_eq!(list.files[0].deleted_ms, 1_000_000 + 300 * 1_000);
}

#[test]
fn i13_a_new_tombstone_in_the_state_ends_the_life_of_a_cached_list() {
    // An own push does not move the cursor until the next pass: the cache must notice a local
    // delete by the tombstones of the state.
    let vault = TempVault::new();
    let server = Server::default();
    server.add_deleted_file(1, "Notes/first.md", b"one", 100);
    server.add_deleted_file(2, "Notes/second.md", b"two", 200);
    let connect = server.connector();
    let before = access(
        &connect,
        state_of(vec![record(1, "Notes/first.md", true, None)]),
    );
    let cache = ServerHistoryCache::default();
    let first = deleted_files(vault.path(), Some(&before), &cache, NOW_MS);
    assert_eq!(paths_of(&first), vec!["Notes/first.md"]);
    let after = access(
        &connect,
        state_of(vec![
            record(1, "Notes/first.md", true, None),
            record(2, "Notes/second.md", true, None),
        ]),
    );
    let second = deleted_files(vault.path(), Some(&after), &cache, NOW_MS);
    assert_eq!(paths_of(&second), vec!["Notes/second.md", "Notes/first.md"]);
}

#[test]
fn i13_a_tombstone_that_came_back_to_life_ends_the_life_of_a_cached_list() {
    let vault = TempVault::new();
    let server = Server::default();
    server.add_deleted_file(1, "Notes/first.md", b"one", 100);
    let connect = server.connector();
    let before = access(
        &connect,
        state_of(vec![record(1, "Notes/first.md", true, None)]),
    );
    let cache = ServerHistoryCache::default();
    assert_eq!(
        deleted_files(vault.path(), Some(&before), &cache, NOW_MS)
            .files
            .len(),
        1
    );
    // The same item is alive again: its record is no tombstone any more.
    let after = access(
        &connect,
        state_of(vec![record(1, "Notes/first.md", false, Some(b"one"))]),
    );
    assert!(deleted_files(vault.path(), Some(&after), &cache, NOW_MS)
        .files
        .is_empty());
}

#[test]
fn i13_an_unchanged_state_keeps_using_the_cache() {
    let vault = TempVault::new();
    let server = Server::default();
    server.add_deleted_file(1, "Notes/first.md", b"one", 100);
    let connect = server.connector();
    let cache = ServerHistoryCache::default();
    let state = || state_of(vec![record(1, "Notes/first.md", true, None)]);
    let first = access(&connect, state());
    let _ = deleted_files(vault.path(), Some(&first), &cache, NOW_MS);
    let calls = server.version_calls();
    let again = access(&connect, state());
    let _ = deleted_files(vault.path(), Some(&again), &cache, NOW_MS);
    assert_eq!(server.version_calls(), calls);
}
