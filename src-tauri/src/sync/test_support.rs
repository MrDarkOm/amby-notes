//! Helpers for the sync tests: key store and connection record in memory (the system key store
//! is not touched by tests), a server in the process, and a capture of what is logged.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use amby_sync_conformance::Target;
use tracing_subscriber::fmt::MakeWriter;

use crate::sync::connection::{ConnectionError, ConnectionRecord, ConnectionStore};
use crate::sync::secrets::{SecretError, SecretStore};
use crate::sync::service::SyncService;
use crate::sync::types::Endpoint;

/// The key store in memory. `fail` makes every call fail (a locked or missing keychain).
#[derive(Default)]
pub struct MemorySecrets {
    map: Mutex<HashMap<String, String>>,
    pub fail: AtomicBool,
    /// Only `set` fails (the keychain refuses to write).
    pub fail_set: AtomicBool,
}

impl SecretStore for MemorySecrets {
    fn get(&self, name: &str) -> Result<Option<String>, SecretError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(SecretError);
        }
        Ok(self.map.lock().unwrap().get(name).cloned())
    }

    fn set(&self, name: &str, value: &str) -> Result<(), SecretError> {
        if self.fail.load(Ordering::SeqCst) || self.fail_set.load(Ordering::SeqCst) {
            return Err(SecretError);
        }
        self.map
            .lock()
            .unwrap()
            .insert(name.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<(), SecretError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(SecretError);
        }
        self.map.lock().unwrap().remove(name);
        Ok(())
    }
}

impl MemorySecrets {
    /// How many entries the store holds (for "nothing is stored").
    pub fn len(&self) -> usize {
        self.map.lock().unwrap().len()
    }

    /// A value without the failure switches (for the assertions of tests).
    pub fn peek(&self, name: &str) -> Option<String> {
        self.map.lock().unwrap().get(name).cloned()
    }
}

/// The connection record in memory. `fail_save` makes writing fail.
#[derive(Default)]
pub struct MemoryConnection {
    record: Mutex<Option<ConnectionRecord>>,
    pub fail_save: AtomicBool,
}

impl ConnectionStore for MemoryConnection {
    fn load(&self) -> Result<Option<ConnectionRecord>, ConnectionError> {
        Ok(self.record.lock().unwrap().clone())
    }

    fn save(&self, record: &ConnectionRecord) -> Result<(), ConnectionError> {
        if self.fail_save.load(Ordering::SeqCst) {
            return Err(ConnectionError);
        }
        *self.record.lock().unwrap() = Some(record.clone());
        Ok(())
    }

    fn clear(&self) -> Result<(), ConnectionError> {
        *self.record.lock().unwrap() = None;
        Ok(())
    }
}

/// One installation of the application: a service with its own key store and record.
pub struct Device {
    pub service: SyncService,
    pub secrets: Arc<MemorySecrets>,
    pub connection: Arc<MemoryConnection>,
}

impl Device {
    /// A device that is not signed in.
    pub fn new() -> Self {
        let secrets = Arc::new(MemorySecrets::default());
        let connection = Arc::new(MemoryConnection::default());
        Self {
            service: SyncService::new(secrets.clone(), connection.clone()),
            secrets,
            connection,
        }
    }

    /// The same installation after a restart of the application: new service, same stores.
    pub fn restarted(&self) -> SyncService {
        SyncService::new(self.secrets.clone(), self.connection.clone())
    }
}

/// The address of the server under test; "local network" is on so that the tests also run
/// against a container.
pub fn endpoint_of(target: &Target) -> Endpoint {
    Endpoint {
        url: target.api.base().to_string(),
        allow_http: true,
    }
}

/// A writer that collects everything the `tracing` subscriber prints.
#[derive(Clone, Default)]
pub struct LogCapture(pub Arc<Mutex<Vec<u8>>>);

impl LogCapture {
    /// Everything captured so far.
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }

    /// A subscriber that prints every event of every crate, down to TRACE, into this capture.
    pub fn dispatch(&self) -> tracing::Dispatch {
        tracing::Dispatch::new(
            tracing_subscriber::fmt()
                .with_max_level(tracing::Level::TRACE)
                .with_ansi(false)
                .with_writer(self.clone())
                .finish(),
        )
    }
}

impl std::io::Write for LogCapture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for LogCapture {
    type Writer = LogCapture;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

// ----- vaults and sessions (stage Э4: the engine in the application) -----

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::time::{Duration, Instant};

use amby_sync_client::{DeviceToken, ServerUrl, SyncClient};
use amby_sync_conformance::client::{enroll, Account};
use amby_sync_core::crypto::keys::SpaceKey;

use crate::sync::session::{Schedule, SessionConfig, SessionHooks, SyncSession};
use crate::sync::vault_fs::FsHooks;
use crate::sync::vault_types::VaultSyncStatus;

static VAULT_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A vault in a temporary folder, removed when it is dropped. The path is canonical.
pub struct TempVault {
    pub root: PathBuf,
}

impl TempVault {
    /// A new empty folder.
    pub fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "amby-{label}-{}-{}",
            std::process::id(),
            VAULT_COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        Self {
            root: root.canonicalize().unwrap(),
        }
    }

    /// Writes a file (parents are made) and returns its path.
    pub fn put(&self, rel: &str, bytes: &[u8]) -> PathBuf {
        let path = self.root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, bytes).unwrap();
        path
    }

    /// The text of a file, if it is there.
    pub fn text(&self, rel: &str) -> Option<String> {
        std::fs::read(self.root.join(rel))
            .ok()
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    /// The bytes of a file, if it is there.
    pub fn bytes(&self, rel: &str) -> Option<Vec<u8>> {
        std::fs::read(self.root.join(rel)).ok()
    }

    /// Removes a file.
    pub fn remove(&self, rel: &str) {
        std::fs::remove_file(self.root.join(rel)).unwrap();
    }

    /// Whether something is at `rel`.
    pub fn exists(&self, rel: &str) -> bool {
        self.root.join(rel).exists()
    }

    /// Every file of the vault that synchronisation cares about (not `.amby/`, not `.git`):
    /// path → bytes.
    pub fn files(&self) -> std::collections::BTreeMap<String, Vec<u8>> {
        let mut out = std::collections::BTreeMap::new();
        for entry in walkdir::WalkDir::new(&self.root).into_iter().flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(&self.root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if rel.starts_with(".amby/") || rel.starts_with(".git/") {
                continue;
            }
            out.insert(rel, std::fs::read(entry.path()).unwrap());
        }
        out
    }

    /// Switches the history of this vault off.
    pub fn history_off(&self) {
        self.put(".amby/workspace.json", br#"{"history":{"enabled":false}}"#);
    }

    /// The snapshots of a file: (reason, text), newest first.
    pub fn snapshots(&self, rel: &str) -> Vec<(String, String)> {
        crate::history::list_snapshots(&self.root, &self.root.join(rel))
            .unwrap_or_default()
            .into_iter()
            .map(|entry| {
                let text = crate::history::read_snapshot_text(&self.root, &entry.id)
                    .map(|snapshot| snapshot.content)
                    .unwrap_or_default();
                (entry.reason, text)
            })
            .collect()
    }

    /// The original paths in the trash of the vault, sorted.
    pub fn trashed(&self) -> Vec<String> {
        let mut paths: Vec<String> = crate::recycle_bin::list(&self.root)
            .into_iter()
            .map(|entry| entry.original_path)
            .collect();
        paths.sort();
        paths
    }
}

impl Drop for TempVault {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Records what a session tells the application.
#[derive(Default)]
pub struct Recorder {
    pub statuses: Mutex<Vec<VaultSyncStatus>>,
    pub begins: AtomicU64,
    pub ends: AtomicU64,
    /// Every path reported as deleted on another computer, with the vault it was reported for,
    /// in the order reported.
    pub remote_deleted: Mutex<Vec<(PathBuf, String)>>,
    /// Every path reported as brought back after a deletion made here, in the order reported.
    pub restored: Mutex<Vec<String>>,
    /// Paths reported as merged (К1, Г17а).
    pub merged: Mutex<Vec<String>>,
}

impl FsHooks for Recorder {
    fn batch_begin(&self) {
        self.begins.fetch_add(1, Ordering::SeqCst);
    }
    fn batch_end(&self) {
        self.ends.fetch_add(1, Ordering::SeqCst);
    }
}

impl SessionHooks for Recorder {
    fn status_changed(&self, status: &VaultSyncStatus) {
        self.statuses.lock().unwrap().push(status.clone());
    }
    fn remote_deleted(&self, vault: &Path, paths: &[String]) {
        self.remote_deleted
            .lock()
            .unwrap()
            .extend(paths.iter().map(|path| (vault.to_path_buf(), path.clone())));
    }
    fn restored_after_deletion(&self, paths: &[String]) {
        self.restored.lock().unwrap().extend(paths.iter().cloned());
    }
    fn merged_after_edits(&self, paths: &[String]) {
        self.merged.lock().unwrap().extend(paths.iter().cloned());
    }
}

impl Recorder {
    /// The paths reported as deleted on another computer so far.
    pub fn deleted_remotely(&self) -> Vec<String> {
        self.remote_deleted
            .lock()
            .unwrap()
            .iter()
            .map(|(_, path)| path.clone())
            .collect()
    }

    /// The vault each of [`Self::deleted_remotely`] was reported for, in the same order.
    pub fn deleted_remotely_vaults(&self) -> Vec<PathBuf> {
        self.remote_deleted
            .lock()
            .unwrap()
            .iter()
            .map(|(vault, _)| vault.clone())
            .collect()
    }

    /// The paths reported as merged so far (К1, Г17а).
    pub fn merged_notes(&self) -> Vec<String> {
        self.merged.lock().unwrap().clone()
    }

    /// The paths reported as brought back after a deletion made here so far.
    pub fn restored_after_local_deletion(&self) -> Vec<String> {
        self.restored.lock().unwrap().clone()
    }

    /// How many times a pass began (the status turned to running).
    pub fn passes_started(&self) -> usize {
        use crate::sync::vault_types::SyncPhase;
        let list = self.statuses.lock().unwrap();
        let mut count = 0;
        let mut previous_running = false;
        for status in list.iter() {
            let running = status.phase == SyncPhase::Running;
            if running && !previous_running {
                count += 1;
            }
            previous_running = running;
        }
        count
    }
}

/// An account with a space on a server in the process; each computer is a device of the account.
pub struct Env {
    pub runtime: tokio::runtime::Runtime,
    pub target: Target,
    pub account: Account,
    pub space_id: [u8; 16],
    pub vk: SpaceKey,
}

impl Env {
    /// A server, an account with one device and one space.
    pub fn new() -> Self {
        let target = Target::from_env();
        let account = enroll(&target, "a long enough password for tests");
        let space = account.create_space();
        Self {
            runtime: tokio::runtime::Runtime::new().unwrap(),
            target,
            space_id: *space.id.as_bytes(),
            vk: space.vk.clone(),
            account,
        }
    }

    /// The same account on another computer.
    pub fn another_computer(&self, name: &str) -> Account {
        self.account.another_device(name)
    }

    /// A client of the server.
    pub fn client(&self) -> SyncClient {
        SyncClient::new(&ServerUrl::parse(self.target.api.base(), true).unwrap()).unwrap()
    }

    /// The settings of a session of `vault` on the computer `who`.
    pub fn config(
        &self,
        vault: &Path,
        who: &Account,
        hooks: Arc<dyn SessionHooks>,
    ) -> SessionConfig {
        SessionConfig {
            vault: vault.to_path_buf(),
            client: self.client(),
            token: DeviceToken::new(who.token.clone()),
            account_key: who.ak.clone(),
            space_id: self.space_id,
            space_name: Some("Test space".to_string()),
            vk: self.vk.clone(),
            device_id: who.device_id.clone(),
            test_vault: true,
            schedule: Schedule::fast(),
            hooks,
            handle: self.runtime.handle().clone(),
        }
    }

    /// Starts a session; the recorder sees its statuses.
    pub fn start(&self, vault: &TempVault, who: &Account) -> (SyncSession, Arc<Recorder>) {
        let recorder = Arc::new(Recorder::default());
        let session = SyncSession::start(self.config(&vault.root, who, recorder.clone()))
            .expect("the session must start");
        (session, recorder)
    }

    /// The number of the last commit on the server.
    pub fn head(&self) -> u64 {
        let listing = self.account.get("/v1/spaces").expect(200).json();
        listing["spaces"]
            .as_array()
            .unwrap()
            .iter()
            .find(|space| space["space_id"] == hex::encode(self.space_id))
            .map(|space| space["seq"].as_u64().unwrap())
            .unwrap_or(0)
    }
}

/// Waits until `check` holds for the status of the session, up to `timeout`.
pub fn wait_for(
    session: &SyncSession,
    timeout: Duration,
    check: impl Fn(&VaultSyncStatus) -> bool,
) -> Option<VaultSyncStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        let status = session.status();
        if check(&status) {
            return Some(status);
        }
        if Instant::now() > deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A pass on `session` that must end well; the status after it.
pub fn pass(session: &SyncSession) -> VaultSyncStatus {
    session
        .run_pass_blocking(Duration::from_secs(60))
        .expect("the pass must end in time")
}

/// Passes of two computers until nothing moves (three rounds are enough for the tests).
pub fn settle(a: &SyncSession, b: &SyncSession) {
    for _ in 0..3 {
        pass(a);
        pass(b);
    }
}
