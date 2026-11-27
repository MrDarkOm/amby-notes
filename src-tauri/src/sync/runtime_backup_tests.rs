//! Pre-sync copy is a prerequisite of the first outgoing or incoming pass.

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

#[cfg(unix)]
#[test]
fn a_failed_backup_prevents_a_new_server_space_and_every_pass() {
    use std::sync::atomic::Ordering;

    // Handoff, steps 5-6: the copy must finish before sync is enabled.
    let env = Env::new();
    let vault = TempVault::new("backup-blocked");
    vault.put("Note.md", b"the only local version\r\n");
    std::os::unix::fs::symlink("/etc/hosts", vault.root.join("linked.bin")).unwrap();
    let hooks = Arc::new(Recorder::default());
    let runtime = runtime(&env, hooks.clone());
    let before = env.account.get("/v1/spaces").json();
    let result = env
        .runtime
        .block_on(runtime.enable(&vault.root, SpaceTarget::New { name: "New".into() }));
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
fn switching_on_with_a_missing_previous_copy_makes_a_new_one() {
    let env = Env::new();
    let vault = TempVault::new("backup-lost");
    vault.put("Note.md", b"keep me");
    let old = std::path::PathBuf::from(backup::ensure(&vault.root).unwrap());
    std::fs::remove_dir_all(&old).unwrap();
    let runtime = runtime(&env, Arc::new(Recorder::default()));
    let status = env
        .runtime
        .block_on(runtime.enable(
            &vault.root,
            SpaceTarget::Existing {
                space_id: hex::encode(env.space_id),
            },
        ))
        .expect("a lost copy is not a dead end");
    runtime.deactivate_vault();
    assert!(status.enabled);
    let fresh = backup::read_path(&vault.root).expect("a fresh copy");
    assert_ne!(std::path::PathBuf::from(&fresh), old);
    assert_eq!(
        std::fs::read(std::path::Path::new(&fresh).join("vault/Note.md")).unwrap(),
        b"keep me"
    );
}

#[test]
fn the_first_completed_pass_starts_the_retention_period() {
    let env = Env::new();
    let vault = TempVault::new("backup-first-pass");
    vault.put("Note.md", b"hello");
    let runtime = runtime(&env, Arc::new(Recorder::default()));
    env.runtime
        .block_on(runtime.enable(
            &vault.root,
            SpaceTarget::Existing {
                space_id: hex::encode(env.space_id),
            },
        ))
        .unwrap();
    let receipt = backup::key_dir(&vault.root.canonicalize().unwrap(), false)
        .unwrap()
        .join("receipt.json");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let recorded = std::fs::read(&receipt)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|json| json["first_sync_ms"].is_u64());
        if recorded {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the first pass was not recorded"
        );
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    runtime.deactivate_vault();
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
