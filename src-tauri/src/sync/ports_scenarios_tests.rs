//! The scenarios of the simulation (`sync/sim`: one row of table Р7, one rule of Р8 per test)
//! run again through the **real** ports of the application: the vault on disk, the SQLite state,
//! the HTTP client and the server in the process. The simulation proves the engine; these show
//! that the ports let it keep its promises on a real disk (stage Э4).

use amby_sync_conformance::client::Account;
use amby_sync_core::crypto::keys::SpaceId;
use amby_sync_core::crypto::random::OsRandom;
use amby_sync_core::engine::{
    Approvals, CycleOutcome, CycleReport, CycleRequest, Engine, EngineConfig, Ports, StopReason,
    SyncEngine,
};

use super::clock::SystemClock;
use super::remote::HttpRemote;
use super::state_db::SqliteStateStore;
use super::test_support::{Env, TempVault};
use super::vault_fs::VaultFs;

struct Computer {
    vault: TempVault,
    account: Account,
}

impl Computer {
    fn new(env: &Env, first: bool) -> Self {
        Self {
            vault: TempVault::new("ports"),
            account: if first {
                env.account.another_device("first")
            } else {
                env.account.another_device("second")
            },
        }
    }

    fn pass_with(&self, env: &Env, request: &CycleRequest) -> CycleReport {
        let ports = Ports {
            fs: Box::new(VaultFs::new(self.vault.root.clone())),
            remote: Box::new(HttpRemote::new(
                env.runtime.handle().clone(),
                env.client(),
                amby_sync_client::DeviceToken::new(self.account.token.clone()),
                env.space_id,
            )),
            state: Box::new(SqliteStateStore::open(&self.vault.root).unwrap()),
            clock: Box::new(SystemClock),
            rng: Box::new(OsRandom),
        };
        let config = EngineConfig::new(SpaceId::from_bytes(env.space_id), env.vk.clone());
        Engine::new(ports, config)
            .sync_cycle(request)
            .expect("the pass must not fail")
    }

    fn pass(&self, env: &Env) -> CycleReport {
        let report = self.pass_with(env, &CycleRequest::default());
        assert_eq!(report.outcome, CycleOutcome::Done, "{:?}", report.outcome);
        report
    }

    fn conflicts(&self) -> Vec<String> {
        let mut state = SqliteStateStore::open(&self.vault.root).unwrap();
        use amby_sync_core::engine::StateStore;
        state
            .load()
            .unwrap()
            .conflicts
            .into_iter()
            .map(|c| c.copy_path)
            .collect()
    }
}

fn pair(env: &Env) -> (Computer, Computer) {
    let (a, b) = (Computer::new(env, true), Computer::new(env, false));
    a.vault.put("Keep/k.md", b"keep");
    a.vault.put("Notes/a.md", b"base");
    a.pass(env);
    b.pass(env);
    assert_eq!(b.vault.text("Notes/a.md").as_deref(), Some("base"));
    (a, b)
}

#[test]
fn p7_both_edited_the_first_to_the_server_keeps_the_name() {
    // Р7 row 1
    let env = Env::new();
    let (a, b) = pair(&env);
    a.vault.put("Notes/a.md", b"from a");
    b.vault.put("Notes/a.md", b"from b");
    a.pass(&env);
    b.pass(&env);
    assert_eq!(b.vault.text("Notes/a.md").as_deref(), Some("from a"));
    let copies = b.conflicts();
    assert_eq!(copies.len(), 1);
    assert_eq!(b.vault.text(&copies[0]).as_deref(), Some("from b"));
    a.pass(&env);
    assert_eq!(
        a.vault.files(),
        b.vault.files(),
        "both versions are on both computers"
    );
}

#[test]
fn p7_a_rename_and_an_edit_merge() {
    // Р7 row 2: new name and new content
    let env = Env::new();
    let (a, b) = pair(&env);
    std::fs::rename(
        a.vault.root.join("Notes/a.md"),
        a.vault.root.join("Notes/renamed.md"),
    )
    .unwrap();
    b.vault.put("Notes/a.md", b"edited on b");
    a.pass(&env);
    b.pass(&env);
    a.pass(&env);
    assert_eq!(
        b.vault.text("Notes/renamed.md").as_deref(),
        Some("edited on b")
    );
    assert!(!b.vault.exists("Notes/a.md"));
    assert_eq!(a.vault.files(), b.vault.files());
    assert!(b.conflicts().is_empty());
}

#[test]
fn p7_both_renamed_differently_the_server_name_stays() {
    // Р7 row 3
    let env = Env::new();
    let (a, b) = pair(&env);
    std::fs::rename(
        a.vault.root.join("Notes/a.md"),
        a.vault.root.join("Notes/from-a.md"),
    )
    .unwrap();
    std::fs::rename(
        b.vault.root.join("Notes/a.md"),
        b.vault.root.join("Notes/from-b.md"),
    )
    .unwrap();
    a.pass(&env);
    b.pass(&env);
    a.pass(&env);
    assert!(a.vault.exists("Notes/from-a.md") && b.vault.exists("Notes/from-a.md"));
    assert!(!a.vault.exists("Notes/from-b.md") && !b.vault.exists("Notes/from-b.md"));
    assert_eq!(a.vault.files(), b.vault.files());
}

#[test]
fn p7_deleted_on_one_and_edited_on_the_other_the_edit_wins() {
    // Р7 row 4
    let env = Env::new();
    let (a, b) = pair(&env);
    a.vault.remove("Notes/a.md");
    b.vault.put("Notes/a.md", b"edited anyway");
    a.pass(&env);
    b.pass(&env);
    a.pass(&env);
    assert_eq!(a.vault.text("Notes/a.md").as_deref(), Some("edited anyway"));
    assert_eq!(b.vault.text("Notes/a.md").as_deref(), Some("edited anyway"));
}

#[test]
fn p7_both_created_one_path_the_second_becomes_a_copy() {
    // Р7 row 5
    let env = Env::new();
    let (a, b) = pair(&env);
    a.vault.put("New.md", b"made on a");
    b.vault.put("New.md", b"made on b");
    a.pass(&env);
    b.pass(&env);
    assert_eq!(b.vault.text("New.md").as_deref(), Some("made on a"));
    let copies = b.conflicts();
    assert_eq!(copies.len(), 1);
    assert_eq!(b.vault.text(&copies[0]).as_deref(), Some("made on b"));
    a.pass(&env);
    assert_eq!(a.vault.files(), b.vault.files());
}

#[test]
fn p8_a_replaced_file_is_in_the_history_and_a_deleted_one_in_the_trash() {
    // Р8, О4
    let env = Env::new();
    let (a, b) = pair(&env);
    b.vault.history_off();
    a.vault.put("Notes/a.md", b"new text");
    a.vault.remove("Keep/k.md");
    a.pass(&env);
    b.pass(&env);
    assert_eq!(
        b.vault.snapshots("Notes/a.md"),
        vec![("sync-overwrite".to_string(), "base".to_string())]
    );
    assert_eq!(b.vault.trashed(), vec!["Keep/k.md"]);
}

#[test]
fn p8_a_mass_change_stops_and_the_approval_lets_it_through() {
    // Р8, О6
    let env = Env::new();
    let (a, b) = pair(&env);
    for n in 0..30 {
        a.vault
            .put(&format!("Bulk/{n}.md"), format!("{n}").as_bytes());
    }
    a.pass(&env);
    b.pass(&env);
    for n in 0..25 {
        a.vault.remove(&format!("Bulk/{n}.md"));
    }
    let report = a.pass_with(&env, &CycleRequest::default());
    assert!(matches!(
        report.outcome,
        CycleOutcome::Stopped(StopReason::MassChange { .. })
    ));
    let approved = CycleRequest {
        approvals: Approvals {
            mass_change: true,
            ..Default::default()
        },
        ..Default::default()
    };
    assert_eq!(a.pass_with(&env, &approved).outcome, CycleOutcome::Done);
    let report = b.pass_with(&env, &CycleRequest::default());
    assert!(matches!(
        report.outcome,
        CycleOutcome::Stopped(StopReason::MassChange { .. })
    ));
    assert_eq!(b.pass_with(&env, &approved).outcome, CycleOutcome::Done);
    assert_eq!(b.vault.trashed().len(), 25);
}

#[test]
fn c3_a_leftover_temporary_file_is_cleaned_and_never_synchronised() {
    // С3, Р4
    let env = Env::new();
    let (a, b) = pair(&env);
    a.vault.put("Notes/.half.md.amby-tmp-1-1", b"half written");
    a.pass(&env);
    b.pass(&env);
    assert!(!a.vault.exists("Notes/.half.md.amby-tmp-1-1"));
    assert!(!b.vault.exists("Notes/.half.md.amby-tmp-1-1"));
}

#[test]
fn c4_a_file_the_system_refuses_does_not_stop_the_others() {
    // Э4 (from Э3): the real disk says "permission denied" for one file
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let env = Env::new();
        let (a, _b) = pair(&env);
        let locked = a.vault.put("Notes/locked.md", b"cannot be read");
        a.vault.put("Notes/fine.md", b"fine");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::File::open(&locked).is_ok() {
            return; // root: permissions do not apply
        }
        let report = a.pass_with(&env, &CycleRequest::default());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(report.outcome, CycleOutcome::Done);
        assert!(report.unsynced.iter().any(|u| u.path == "Notes/locked.md"
            && u.reason == amby_sync_core::engine::UnsyncedReason::NoAccess));
        a.pass(&env);
        let page = env
            .account
            .get(&format!(
                "/v1/spaces/{}/changes?since=0",
                hex::encode(env.space_id)
            ))
            .expect(200)
            .json();
        assert_eq!(
            page["changes"].as_array().unwrap().len(),
            4,
            "keep, a, fine, locked"
        );
    }
}
