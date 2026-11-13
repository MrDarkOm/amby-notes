//! The password for deleting a space from the server, at the runtime boundary
//! (docs/sync-plan.md, appendix Ц, Ц2, Ц4, with Л6–Л8).
//!
//! Written before the code: with the stubs the proof is not derived or sent, so a wrong
//! password is not refused and the right one is not what the server checks.

use std::sync::Arc;

use amby_sync_conformance::client::Account;

use super::connection::{ConnectionRecord, ConnectionStore};
use super::runtime::SyncRuntime;
use super::secrets::{SecretStore, SECRET_ACCOUNT_KEY, SECRET_DEVICE_TOKEN};
use super::session::Schedule;
use super::state_db::{SqliteStateStore, META_ENABLED, META_SPACE_ID};
use super::test_support::{Env, MemoryConnection, MemorySecrets, Recorder, TempVault};
use super::vault_types::{SpaceTarget, SyncPhase};

/// The password of every account of `Env` (`test_support`).
const ACCOUNT_PASSWORD: &str = "a long enough password for tests";

struct Computer {
    runtime: SyncRuntime,
}

impl Drop for Computer {
    fn drop(&mut self) {
        self.runtime.deactivate_vault();
    }
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
    Computer {
        runtime: SyncRuntime::new(
            secrets,
            connection,
            env.runtime.handle().clone(),
            Schedule::fast(),
            Arc::new(Recorder::default()),
        ),
    }
}

fn enable_new(env: &Env, computer: &Computer, vault: &TempVault, name: &str) -> String {
    env.runtime
        .block_on(computer.runtime.enable(
            &vault.root,
            SpaceTarget::New {
                name: name.to_string(),
            },
            true,
        ))
        .unwrap()
        .space_id
        .expect("a new space has an id")
}

fn server_has_space(env: &Env, space_id: &str) -> bool {
    env.account.get("/v1/spaces").expect(200).json()["spaces"]
        .as_array()
        .unwrap()
        .iter()
        .any(|space| space["space_id"].as_str() == Some(space_id))
}

fn meta(vault: &TempVault, key: &str) -> Option<String> {
    SqliteStateStore::open(&vault.root)
        .unwrap()
        .meta(key)
        .unwrap()
}

#[test]
fn a_wrong_password_is_refused_and_the_sync_of_the_open_vault_stays_on() {
    // Ц4, Л6: a typo in the password is `invalid_proof`; nothing is deleted on the server, and
    // the stop made before the request is undone: the vault stays enabled and linked.
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("Wrong password"));
    let vault = TempVault::new("delete-proof-wrong");
    let space_id = enable_new(&env, &pc, &vault, "Keep me");

    let error = env
        .runtime
        .block_on(
            pc.runtime
                .delete_space(&space_id, "not the password at all 123"),
        )
        .expect_err("a wrong password must refuse the deletion");
    assert_eq!(error.code, "invalid_proof", "{error:?}");
    assert!(
        !format!("{error:?}").contains("not the password at all 123"),
        "the password must not be in the error"
    );

    assert!(server_has_space(&env, &space_id), "the server copy is gone");
    let status = pc.runtime.status();
    assert!(status.enabled, "sync was switched off: {status:?}");
    assert!(status.linked, "the link was dropped: {status:?}");
    assert_eq!(status.space_id.as_deref(), Some(space_id.as_str()));
    assert_ne!(status.phase, SyncPhase::Off, "the session stays stopped");
    assert_eq!(meta(&vault, META_ENABLED).as_deref(), Some("1"));
    assert_eq!(
        meta(&vault, META_SPACE_ID).as_deref(),
        Some(space_id.as_str())
    );
}

#[test]
fn after_a_refusal_the_right_password_still_deletes() {
    // Ц4: the window stays open, so the person retries with the right password and it works;
    // local files stay (Л7).
    let env = Env::new();
    let pc = computer(&env, &env.another_computer("Retry"));
    let vault = TempVault::new("delete-proof-retry");
    vault.put("Notes/keep.md", b"\xEF\xBB\xBFkeep\r\n");
    let space_id = enable_new(&env, &pc, &vault, "Retry me");

    let error = env
        .runtime
        .block_on(pc.runtime.delete_space(&space_id, "a typo in the password"))
        .expect_err("a wrong password must refuse the deletion");
    assert_eq!(error.code, "invalid_proof", "{error:?}");
    assert!(server_has_space(&env, &space_id));

    env.runtime
        .block_on(pc.runtime.delete_space(&space_id, ACCOUNT_PASSWORD))
        .expect("the right password deletes");

    assert!(!server_has_space(&env, &space_id));
    let status = pc.runtime.status();
    assert!(!status.enabled && !status.linked, "{status:?}");
    assert_eq!(status.space_id, None);
    assert_eq!(meta(&vault, META_SPACE_ID), None);
    assert_eq!(meta(&vault, META_ENABLED).as_deref(), Some("0"));
    assert_eq!(
        vault.bytes("Notes/keep.md").as_deref(),
        Some(b"\xEF\xBB\xBFkeep\r\n".as_slice()),
        "local files must stay"
    );
}
