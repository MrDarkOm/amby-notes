//! Pre-sync copy is a prerequisite of the first outgoing or incoming pass.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use super::backup;
use super::connection::{ConnectionRecord, ConnectionStore};
use super::runtime::SyncRuntime;
use super::secrets::{SecretStore, SECRET_ACCOUNT_KEY, SECRET_DEVICE_TOKEN};
use super::session::Schedule;
use super::test_support::{Env, MemoryConnection, MemorySecrets, Recorder, TempVault};
use super::vault_types::SpaceTarget;

fn runtime(env: &Env, hooks: Arc<Recorder>) -> SyncRuntime {
    let secrets = Arc::new(MemorySecrets::default());
    secrets
        .set(SECRET_ACCOUNT_KEY, &hex::encode(env.account.ak.as_bytes()))
        .unwrap();
    secrets
        .set(SECRET_DEVICE_TOKEN, &env.account.token)
        .unwrap();
    let connection = Arc::new(MemoryConnection::default());
    connection
        .save(&ConnectionRecord {
            server_url: env.target.api.base().into(),
            allow_http: true,
            username: env.account.username.clone(),
            device_id: env.account.device_id.clone(),
        })
        .unwrap();
    SyncRuntime::new(
        secrets,
        connection,
        env.runtime.handle().clone(),
        Schedule::fast(),
        hooks,
    )
}

#[test]
fn a_failed_backup_prevents_a_new_server_space_and_every_pass() {
    // Handoff, steps 5–6: the copy must finish before sync is enabled.
    let env = Env::new();
    let vault = TempVault::new("backup-blocked");
    vault.put("Note.md", b"the only local version\r\n");
    let name = vault.root.file_name().unwrap().to_str().unwrap();
    let blocked = vault.root.with_file_name(format!("{name}.amby-backups"));
    std::fs::write(&blocked, b"an existing user file").unwrap();
    let hooks = Arc::new(Recorder::default());
    let runtime = runtime(&env, hooks.clone());
    let before = env.account.get("/v1/spaces").json();
    let result = env.runtime.block_on(runtime.enable(
        &vault.root,
        SpaceTarget::New { name: "New".into() },
        true,
    ));
    // Clean up the deliberately blocked sibling even against the old implementation.
    std::fs::remove_file(&blocked).unwrap();
    assert!(result.is_err(), "sync started without a complete backup");
    assert_eq!(env.account.get("/v1/spaces").json(), before);
    assert_eq!(hooks.begins.load(Ordering::SeqCst), 0);
    assert_eq!(
        vault.bytes("Note.md").unwrap(),
        b"the only local version\r\n"
    );
    assert!(backup::read_path(&vault.root).is_none());
}

#[test]
fn switching_on_keeps_the_pre_sync_bytes_outside_the_vault() {
    let env = Env::new();
    let vault = TempVault::new("backup-before-pass");
    vault.put("Note.md", b"\xef\xbb\xbf# My original\r\n");
    vault.put("assets/picture.bin", &[0, 255, 1, 2]);
    let runtime = runtime(&env, Arc::new(Recorder::default()));
    let status = env
        .runtime
        .block_on(runtime.enable(
            &vault.root,
            SpaceTarget::Existing {
                space_id: hex::encode(env.space_id),
            },
            true,
        ))
        .unwrap();
    runtime.deactivate_vault();
    assert!(status.enabled);
    let path = std::path::PathBuf::from(backup::read_path(&vault.root).unwrap());
    assert!(!path.starts_with(&vault.root));
    assert_eq!(
        std::fs::read(path.join("vault/Note.md")).unwrap(),
        b"\xef\xbb\xbf# My original\r\n"
    );
    assert_eq!(
        std::fs::read(path.join("vault/assets/picture.bin")).unwrap(),
        [0, 255, 1, 2]
    );
}
