//! The server as the engine's port, against the real server in the process (docs/sync-plan.md,
//! appendix Б). What the server holds is made by the independent client of the conformance suite.

use std::io::Read;

use amby_sync_client::{ClientError, DeviceToken, ServerUrl, SyncClient};
use amby_sync_conformance::client::{
    enroll, new_body, new_item, pattern, unhex, Account, Prepared,
};
use amby_sync_conformance::Target;
use amby_sync_core::crypto::keys::BodyId;
use amby_sync_core::engine::{CommitItem, CommitReply, Remote, RemoteError};

use super::remote::{remote_error, HttpRemote};

struct Fixture {
    runtime: tokio::runtime::Runtime,
    target: Target,
    account: Account,
    space: amby_sync_conformance::client::Space,
}

impl Fixture {
    fn new() -> Self {
        let target = Target::from_env();
        let account = enroll(&target, "a long enough password for tests");
        let space = account.create_space();
        Self {
            runtime: tokio::runtime::Runtime::new().unwrap(),
            target,
            account,
            space,
        }
    }

    fn client(&self) -> SyncClient {
        SyncClient::new(&ServerUrl::parse(self.target.api.base(), true).unwrap()).unwrap()
    }

    fn remote_with(&self, token: &str, space: [u8; 16]) -> HttpRemote {
        HttpRemote::new(
            self.runtime.handle().clone(),
            self.client(),
            DeviceToken::new(token.to_string()),
            space,
        )
    }

    fn remote(&self) -> HttpRemote {
        self.remote_with(&self.account.token, *self.space.id.as_bytes())
    }
}

fn item(prepared: &Prepared) -> CommitItem {
    CommitItem {
        item_id: prepared.item,
        base_version: prepared.base_version,
        header: unhex(prepared.json["header"].as_str().unwrap()),
        blob_id: prepared.body,
        deleted: prepared.header.deleted,
    }
}

#[test]
fn info_gives_the_instance_and_the_limits() {
    // П9, П10, П8
    let fx = Fixture::new();
    let info = fx.remote().info().unwrap();
    assert_eq!((info.protocol_min, info.protocol_max), (1, 1));
    assert_eq!(
        hex::encode(info.instance_id),
        amby_sync_conformance::client::info(&fx.target.api)["instance_id"]
            .as_str()
            .unwrap()
    );
    assert!(info.max_blob_bytes >= 8 * 1024 * 1024);
    assert!(info.max_commit_items >= 1);
}

#[test]
fn the_feed_carries_the_headers_the_other_device_committed() {
    // П31
    let fx = Fixture::new();
    let a = new_item();
    let first = fx.space.folder(&a, 0, "Docs");
    let seq = fx.space.commit_ok(std::slice::from_ref(&first));
    let page = fx.remote().changes(0, None).unwrap();
    assert_eq!(page.seq, seq);
    assert_eq!(page.changes.len(), 1);
    assert_eq!(page.changes[0].item_id, a);
    assert_eq!(
        page.changes[0].header,
        unhex(first.json["header"].as_str().unwrap())
    );
    assert_eq!(
        page.changes[0].device_id.to_vec(),
        unhex(&fx.account.device_id)
    );
    let empty = fx.remote().changes(seq, Some(10)).unwrap();
    assert!(empty.changes.is_empty() && !empty.more);
}

#[test]
fn a_body_goes_up_in_parts_and_resumes() {
    // П21–П23, С1
    let fx = Fixture::new();
    let mut remote = fx.remote();
    let blob = new_body();
    let part = 8 * 1024 * 1024usize;
    let sealed = pattern(part + 4321);
    let started = remote.blob_start(&blob, sealed.len() as u64, None).unwrap();
    assert!(!started.complete && started.uploaded.is_empty());
    remote.blob_put_part(&blob, 0, &sealed[..part]).unwrap();
    let resumed = remote.blob_start(&blob, sealed.len() as u64, None).unwrap();
    assert_eq!(resumed.uploaded, vec![0]);
    remote.blob_put_part(&blob, 1, &sealed[part..]).unwrap();
    remote.blob_complete(&blob).unwrap();
    assert!(
        remote
            .blob_start(&blob, sealed.len() as u64, None)
            .unwrap()
            .complete
    );
    assert_eq!(fx.space.download(&blob).expect(200).body, sealed);
}

#[test]
fn a_body_is_read_as_a_stream_in_any_size_of_reads() {
    // П24, Ф24: the engine reads chunk by chunk
    let fx = Fixture::new();
    let blob = new_body();
    let sealed = pattern(3 * 1024 * 1024 + 17);
    fx.space.upload_sealed(&blob, &sealed);
    let mut remote = fx.remote();
    let mut stream = remote.blob_download(&blob).unwrap();
    let mut got = Vec::new();
    let mut buffer = vec![0u8; 7001];
    loop {
        let n = stream.read(&mut buffer).unwrap();
        if n == 0 {
            break;
        }
        got.extend_from_slice(&buffer[..n]);
    }
    assert_eq!(got, sealed);
}

#[test]
fn a_missing_body_is_refused_with_its_code() {
    // П24
    let fx = Fixture::new();
    let mut remote = fx.remote();
    let result = remote.blob_download(&BodyId::from_bytes([9; 16]));
    match result {
        Err(RemoteError::Rejected { status, code }) => {
            assert_eq!((status, code.as_str()), (404, "not_found"));
        }
        Err(other) => panic!("{other:?}"),
        Ok(_) => panic!("a missing body must be refused"),
    }
}

#[test]
fn a_commit_is_accepted_replayed_and_a_stale_base_is_a_conflict() {
    // П26–П28
    let fx = Fixture::new();
    let mut remote = fx.remote();
    let a = new_item();
    let prepared = fx.space.folder(&a, 0, "One");
    let commit_id = [4u8; 16];
    let CommitReply::Accepted(accepted) = remote.commit(&commit_id, &[item(&prepared)]).unwrap()
    else {
        panic!("not accepted")
    };
    assert_eq!((accepted.seq, accepted.replayed), (1, false));
    assert_eq!(accepted.versions, vec![(a, 1)]);
    let CommitReply::Accepted(replayed) = remote.commit(&commit_id, &[item(&prepared)]).unwrap()
    else {
        panic!("a replay is accepted")
    };
    assert!(replayed.replayed);
    let stale = fx.space.folder(&a, 0, "Other");
    match remote.commit(&[5u8; 16], &[item(&stale)]).unwrap() {
        CommitReply::Conflict(list) => {
            assert_eq!(list.len(), 1);
            assert_eq!((list[0].base_version, list[0].current_version), (0, 1));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_revoked_device_and_a_wrong_token_are_told_apart() {
    // П5, С12: Revoked stops the sync of this device, Unauthorized asks to sign in
    let fx = Fixture::new();
    let second = fx.account.another_device("Second");
    fx.account
        .delete(&format!("/v1/devices/{}", second.device_id))
        .expect(204);
    let space_id = *fx.space.id.as_bytes();
    let revoked = fx.remote_with(&second.token, space_id).changes(0, None);
    assert_eq!(revoked.unwrap_err(), RemoteError::Revoked);
    let wrong = fx.remote_with(&"0".repeat(64), space_id).changes(0, None);
    assert_eq!(wrong.unwrap_err(), RemoteError::Unauthorized);
}

#[test]
fn another_users_space_is_not_found() {
    // П6
    let fx = Fixture::new();
    let stranger = enroll(&fx.target, "another long enough password");
    let theirs = stranger.create_space();
    let error = fx
        .remote_with(&fx.account.token, *theirs.id.as_bytes())
        .changes(0, None)
        .unwrap_err();
    assert_eq!(
        error,
        RemoteError::Rejected {
            status: 404,
            code: "not_found".into()
        }
    );
}

#[test]
fn a_server_that_is_not_there_is_a_network_error() {
    // С1, Д19: unknown whether anything was applied; the next pass repeats
    let fx = Fixture::new();
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let client =
        SyncClient::new(&ServerUrl::parse(&format!("http://127.0.0.1:{port}"), true).unwrap())
            .unwrap();
    let mut remote = HttpRemote::new(
        fx.runtime.handle().clone(),
        client,
        DeviceToken::new("0".repeat(64)),
        [1; 16],
    );
    assert!(matches!(remote.info(), Err(RemoteError::Network(_))));
    assert!(matches!(
        remote.changes(0, None),
        Err(RemoteError::Network(_))
    ));
}

#[test]
fn failures_of_the_client_read_as_the_engine_needs() {
    // Д19, С12: one table
    assert!(matches!(
        remote_error(ClientError::Network),
        RemoteError::Network(_)
    ));
    assert!(matches!(
        remote_error(ClientError::Timeout),
        RemoteError::Network(_)
    ));
    assert!(matches!(
        remote_error(ClientError::BadResponse("x")),
        RemoteError::Network(_)
    ));
    let api = |status: u16, code: &str| ClientError::Api {
        status,
        code: code.to_string(),
        retry_after_secs: None,
    };
    assert_eq!(
        remote_error(api(401, "token_revoked")),
        RemoteError::Revoked
    );
    assert_eq!(
        remote_error(api(401, "unauthorized")),
        RemoteError::Unauthorized
    );
    assert_eq!(
        remote_error(api(503, "server_unavailable")),
        RemoteError::Rejected {
            status: 503,
            code: "server_unavailable".into()
        }
    );
    assert_eq!(
        remote_error(api(413, "blob_too_large")),
        RemoteError::Rejected {
            status: 413,
            code: "blob_too_large".into()
        }
    );
}

// ----- appendix Е: the port knows the account, the credit and the drop of a body -----

#[test]
fn the_account_gives_the_engine_the_limits_and_the_room() {
    // Д73, П61: the smaller file limit, the quota, and what is held.
    let target = Target::in_process_with_plans(
        r#"{"default_plan": "p", "plans": {"p": {"max_total_bytes": 10000, "max_file_bytes": 4000}}}"#,
        |_| {},
    );
    let account = enroll(&target, "a long enough password for tests");
    let space = account.create_space();
    space.commit_ok(&[space.raw_file(&new_item(), 0, "a.md", 1_500)]);
    space.init_blob(&new_body(), 300).expect(201);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let client = SyncClient::new(&ServerUrl::parse(target.api.base(), true).unwrap()).unwrap();
    let mut remote = HttpRemote::new(
        runtime.handle().clone(),
        client,
        DeviceToken::new(account.token.clone()),
        *space.id.as_bytes(),
    );
    let info = remote.account().unwrap();
    assert_eq!(info.max_file_bytes, Some(4_000));
    assert_eq!(info.max_total_bytes, Some(10_000));
    assert_eq!(info.live_bytes, 1_500);
    assert_eq!(info.pending_bytes, 300);
}

#[test]
fn a_credit_hint_lets_a_replacement_in_and_an_abandoned_body_can_be_dropped() {
    // П56-б, П56-д, Д75.
    let target = Target::in_process_with(|config| config.quota_bytes_per_user = Some(10_000));
    let account = enroll(&target, "a long enough password for tests");
    let space = account.create_space();
    let item = new_item();
    space.commit_ok(&[space.raw_file(&item, 0, "a.md", 10_000)]);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let client = SyncClient::new(&ServerUrl::parse(target.api.base(), true).unwrap()).unwrap();
    let mut remote = HttpRemote::new(
        runtime.handle().clone(),
        client,
        DeviceToken::new(account.token.clone()),
        *space.id.as_bytes(),
    );
    let blob = new_body();
    assert!(matches!(
        remote.blob_start(&blob, 10_000, None),
        Err(RemoteError::Rejected { status: 507, .. })
    ));
    remote.blob_start(&blob, 10_000, Some(&item)).unwrap();
    remote.blob_delete(&blob).unwrap();
    space.download(&blob).expect_error(404, "not_found");
}
