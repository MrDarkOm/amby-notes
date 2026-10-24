//! The world of a scenario: one real server of stage Э2 in this process, one account, one space
//! and several devices, each with a virtual file system, a state store and a plan of faults. The
//! engine under test is built by an [`EngineBuilder`] for every pass, so the same scenarios run
//! against the real engine and against the broken mini-engines (раздел 6).

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;
use std::sync::OnceLock;

use amby_sync_conformance::client::{enroll, enroll_body, hex16, login, Account, Space, PASSWORD};
use amby_sync_conformance::inprocess::InProcess;
use amby_sync_conformance::{Api, Target};
use amby_sync_core::crypto::account::{
    derive_recovery_keys, seal_account_key_for_password, wrap_account_key, wrap_space_key,
    Argon2Params, NewAccount,
};
use amby_sync_core::crypto::header::Header;
use amby_sync_core::crypto::keys::{ItemId, SpaceId, SpaceKey};
use amby_sync_core::crypto::random::{OsRandom, Random};
use amby_sync_core::engine::{
    Clock, CycleReport, CycleRequest, EngineBuilder, EngineConfig, EngineError, Ports,
};
use serde_json::json;

use crate::fault::{Faults, FaultyFs, FaultyRemote, FaultyState, Lies};
use crate::net::{HttpRemote, SharedSpace};
use crate::state::MemState;
use crate::vfs::{hash_of, Hash, Vfs};

/// A deterministic random source (splitmix64) for the engine under test.
pub struct SimRandom(pub u64);

impl Random for SimRandom {
    fn fill(&mut self, dest: &mut [u8]) {
        for chunk in dest.chunks_mut(8) {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^= z >> 31;
            chunk.copy_from_slice(&z.to_le_bytes()[..chunk.len()]);
        }
    }
}

/// A clock that moves by itself, so marks differ.
pub struct SimClock(pub Rc<Cell<i64>>);

impl Clock for SimClock {
    fn now_ms(&self) -> i64 {
        let now = self.0.get() + 1000;
        self.0.set(now);
        now
    }
}

/// One simulated device.
pub struct Device {
    pub name: String,
    pub fs: Vfs,
    pub state: MemState,
    pub faults: Faults,
    pub lies: Rc<RefCell<Lies>>,
    pub space: SharedSpace,
    pub passes: Cell<u64>,
    seed: u64,
    clock: Rc<Cell<i64>>,
    builder: EngineBuilder,
    space_id: SpaceId,
    vk: SpaceKey,
    known: Rc<RefCell<BTreeSet<Hash>>>,
    pub config_tweak: RefCell<Option<Box<dyn Fn(&mut EngineConfig)>>>,
    /// Index into the file-system events up to which the invariants have looked.
    pub checked_events: Cell<usize>,
}

impl Device {
    fn ports(&self) -> Ports {
        let remote = FaultyRemote {
            inner: Box::new(HttpRemote::new(self.space.clone())),
            faults: self.faults.clone(),
            lies: self.lies.clone(),
            known: self.known.clone(),
            space_id: self.space_id,
            vk: self.vk.clone(),
        };
        let n = self.passes.get();
        Ports {
            fs: Box::new(FaultyFs {
                inner: self.fs.clone(),
                faults: self.faults.clone(),
            }),
            remote: Box::new(remote),
            state: Box::new(FaultyState {
                inner: self.state.clone(),
                faults: self.faults.clone(),
            }),
            clock: Box::new(SimClock(self.clock.clone())),
            rng: Box::new(SimRandom(self.seed ^ n.wrapping_mul(0x1000_0000_01B3))),
        }
    }

    /// Sets the clock of this device (it must change nothing, С10).
    pub fn set_clock(&self, ms: i64) {
        self.clock.set(ms);
    }

    /// One pass with the defaults, using whatever plan of faults is set.
    pub fn sync(&self) -> Result<CycleReport, EngineError> {
        self.sync_with(&CycleRequest::default())
    }

    /// One pass with the answers of the user.
    pub fn sync_with(&self, request: &CycleRequest) -> Result<CycleReport, EngineError> {
        self.faults.begin_pass();
        self.passes.set(self.passes.get() + 1);
        let mut config = EngineConfig::new(self.space_id, self.vk.clone());
        if let Some(tweak) = self.config_tweak.borrow().as_ref() {
            tweak(&mut config);
        }
        let mut engine = (self.builder)(self.ports(), config);
        let result = engine.sync_cycle(request);
        // The plan of faults is for one pass.
        self.faults.clear();
        result
    }

    /// The user resolved a conflict in the list (Д47).
    pub fn resolve_conflict(&self, id: &str) -> Result<(), EngineError> {
        self.faults.begin_pass();
        let config = EngineConfig::new(self.space_id, self.vk.clone());
        let mut engine = (self.builder)(self.ports(), config);
        let result = engine.resolve_conflict(id);
        self.faults.clear();
        result
    }

    /// A pass that must end in `Done` (no stop, no error); returns the report.
    pub fn sync_ok(&self) -> CycleReport {
        match self.sync() {
            Ok(report) if report.outcome == amby_sync_core::engine::CycleOutcome::Done => report,
            Ok(report) => panic!(
                "{}: the pass did not finish: {:?}",
                self.name, report.outcome
            ),
            Err(error) => panic!("{}: the pass failed: {error}", self.name),
        }
    }

    /// The engine asks the user nothing: every approval granted.
    pub fn sync_approved(&self) -> Result<CycleReport, EngineError> {
        self.sync_with(&CycleRequest {
            approvals: amby_sync_core::engine::Approvals {
                mass_change: true,
                accept_empty_vault: true,
                resync: true,
            },
            ..Default::default()
        })
    }
}

/// What a world needs to know to start.
pub struct WorldOptions {
    pub devices: usize,
    /// Its own server (needed to restart, reset or move the clock of the server).
    pub isolated: bool,
    /// The file systems of the devices; linux-like when absent.
    pub fs: Vec<Vfs>,
    pub seed: u64,
    /// Settings of an isolated server (limits for tests that need a small one).
    pub max_commit_items: Option<usize>,
    pub max_blob_bytes: Option<u64>,
}

impl WorldOptions {
    pub fn new(devices: usize) -> Self {
        Self {
            devices,
            isolated: false,
            fs: Vec::new(),
            seed: 1,
            max_commit_items: None,
            max_blob_bytes: None,
        }
    }

    pub fn isolated(mut self) -> Self {
        self.isolated = true;
        self
    }

    pub fn with_fs(mut self, fs: Vec<Vfs>) -> Self {
        self.fs = fs;
        self
    }

    /// A server of its own that accepts at most `n` items in a commit.
    pub fn max_commit_items(mut self, n: usize) -> Self {
        self.isolated = true;
        self.max_commit_items = Some(n);
        self
    }

    /// A server of its own that accepts bodies of at most `n` bytes after encryption.
    pub fn max_blob_bytes(mut self, n: u64) -> Self {
        self.isolated = true;
        self.max_blob_bytes = Some(n);
        self
    }

    pub fn seed(mut self, seed: u64) -> Self {
        self.seed = seed;
        self
    }
}

struct Shared {
    target: Target,
    accounts: Vec<Account>,
}

const SHARED_DEVICES: usize = 4;

fn shared() -> &'static Shared {
    static SHARED: OnceLock<Shared> = OnceLock::new();
    SHARED.get_or_init(|| {
        let target = Target::in_process();
        let first = enroll(&target, PASSWORD);
        let mut accounts = vec![];
        for i in 1..SHARED_DEVICES {
            accounts.push(first.another_device(&format!("device {i}")));
        }
        accounts.insert(0, first);
        Shared { target, accounts }
    })
}

fn copy_account(a: &Account) -> Account {
    Account {
        api: a.api.clone(),
        username: a.username.clone(),
        password: a.password.clone(),
        ak: a.ak.clone(),
        recovery_code: a.recovery_code.clone(),
        recovery_auth_key: a.recovery_auth_key.clone(),
        salt: a.salt,
        params: a.params,
        token: a.token.clone(),
        device_id: a.device_id.clone(),
    }
}

/// A decrypted version of an item on the server.
#[derive(Clone, Debug)]
pub struct ServerVersion {
    pub version: u64,
    pub header: Header,
    pub content: Option<Vec<u8>>,
}

/// An item as the server keeps it, newest version first.
#[derive(Clone, Debug)]
pub struct ServerItem {
    pub item_id: ItemId,
    pub versions: Vec<ServerVersion>,
}

pub struct World {
    own: Option<Target>,
    pub accounts: Vec<Account>,
    pub space_id: SpaceId,
    pub vk: SpaceKey,
    pub devices: Vec<Device>,
    pub known: Rc<RefCell<BTreeSet<Hash>>>,
    pub builder: EngineBuilder,
    pub trace: RefCell<Vec<String>>,
    /// Backups of the server taken by tests, kept alive.
    backups: Vec<tempfile::TempDir>,
    /// Every line any version on the server ever had, kept after the server forgets it (reset,
    /// restore): a merge may drop a base line the other side removed, and the check must still
    /// know that line was a version of the server.
    seen_lines: RefCell<BTreeSet<Vec<u8>>>,
}

impl World {
    pub fn new(builder: EngineBuilder, options: WorldOptions) -> Self {
        assert!(options.devices >= 1 && options.devices <= SHARED_DEVICES);
        let (own, accounts, space) = if options.isolated {
            let (max_items, max_blob) = (options.max_commit_items, options.max_blob_bytes);
            let target = Target::in_process_with(move |config| {
                if let Some(n) = max_items {
                    config.max_commit_items = n;
                }
                if let Some(n) = max_blob {
                    config.max_blob_bytes = n;
                }
            });
            let first = enroll(&target, PASSWORD);
            let mut accounts = vec![copy_account(&first)];
            for i in 1..options.devices {
                accounts.push(first.another_device(&format!("device {i}")));
            }
            let space = first.create_space();
            (Some(target), accounts, space)
        } else {
            let shared = shared();
            let accounts: Vec<Account> = shared.accounts[..options.devices]
                .iter()
                .map(copy_account)
                .collect();
            let space = accounts[0].create_space();
            (None, accounts, space)
        };
        let known = Rc::new(RefCell::new(BTreeSet::new()));
        let devices = (0..options.devices)
            .map(|i| {
                let fs = options.fs.get(i).cloned().unwrap_or_else(Vfs::linux);
                fs.set_known(known.clone());
                Device {
                    name: format!("device {i}"),
                    fs,
                    state: MemState::new(),
                    faults: Faults::new(),
                    lies: Rc::new(RefCell::new(Lies::default())),
                    space: Rc::new(RefCell::new(space.with_token(&accounts[i].token))),
                    passes: Cell::new(0),
                    seed: options.seed.wrapping_mul(31).wrapping_add(i as u64),
                    clock: Rc::new(Cell::new(1_792_497_600_000)),
                    builder,
                    space_id: space.id,
                    vk: space.vk.clone(),
                    known: known.clone(),
                    config_tweak: RefCell::new(None),
                    checked_events: Cell::new(0),
                }
            })
            .collect();
        Self {
            own,
            accounts,
            space_id: space.id,
            vk: space.vk.clone(),
            devices,
            known,
            builder,
            trace: RefCell::new(Vec::new()),
            backups: Vec::new(),
            seen_lines: RefCell::new(BTreeSet::new()),
        }
    }

    pub fn target(&self) -> &Target {
        match &self.own {
            Some(target) => target,
            None => &shared().target,
        }
    }

    /// The server in this process: clock, cleanup, restart (isolated worlds only).
    pub fn control(&self) -> &InProcess {
        assert!(self.own.is_some(), "this test needs an isolated server");
        self.target().control().expect("an in-process server")
    }

    pub fn dev(&self, i: usize) -> &Device {
        &self.devices[i]
    }

    /// The space as the first device sees it (direct access for tests that act as "someone else").
    pub fn space(&self, device: usize) -> Space {
        self.devices[device].space.borrow().clone()
    }

    // ----- driving -----

    /// Passes of all devices in turn until a whole round changes nothing. A stop or a failed
    /// pass is returned as an error text.
    pub fn settle(&self) -> Result<usize, String> {
        for round in 1..=16 {
            let head_before = self.server_head();
            let mut busy = false;
            for device in &self.devices {
                match device.sync() {
                    Ok(report) => {
                        if report.outcome != amby_sync_core::engine::CycleOutcome::Done {
                            return Err(format!(
                                "{}: the pass ended with {:?}",
                                device.name, report.outcome
                            ));
                        }
                        if !report.errors.is_empty() {
                            return Err(format!(
                                "{}: item errors {:?}",
                                device.name, report.errors
                            ));
                        }
                        if report.downloaded + report.uploaded + report.renamed + report.trashed > 0
                            || !report.conflicts.is_empty()
                        {
                            busy = true;
                        }
                    }
                    Err(error) => return Err(format!("{}: the pass failed: {error}", device.name)),
                }
            }
            // Quiet means: nobody wrote to the disk and nobody committed (a repeated commit of an
            // earlier pass changes the server although no counter of the report moves).
            if self.server_head() != head_before {
                busy = true;
            }
            if !busy {
                return Ok(round);
            }
        }
        Err("the devices did not settle in 16 rounds".into())
    }

    /// `settle`, failing the test with the reason.
    pub fn settle_ok(&self) -> usize {
        self.settle().unwrap_or_else(|e| panic!("{e}"))
    }

    pub fn log(&self, line: impl Into<String>) {
        self.trace.borrow_mut().push(line.into());
    }

    // ----- the server's side, decrypted with the key of the space -----

    pub fn server_head(&self) -> u64 {
        self.space(0).changes(0, Some(1)).expect(200).json()["seq"]
            .as_u64()
            .expect("no seq")
    }

    pub fn server_items(&self, with_content: bool) -> Vec<ServerItem> {
        let space = self.space(0);
        let mut items = Vec::new();
        for entry in space.all_changes(0) {
            let item_id = ItemId::from_bytes(
                hex::decode(entry["item_id"].as_str().expect("no item_id"))
                    .expect("hex")
                    .try_into()
                    .expect("16 bytes"),
            );
            let versions = space.versions(&item_id).expect(200).json();
            let mut out = Vec::new();
            for v in versions["versions"].as_array().expect("no versions") {
                let header = space.open_change(v);
                let content = if with_content && header.body_id.is_some() && !header.deleted {
                    Some(space.fetch_file(v))
                } else {
                    None
                };
                out.push(ServerVersion {
                    version: v["version"].as_u64().expect("no version"),
                    header,
                    content,
                });
            }
            items.push(ServerItem {
                item_id,
                versions: out,
            });
        }
        items
    }

    /// Latest live files on the server: path → content.
    pub fn server_files(&self) -> BTreeMap<String, Vec<u8>> {
        let mut files = BTreeMap::new();
        for item in self.server_items(true) {
            let latest = &item.versions[0];
            if !latest.header.deleted && latest.header.body_id.is_some() {
                files.insert(
                    latest.header.path.clone(),
                    latest.content.clone().expect("content"),
                );
            }
        }
        files
    }

    /// Latest live folders on the server.
    pub fn server_folders(&self) -> BTreeSet<String> {
        self.server_items(false)
            .into_iter()
            .filter_map(|i| {
                let h = &i.versions[0].header;
                (!h.deleted && h.kind == amby_sync_core::crypto::header::ItemKind::Folder)
                    .then(|| h.path.clone())
            })
            .collect()
    }

    /// Hashes of the content of every version the server still keeps.
    /// Every line of every version of every item on the server (К1: the lines a merge may drop
    /// because the other side removed them from the base).
    pub fn server_lines(&self) -> BTreeSet<Vec<u8>> {
        let mut lines = self.seen_lines.borrow().clone();
        for item in self.server_items(true) {
            for version in item.versions {
                if let Some(bytes) = version.content {
                    for line in bytes.split_inclusive(|b| *b == b'\n') {
                        lines.insert(line.to_vec());
                    }
                }
            }
        }
        *self.seen_lines.borrow_mut() = lines.clone();
        lines
    }

    pub fn server_hashes(&self) -> BTreeSet<Hash> {
        self.server_items(false)
            .into_iter()
            .flat_map(|i| i.versions)
            .filter_map(|v| v.header.content_hash)
            .collect()
    }

    /// A commit made by "someone else": creates or changes an item directly, without an engine.
    /// Registers the content as known to the server.
    pub fn inject_file(&self, item: &ItemId, base_version: u64, path: &str, content: &[u8]) -> u64 {
        let space = self.space(0);
        let prepared = space.file(item, base_version, path, content);
        self.known.borrow_mut().insert(hash_of(content));
        space.commit_ok(&[prepared])
    }

    /// Someone else deletes an item.
    pub fn inject_delete(&self, item: &ItemId, base_version: u64, path: &str) -> u64 {
        let space = self.space(0);
        space.commit_ok(&[space.deletion(item, base_version, path)])
    }

    /// Someone else renames an item, reusing its body.
    pub fn inject_rename(
        &self,
        item: &ItemId,
        base_version: u64,
        new_path: &str,
        content: &[u8],
        body: &amby_sync_core::crypto::keys::BodyId,
    ) -> u64 {
        let space = self.space(0);
        space.commit_ok(&[space.file_with_uploaded_body(
            item,
            base_version,
            new_path,
            content,
            body,
        )])
    }

    // ----- the server itself -----

    /// A backup of the server now (isolated worlds only); returns its directory.
    pub fn backup_server(&mut self) -> std::path::PathBuf {
        let tmp = tempfile::tempdir().expect("temp dir");
        let dir = tmp.path().join("backup");
        self.control().backup(&dir);
        self.backups.push(tmp);
        dir
    }

    /// Replaces the server by one started on a backup: the same `instance_id`, the head of the
    /// moment of the copy (С7). The devices' tokens stay valid.
    pub fn restore_server(&mut self, backup: &std::path::Path) {
        self.server_lines();
        let process = InProcess::start_in(
            backup.to_path_buf(),
            None,
            Arc::new(amby_sync_server::ManualClock::new(
                amby_sync_conformance::inprocess::START_MS,
            )),
            |config| {
                config.max_json_bytes = amby_sync_conformance::target::TEST_MAX_JSON_BYTES;
            },
        );
        let target = Target::from_process(process);
        self.rebind(&target.api);
        self.own = Some(target);
    }

    fn rebind(&mut self, api: &Api) {
        for account in &mut self.accounts {
            account.api = api.clone();
        }
        for device in &self.devices {
            device.space.borrow_mut().api = api.clone();
        }
    }

    /// Empties the data directory of the server and gives the user, the space and the devices
    /// back on it (the model of С7 in appendix В, open question 11): the same keys, the same
    /// `space_id`, new tokens, a new `instance_id`, no data.
    pub fn reset_server(&mut self) {
        self.server_lines();
        self.control().restart_fresh();
        let username = self.accounts[0].username.clone();
        let ticket = self
            .target()
            .try_user_add(&username)
            .unwrap_or_else(|e| panic!("user add after the reset failed: {}", e.message));
        let first = &self.accounts[0];
        let params = Argon2Params::V1_DEFAULT;
        let password = seal_account_key_for_password(PASSWORD, &first.ak, &params, &mut OsRandom)
            .expect("password envelope");
        let recovery = derive_recovery_keys(&first.recovery_code);
        let new = NewAccount {
            password,
            account_key: first.ak.clone(),
            recovery_code: first.recovery_code.clone(),
            recovery_auth_key: recovery.auth_key.clone(),
            wrapped_account_key_recovery: wrap_account_key(&recovery.kek, &first.ak, &mut OsRandom),
        };
        let api = self.target().api.clone();
        let response = api
            .post(
                "/v1/auth/enroll",
                None,
                enroll_body(&username, &ticket.enroll_code, &new, "first device"),
            )
            .expect(201)
            .json();
        let mut tokens = vec![response["token"].as_str().expect("token").to_string()];
        for i in 1..self.accounts.len() {
            let signed = login(&api, &username, PASSWORD, &first.ak, &format!("device {i}"))
                .expect(200)
                .json();
            tokens.push(signed["token"].as_str().expect("token").to_string());
        }
        // The space again, with the same id and the same key.
        let wrapped = wrap_space_key(&first.ak, &self.space_id, &self.vk, &mut OsRandom);
        api.post(
            "/v1/spaces",
            Some(&tokens[0]),
            json!({
                "space_id": hex16(self.space_id.as_bytes()),
                "name_enc": amby_sync_conformance::client::seal_space_name(
                    &first.ak, self.space_id.as_bytes(), "My vault"),
                "key_epoch": 1,
                "wrapped_vk": hex::encode(wrapped),
            }),
        )
        .expect(201);
        for (i, token) in tokens.iter().enumerate() {
            self.accounts[i].token = token.clone();
            self.devices[i].space.borrow_mut().token = token.clone();
        }
    }
}

use std::sync::Arc;

/// A fresh random identifier (not drawn from the engine's stream).
pub fn fresh_id() -> [u8; 16] {
    amby_sync_conformance::client::random16()
}
