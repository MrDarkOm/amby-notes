//! Switching sync on for the open vault, the session of the open vault and what the person sees
//! (docs/sync-plan.md, Р5, Р10, Р11, Ф34 and the gate of stage Э4), against the real server in
//! the process. The key store and the connection record are in memory.

use std::sync::Arc;
use std::time::Duration;

use amby_sync_conformance::client::Account;

use super::connection::{ConnectionRecord, ConnectionStore};
use super::runtime::SyncRuntime;
use super::secrets::{SecretStore, SECRET_ACCOUNT_KEY, SECRET_DEVICE_TOKEN};
use super::session::Schedule;
use super::state_db::{state_path, SqliteStateStore, META_ENABLED, META_SPACE_ID, META_TEST_VAULT};
use super::test_support::{Env, MemoryConnection, MemorySecrets, Recorder, TempVault};
use super::vault_types::{SpaceTarget, SyncPhase};
use crate::model::PathChange;

struct Computer {
    runtime: SyncRuntime,
    secrets: Arc<MemorySecrets>,
    connection: Arc<MemoryConnection>,
    recorder: Arc<Recorder>,
}

fn computer(env: &Env, account: &Account) -> Computer {
    let secrets = Arc::new(MemorySecrets::default());
    let connection = Arc::new(MemoryConnection::default());
    secrets
        .set(SECRET_ACCOUNT_KEY, &hex::encode(account.ak.as_bytes()))
        .unwrap();
    secrets.set(SECRET_DEVICE_TOKEN, &account.token).unwrap();
    connection
        .save(&ConnectionRecord {
            server_url: env.target.api.base().to_string(),
            allow_http: true,
            username: account.username.clone(),
            device_id: account.device_id.clone(),
        })
        .unwrap();
    let recorder = Arc::new(Recorder::default());
    let runtime = SyncRuntime::new(
        secrets.clone(),
        connection.clone(),
        env.runtime.handle().clone(),
        Schedule::fast(),
        recorder.clone(),
    );
    Computer {
        runtime,
        secrets,
        connection,
        recorder,
    }
}

fn run<T>(env: &Env, future: impl std::future::Future<Output = T>) -> T {
    env.runtime.block_on(future)
}

fn wait_until(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !check() {
        assert!(std::time::Instant::now() < deadline, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(30));
    }
}

fn server_spaces(env: &Env) -> Vec<serde_json::Value> {
    env.account.get("/v1/spaces").expect(200).json()["spaces"]
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn switching_on_makes_a_space_named_after_the_folder_and_starts_syncing() {
    // Р5, Р11, Ф34
    let env = Env::new();
    // `Env::new` already made one space for the session tests; this account starts clean below.
    let account = env.another_computer("This Mac");
    let pc = computer(&env, &account);
    let vault = TempVault::new("named");
    vault.put("Notes/a.md", b"hello");
    let before = server_spaces(&env).len();

    let status = run(
        &env,
        pc.runtime.enable(
            &vault.root,
            SpaceTarget::New {
                name: String::new(),
            },
            true,
        ),
    )
    .unwrap();
    assert!(status.enabled && status.linked && status.test_vault);
    let name = vault
        .root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert_eq!(status.space_name.as_deref(), Some(name.as_str()));
    assert_eq!(server_spaces(&env).len(), before + 1);

    let state = SqliteStateStore::open(&vault.root).unwrap();
    assert_eq!(state.meta(META_ENABLED).unwrap().as_deref(), Some("1"));
    assert_eq!(state.meta(META_TEST_VAULT).unwrap().as_deref(), Some("1"));
    assert_eq!(
        state.meta(META_SPACE_ID).unwrap().as_deref(),
        status.space_id.as_deref()
    );
    assert!(state_path(&vault.root).is_file());

    pc.runtime.sync_now().unwrap();
    wait_until("the file reaches the server", || {
        let id = status.space_id.clone().unwrap();
        env.account
            .get(&format!("/v1/spaces/{id}/changes?since=0"))
            .json()["changes"]
            .as_array()
            .is_some_and(|list| list.len() == 1)
    });
    pc.runtime.deactivate_vault();
}

#[test]
fn a_chosen_name_is_used_and_cleaned() {
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("This Mac"));
    let vault = TempVault::new("chosen");
    let status = run(
        &env,
        pc.runtime.enable(
            &vault.root,
            SpaceTarget::New {
                name: "  Работа\n".to_string(),
            },
            true,
        ),
    )
    .unwrap();
    assert_eq!(status.space_name.as_deref(), Some("Работа"));
    pc.runtime.deactivate_vault();
}

#[test]
fn a_closed_gate_refuses_a_vault_that_is_not_marked_and_changes_nothing() {
    // Gate of stage Э4: real notes only after the mutation run and the long simulation
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("This Mac"));
    let vault = TempVault::new("real");
    vault.put("Notes/important.md", b"real notes");
    let before = server_spaces(&env).len();
    let error = run(
        &env,
        pc.runtime.enable(
            &vault.root,
            SpaceTarget::New {
                name: String::new(),
            },
            false,
        ),
    )
    .unwrap_err();
    assert_eq!(error.code, "test_vault_required");
    assert_eq!(server_spaces(&env).len(), before, "no space was made");
    assert!(
        !state_path(&vault.root).exists(),
        "the vault was not touched"
    );
    assert!(pc.runtime.status().gate_closed);
    assert!(!pc.runtime.status().enabled);
}

#[test]
fn a_second_computer_connects_the_existing_space_and_receives_the_vault() {
    // Р5: "connect an existing one"
    let env = Env::new();
    let first = computer(&env, &env.account);
    let (a, b) = (TempVault::new("a"), TempVault::new("b"));
    a.put("Notes/shared.md", b"from the first computer");
    a.put("img/p.png", &[1, 2, 3, 4]);
    let made = run(
        &env,
        first.runtime.enable(
            &a.root,
            SpaceTarget::New {
                name: "Shared".to_string(),
            },
            true,
        ),
    )
    .unwrap();
    first.runtime.sync_now().unwrap();

    let second = computer(&env, &env.another_computer("Second"));
    let spaces = run(&env, second.runtime.list_spaces()).unwrap();
    let ours = spaces
        .iter()
        .find(|space| Some(&space.space_id) == made.space_id.as_ref())
        .expect("the space is offered");
    assert_eq!(ours.name.as_deref(), Some("Shared"));
    let status = run(
        &env,
        second.runtime.enable(
            &b.root,
            SpaceTarget::Existing {
                space_id: ours.space_id.clone(),
            },
            true,
        ),
    )
    .unwrap();
    assert_eq!(status.space_id, made.space_id);
    assert_eq!(status.space_name.as_deref(), Some("Shared"));
    wait_until("the vault arrives", || {
        b.text("Notes/shared.md").as_deref() == Some("from the first computer")
            && b.bytes("img/p.png") == Some(vec![1, 2, 3, 4])
    });
    first.runtime.deactivate_vault();
    second.runtime.deactivate_vault();
}

#[test]
fn a_space_that_does_not_exist_is_refused_and_nothing_is_written() {
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("This Mac"));
    let vault = TempVault::new("ghost");
    let error = run(
        &env,
        pc.runtime.enable(
            &vault.root,
            SpaceTarget::Existing {
                space_id: "00".repeat(16),
            },
            true,
        ),
    )
    .unwrap_err();
    assert_eq!(error.code, "space_not_found");
    assert!(!state_path(&vault.root).exists());
    let malformed = run(
        &env,
        pc.runtime.enable(
            &vault.root,
            SpaceTarget::Existing {
                space_id: "not hex".to_string(),
            },
            true,
        ),
    )
    .unwrap_err();
    assert_eq!(malformed.code, "invalid_space");
}

#[test]
fn without_a_signed_in_device_nothing_works_and_says_why() {
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("This Mac"));
    pc.secrets.delete(SECRET_DEVICE_TOKEN).unwrap();
    let vault = TempVault::new("signed-out");
    let error = run(
        &env,
        pc.runtime.enable(
            &vault.root,
            SpaceTarget::New {
                name: String::new(),
            },
            true,
        ),
    )
    .unwrap_err();
    assert_eq!(error.code, "not_connected");
    assert_eq!(
        run(&env, pc.runtime.list_spaces()).unwrap_err().code,
        "not_connected"
    );
    pc.connection.clear().unwrap();
    assert_eq!(
        run(&env, pc.runtime.list_spaces()).unwrap_err().code,
        "not_connected"
    );
}

#[test]
fn opening_a_switched_on_vault_resumes_it_and_opening_another_stops_the_first() {
    // Р10: the switch lives in the vault; one session at a time
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("This Mac"));
    let (one, two) = (TempVault::new("one"), TempVault::new("two"));
    one.put("n.md", b"n");
    run(
        &env,
        pc.runtime
            .enable(&one.root, SpaceTarget::New { name: "One".into() }, true),
    )
    .unwrap();
    pc.runtime.deactivate_vault();
    assert_eq!(pc.runtime.status().phase, SyncPhase::Off);

    // The application restarts: a new runtime finds the switch in the vault.
    let after_restart = computer(&env, &env.another_computer("This Mac again"));
    let status = run(&env, after_restart.runtime.activate_vault(&one.root)).unwrap();
    assert!(status.enabled && status.linked);
    assert_ne!(status.phase, SyncPhase::Off);
    assert_eq!(status.space_name.as_deref(), Some("One"));

    // Another vault, never synchronised: off, with the gate shown.
    let status = run(&env, after_restart.runtime.activate_vault(&two.root)).unwrap();
    assert!(!status.enabled && !status.linked);
    assert_eq!(status.phase, SyncPhase::Off);
    assert!(status.gate_closed);
    // The first session let go of its lock.
    let (session, _) = env.start(&one, &env.account);
    session.stop();
    after_restart.runtime.deactivate_vault();
    drop(pc);
}

#[test]
fn switching_off_keeps_the_link_and_switching_on_again_makes_no_new_space() {
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("This Mac"));
    let vault = TempVault::new("off-on");
    vault.put("n.md", b"n");
    let on = run(
        &env,
        pc.runtime.enable(
            &vault.root,
            SpaceTarget::New {
                name: "Mine".into(),
            },
            true,
        ),
    )
    .unwrap();
    let spaces = server_spaces(&env).len();
    let off = pc.runtime.disable().unwrap();
    assert!(!off.enabled && off.linked);
    assert_eq!(off.phase, SyncPhase::Off);
    assert_eq!(off.space_id, on.space_id);
    let state = SqliteStateStore::open(&vault.root).unwrap();
    assert_eq!(state.meta(META_ENABLED).unwrap().as_deref(), Some("0"));
    drop(state);

    // An application restart does not start a vault that was switched off.
    let again = computer(&env, &env.another_computer("This Mac again"));
    let status = run(&env, again.runtime.activate_vault(&vault.root)).unwrap();
    assert!(!status.enabled && status.linked);
    assert_eq!(status.phase, SyncPhase::Off);

    let on_again = run(
        &env,
        again.runtime.enable(
            &vault.root,
            SpaceTarget::New {
                name: "ignored".into(),
            },
            true,
        ),
    )
    .unwrap();
    assert_eq!(on_again.space_id, on.space_id, "the same space");
    assert_eq!(server_spaces(&env).len(), spaces, "no new space");
    again.runtime.deactivate_vault();
}

#[test]
fn a_signed_out_device_shows_that_the_vault_is_linked_but_cannot_run() {
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("This Mac"));
    let vault = TempVault::new("signed-out-later");
    run(
        &env,
        pc.runtime
            .enable(&vault.root, SpaceTarget::New { name: "X".into() }, true),
    )
    .unwrap();
    pc.runtime.deactivate_vault();
    pc.secrets.delete(SECRET_ACCOUNT_KEY).unwrap();
    let status = run(&env, pc.runtime.activate_vault(&vault.root)).unwrap();
    assert!(status.linked);
    assert_eq!(status.phase, SyncPhase::Off);
    assert_eq!(status.error_code.as_deref(), Some("not_connected"));
}

#[test]
fn answers_and_conflicts_need_a_running_session() {
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("This Mac"));
    use super::vault_types::{ApprovalKind, ConflictChoice};
    assert_eq!(
        pc.runtime
            .approve(ApprovalKind::MassChange)
            .unwrap_err()
            .code,
        "sync_not_running"
    );
    assert_eq!(
        pc.runtime
            .resolve_conflict("000000000000", ConflictChoice::KeepBoth)
            .unwrap_err()
            .code,
        "sync_not_running"
    );
    assert_eq!(pc.runtime.sync_now().unwrap_err().code, "sync_not_running");
    assert_eq!(pc.runtime.status().phase, SyncPhase::Off);
}

#[test]
fn the_renames_of_amby_reach_the_next_pass() {
    // Д70: runtime.hints() is the queue the commands of rename and move write to
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("This Mac"));
    let vault = TempVault::new("hints");
    vault.put("keep.md", b"keep");
    vault.put(
        "old.md",
        b"the old text of a note that is long enough to recognise",
    );
    let status = run(
        &env,
        pc.runtime
            .enable(&vault.root, SpaceTarget::New { name: "H".into() }, true),
    )
    .unwrap();
    pc.runtime.sync_now().unwrap();
    wait_until("first upload", || {
        pc.runtime.status().last.is_some_and(|l| l.uploaded == 2)
    });

    std::fs::rename(vault.root.join("old.md"), vault.root.join("new.md")).unwrap();
    vault.put("new.md", b"entirely different text after the rename");
    pc.runtime.hints().record(
        &vault.root,
        &[PathChange {
            old_path: vault.root.join("old.md").to_string_lossy().into_owned(),
            new_path: vault.root.join("new.md").to_string_lossy().into_owned(),
        }],
    );
    pc.runtime.sync_now().unwrap();
    let id = status.space_id.unwrap();
    wait_until("the rename reaches the server", || {
        let page = env
            .account
            .get(&format!("/v1/spaces/{id}/changes?since=0"))
            .json();
        let list = page["changes"].as_array().unwrap();
        list.len() == 2
            && list.iter().all(|c| c["deleted"] != true)
            && list.iter().any(|c| c["version"] == 2)
    });
    assert!(pc.runtime.hints().is_empty(), "the hints were used");
    pc.runtime.deactivate_vault();
}

#[test]
fn the_application_hears_about_every_change_of_the_status() {
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("This Mac"));
    let vault = TempVault::new("events");
    vault.put("a.md", b"a");
    run(
        &env,
        pc.runtime
            .enable(&vault.root, SpaceTarget::New { name: "E".into() }, true),
    )
    .unwrap();
    pc.runtime.sync_now().unwrap();
    wait_until("a pass ends", || {
        pc.recorder
            .statuses
            .lock()
            .unwrap()
            .iter()
            .any(|s| s.phase == SyncPhase::Idle && s.last.is_some())
    });
    let phases: Vec<SyncPhase> = pc
        .recorder
        .statuses
        .lock()
        .unwrap()
        .iter()
        .map(|s| s.phase)
        .collect();
    assert!(phases.contains(&SyncPhase::Running));
    assert!(phases.contains(&SyncPhase::Idle));
    pc.runtime.deactivate_vault();
}
