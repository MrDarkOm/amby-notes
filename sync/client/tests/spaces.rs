//! The data requests of the client (appendix Б.3–Б.6, П20–П34) against the real server in the
//! process. Everything the server holds is made by the independent client of the conformance
//! suite, so these requests are checked against bytes this client did not make.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use amby_sync_client::{ClientError, DeviceToken, NewSpace, ServerEvent};
use amby_sync_conformance::client::{
    enroll, new_body, new_item, open_space_name, pattern, seal_space_name, unhex,
};
use amby_sync_conformance::Target;
use amby_sync_core::crypto::account::{generate_space_key, unwrap_space_key, wrap_space_key};
use amby_sync_core::crypto::keys::{BodyId, ItemId, SpaceId};
use amby_sync_core::crypto::random::OsRandom;
use amby_sync_core::engine::{CommitItem, CommitReply};
use common::client_of;

fn token_of(account: &amby_sync_conformance::client::Account) -> DeviceToken {
    DeviceToken::new(account.token.clone())
}

fn commit_item(prepared: &amby_sync_conformance::client::Prepared) -> CommitItem {
    CommitItem {
        item_id: prepared.item,
        base_version: prepared.base_version,
        header: unhex(prepared.json["header"].as_str().unwrap()),
        blob_id: prepared.body,
        deleted: prepared.header.deleted,
    }
}

#[tokio::test]
async fn spaces_made_elsewhere_are_listed_and_their_keys_open() {
    // П20, Ф12, Ф34: the list carries the sealed name and the wrapped key of every space
    let target = Target::from_env();
    let account = enroll(&target, "a long enough password 1");
    let space = account.create_space_named("Заметки");
    let client = client_of(&target);

    let listed = client.list_spaces(&token_of(&account)).await.unwrap();
    assert_eq!(listed.len(), 1);
    let entry = &listed[0];
    assert_eq!(entry.space_id, *space.id.as_bytes());
    assert_eq!(entry.key_epoch, 1);
    assert_eq!(entry.seq, 0);
    assert_eq!(entry.name_enc.len(), 105);
    assert_eq!(
        open_space_name(&account.ak, &entry.space_id, &hex::encode(&entry.name_enc)),
        "Заметки"
    );
    let vk = unwrap_space_key(
        &account.ak,
        &SpaceId::from_bytes(entry.space_id),
        entry.key_epoch,
        &entry.wrapped_vk,
    )
    .unwrap();
    assert_eq!(vk.as_bytes(), space.vk.as_bytes());
}

#[tokio::test]
async fn a_space_made_by_the_client_is_seen_by_the_independent_one() {
    // П20: the device chooses the id; a taken id is space_exists
    let target = Target::from_env();
    let account = enroll(&target, "a long enough password 2");
    let client = client_of(&target);
    let id = SpaceId::from_bytes([7; 16]);
    let vk = generate_space_key(1, &mut OsRandom).unwrap();
    let wrapped = wrap_space_key(&account.ak, &id, &vk, &mut OsRandom);
    let name_enc = unhex(&seal_space_name(&account.ak, id.as_bytes(), "Work"));
    let new = NewSpace {
        space_id: *id.as_bytes(),
        name_enc: &name_enc,
        key_epoch: 1,
        wrapped_vk: &wrapped,
    };
    client
        .create_space(&token_of(&account), &new)
        .await
        .unwrap();

    let listing = account.get("/v1/spaces").expect(200).json();
    let spaces = listing["spaces"].as_array().unwrap();
    assert_eq!(spaces.len(), 1);
    assert_eq!(spaces[0]["space_id"], hex::encode([7u8; 16]));

    let again = client.create_space(&token_of(&account), &new).await;
    match again {
        Err(ClientError::Api { status, code, .. }) => {
            assert_eq!((status, code.as_str()), (409, "space_exists"));
        }
        other => panic!("expected space_exists, got {other:?}"),
    }
}

#[tokio::test]
async fn another_users_space_is_not_found() {
    // П6: a foreign space answers like a missing one
    let target = Target::from_env();
    let mine = enroll(&target, "a long enough password 3");
    let theirs = enroll(&target, "a long enough password 4");
    let space = theirs.create_space();
    let client = client_of(&target);
    let result = client
        .changes(&token_of(&mine), space.id.as_bytes(), 0, None)
        .await;
    match result {
        Err(ClientError::Api { status, code, .. }) => {
            assert_eq!((status, code.as_str()), (404, "not_found"));
        }
        other => panic!("expected not_found, got {other:?}"),
    }
}

#[tokio::test]
async fn a_request_without_a_valid_token_is_unauthorized() {
    // П5
    let target = Target::from_env();
    let client = client_of(&target);
    let bad = DeviceToken::new("0".repeat(64));
    let error = client.list_spaces(&bad).await.unwrap_err();
    assert_eq!(error.code(), "unauthorized");
}

#[tokio::test]
async fn the_feed_gives_the_last_version_of_every_item() {
    // П31: pages, cursor, header bytes untouched
    let target = Target::from_env();
    let account = enroll(&target, "a long enough password 5");
    let space = account.create_space();
    let (a, b) = (new_item(), new_item());
    let first = space.folder(&a, 0, "Notes");
    let second = space.file(&b, 0, "Notes/x.md", b"hello");
    let seq1 = space.commit_ok(&[first.clone()]);
    let seq2 = space.commit_ok(&[second.clone()]);
    let client = client_of(&target);
    let token = token_of(&account);

    let page = client
        .changes(&token, space.id.as_bytes(), 0, None)
        .await
        .unwrap();
    assert_eq!(page.seq, seq2);
    assert_eq!(page.since, 0);
    assert_eq!(page.next, seq2);
    assert!(!page.more && !page.gap);
    assert_eq!(
        page.instance_id.to_vec(),
        unhex(common_info_instance(&target).as_str())
    );
    assert_eq!(page.changes.len(), 2);
    assert_eq!(page.changes[0].seq, seq1);
    assert_eq!(page.changes[0].item_id, a);
    assert_eq!(page.changes[0].version, 1);
    assert_eq!(
        page.changes[0].header,
        unhex(first.json["header"].as_str().unwrap())
    );
    assert_eq!(page.changes[0].blob_id, None);
    assert_eq!(page.changes[1].item_id, b);
    assert_eq!(page.changes[1].blob_id, second.body);
    assert!(page.changes[1].blob_size.unwrap() > 0);
    assert!(!page.changes[1].deleted);

    // The cursor: nothing after the head; a page of one entry says there is more.
    let after = client
        .changes(&token, space.id.as_bytes(), seq2, None)
        .await
        .unwrap();
    assert!(after.changes.is_empty());
    assert_eq!(after.next, seq2);
    let small = client
        .changes(&token, space.id.as_bytes(), 0, Some(1))
        .await
        .unwrap();
    assert_eq!(small.changes.len(), 1);
    assert!(small.more);
    assert_eq!(small.next, seq1);
}

fn common_info_instance(target: &Target) -> String {
    amby_sync_conformance::client::info(&target.api)["instance_id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn a_body_is_uploaded_in_parts_and_downloaded_by_pieces() {
    // П21–П24, С1: a repeated start tells how far the upload got
    let target = Target::from_env();
    let account = enroll(&target, "a long enough password 6");
    let space = account.create_space();
    let client = client_of(&target);
    let token = token_of(&account);
    let blob = new_body();
    let part = 8 * 1024 * 1024usize;
    let sealed = pattern(part + 1000);

    let started = client
        .blob_start(&token, space.id.as_bytes(), &blob, sealed.len() as u64)
        .await
        .unwrap();
    assert!(!started.complete);
    assert!(started.uploaded.is_empty());
    client
        .blob_put_part(
            &token,
            space.id.as_bytes(),
            &blob,
            0,
            sealed[..part].to_vec(),
        )
        .await
        .unwrap();
    let resumed = client
        .blob_start(&token, space.id.as_bytes(), &blob, sealed.len() as u64)
        .await
        .unwrap();
    assert_eq!(resumed.uploaded, vec![0]);
    client
        .blob_put_part(
            &token,
            space.id.as_bytes(),
            &blob,
            1,
            sealed[part..].to_vec(),
        )
        .await
        .unwrap();
    client
        .blob_complete(&token, space.id.as_bytes(), &blob)
        .await
        .unwrap();
    let done = client
        .blob_start(&token, space.id.as_bytes(), &blob, sealed.len() as u64)
        .await
        .unwrap();
    assert!(done.complete);

    let mut download = client
        .blob_download(&token, space.id.as_bytes(), &blob)
        .await
        .unwrap();
    let mut got = Vec::new();
    let mut pieces = 0;
    while let Some(piece) = download.chunk().await.unwrap() {
        assert!(!piece.is_empty());
        got.extend_from_slice(&piece);
        pieces += 1;
    }
    assert_eq!(got, sealed);
    assert!(
        pieces >= 2,
        "a body of 8 MiB arrives in more than one piece"
    );
    // The independent client sees the same bytes.
    assert_eq!(space.download(&blob).expect(200).body, sealed);
}

#[tokio::test]
async fn a_part_of_the_wrong_size_and_a_missing_body_are_errors() {
    // П22, П24
    let target = Target::from_env();
    let account = enroll(&target, "a long enough password 7");
    let space = account.create_space();
    let client = client_of(&target);
    let token = token_of(&account);
    let blob = new_body();
    client
        .blob_start(&token, space.id.as_bytes(), &blob, 10)
        .await
        .unwrap();
    let bad = client
        .blob_put_part(&token, space.id.as_bytes(), &blob, 0, vec![1; 3])
        .await
        .unwrap_err();
    assert_eq!(bad.code(), "bad_part");
    let missing = client
        .blob_download(&token, space.id.as_bytes(), &BodyId::from_bytes([9; 16]))
        .await;
    match missing {
        Err(error) => assert_eq!(error.code(), "not_found"),
        Ok(_) => panic!("a missing body must be an error"),
    }
}

#[tokio::test]
async fn a_commit_is_accepted_replayed_and_a_stale_base_is_a_conflict_not_an_error() {
    // П26–П28
    let target = Target::from_env();
    let account = enroll(&target, "a long enough password 8");
    let space = account.create_space();
    let client = client_of(&target);
    let token = token_of(&account);
    let item = new_item();
    let first = space.folder(&item, 0, "Docs");
    let commit_id = [3u8; 16];

    let reply = client
        .commit(
            &token,
            space.id.as_bytes(),
            &commit_id,
            &[commit_item(&first)],
        )
        .await
        .unwrap();
    let CommitReply::Accepted(accepted) = reply else {
        panic!("expected an accepted commit");
    };
    assert_eq!(accepted.seq, 1);
    assert!(!accepted.replayed);
    assert_eq!(accepted.versions, vec![(item, 1)]);

    let replay = client
        .commit(
            &token,
            space.id.as_bytes(),
            &commit_id,
            &[commit_item(&first)],
        )
        .await
        .unwrap();
    let CommitReply::Accepted(replayed) = replay else {
        panic!("a replay is accepted");
    };
    assert!(replayed.replayed);
    assert_eq!(replayed.seq, 1);

    // Another device moves the item on; this base (0) is now stale.
    let stale = space.folder(&item, 0, "Docs2");
    let conflict = client
        .commit(
            &token,
            space.id.as_bytes(),
            &[4u8; 16],
            &[commit_item(&stale)],
        )
        .await
        .unwrap();
    let CommitReply::Conflict(list) = conflict else {
        panic!("expected a version conflict");
    };
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].item_id, item);
    assert_eq!(list[0].base_version, 0);
    assert_eq!(list[0].current_version, 1);
}

#[tokio::test]
async fn a_commit_that_names_an_unknown_body_is_an_error_with_its_code() {
    // П30
    let target = Target::from_env();
    let account = enroll(&target, "a long enough password 9");
    let space = account.create_space();
    let client = client_of(&target);
    let item = ItemId::from_bytes([5; 16]);
    let ghost = BodyId::from_bytes([6; 16]);
    let mut prepared = space.file_with_uploaded_body(&item, 0, "a.md", b"x", &ghost);
    prepared.body = Some(ghost);
    let error = client
        .commit(
            &token_of(&account),
            space.id.as_bytes(),
            &[1u8; 16],
            &[commit_item(&prepared)],
        )
        .await
        .unwrap_err();
    assert_eq!(error.code(), "unknown_blob");
}

#[tokio::test]
async fn the_event_stream_says_hello_then_tells_of_every_commit() {
    // П34: no headers and no paths in the events
    let target = Target::from_env();
    let account = enroll(&target, "a long enough password 10");
    let space = account.create_space();
    let client = client_of(&target);
    let token = token_of(&account);
    let mut events = client.events(&token, space.id.as_bytes()).await.unwrap();

    let hello = events.next().await.unwrap().unwrap();
    match hello {
        ServerEvent::Hello { seq, instance_id } => {
            assert_eq!(seq, 0);
            assert_eq!(hex::encode(instance_id), common_info_instance(&target));
        }
        other => panic!("expected hello, got {other:?}"),
    }
    let item = new_item();
    let seq = space.commit_ok(&[space.folder(&item, 0, "Events")]);
    loop {
        match events.next().await.unwrap().unwrap() {
            ServerEvent::Commit {
                seq: got,
                device_id,
                items,
            } => {
                assert_eq!(got, seq);
                assert_eq!(hex::encode(device_id), account.device_id);
                assert_eq!(items, 1);
                break;
            }
            ServerEvent::Ping => continue,
            other => panic!("unexpected {other:?}"),
        }
    }
}

#[tokio::test]
async fn the_event_stream_of_a_missing_space_or_token_is_refused() {
    // П34
    let target = Target::from_env();
    let account = enroll(&target, "a long enough password 11");
    let client = client_of(&target);
    let missing = client.events(&token_of(&account), &[1; 16]).await;
    match missing {
        Err(error) => assert_eq!(error.code(), "not_found"),
        Ok(_) => panic!("a missing space must be refused"),
    }
    let space = account.create_space();
    let bad = client
        .events(&DeviceToken::new("1".repeat(64)), space.id.as_bytes())
        .await;
    match bad {
        Err(error) => assert_eq!(error.code(), "unauthorized"),
        Ok(_) => panic!("a bad token must be refused"),
    }
}

#[tokio::test]
async fn the_limits_and_the_instance_come_from_info() {
    // П8, П9, П21: the engine's view of /v1/info
    let target = Target::from_env();
    let info = client_of(&target).info().await.unwrap();
    let engine = info.to_engine().unwrap();
    assert_eq!((engine.protocol_min, engine.protocol_max), (1, 1));
    assert_eq!(hex::encode(engine.instance_id), info.instance_id);
    assert!(engine.max_blob_bytes >= 8 * 1024 * 1024);
    assert!(engine.max_commit_items >= 1);
    let limits = info.limits().unwrap();
    assert_eq!(limits.part_size, 8 * 1024 * 1024);
    assert_eq!(limits.max_blob_bytes, engine.max_blob_bytes);
    assert_eq!(limits.max_commit_items, engine.max_commit_items);
}

#[tokio::test]
async fn an_info_without_limits_is_a_bad_response() {
    // П7: a field of the wrong shape is BadResponse, never a guess
    let mut info = client_of(&Target::from_env()).info().await.unwrap();
    info.rest["limits"] = serde_json::Value::Null;
    assert_eq!(info.limits().unwrap_err().code(), "bad_response");
    assert_eq!(info.to_engine().unwrap_err().code(), "bad_response");
}
