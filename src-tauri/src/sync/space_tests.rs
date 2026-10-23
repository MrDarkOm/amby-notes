//! The space of a vault on the server (docs/sync-plan.md, Р5, Ф34): made at the first switching
//! on or taken from the account's spaces. Against the real server in the process.

use std::path::Path;

use amby_sync_client::{DeviceToken, ServerUrl, SyncClient};
use amby_sync_conformance::client::{enroll, open_space_name, unwrap_vk_from_listing, Account};
use amby_sync_conformance::Target;
use amby_sync_core::crypto::keys::AccountKey;

use super::space::{clean_space_name, create_space, default_space_name, list_spaces, open_space};

struct Fixture {
    runtime: tokio::runtime::Runtime,
    target: Target,
    account: Account,
}

impl Fixture {
    fn new() -> Self {
        let target = Target::from_env();
        let account = enroll(&target, "a long enough password for tests");
        Self {
            runtime: tokio::runtime::Runtime::new().unwrap(),
            target,
            account,
        }
    }

    fn client(&self) -> SyncClient {
        SyncClient::new(&ServerUrl::parse(self.target.api.base(), true).unwrap()).unwrap()
    }

    fn token(&self) -> DeviceToken {
        DeviceToken::new(self.account.token.clone())
    }

    fn ak(&self) -> AccountKey {
        self.account.ak.clone()
    }
}

#[test]
fn a_new_space_has_a_sealed_name_and_a_wrapped_key() {
    // Р5, Ф12, Ф34, П20: the independent client reads what this one wrote
    let fx = Fixture::new();
    let space = fx
        .runtime
        .block_on(create_space(
            &fx.client(),
            &fx.token(),
            &fx.ak(),
            "Рабочий vault",
        ))
        .unwrap();
    assert_eq!(space.name.as_deref(), Some("Рабочий vault"));
    let listing = fx.account.get("/v1/spaces").expect(200).json();
    let spaces = listing["spaces"].as_array().unwrap();
    assert_eq!(spaces.len(), 1);
    assert_eq!(spaces[0]["space_id"], hex::encode(space.space_id));
    assert_eq!(spaces[0]["key_epoch"], 1);
    assert_eq!(
        open_space_name(
            &fx.account.ak,
            &space.space_id,
            spaces[0]["name_enc"].as_str().unwrap()
        ),
        "Рабочий vault"
    );
    let vk = unwrap_vk_from_listing(&fx.account.ak, &spaces[0]);
    assert_eq!(vk.as_bytes(), space.vk.as_bytes());
}

#[test]
fn every_new_space_gets_its_own_id_and_key() {
    let fx = Fixture::new();
    let client = fx.client();
    let (a, b) = fx.runtime.block_on(async {
        (
            create_space(&client, &fx.token(), &fx.ak(), "A")
                .await
                .unwrap(),
            create_space(&client, &fx.token(), &fx.ak(), "B")
                .await
                .unwrap(),
        )
    });
    assert_ne!(a.space_id, b.space_id);
    assert_ne!(a.vk.as_bytes(), b.vk.as_bytes());
}

#[test]
fn an_empty_name_becomes_vault() {
    let fx = Fixture::new();
    let space = fx
        .runtime
        .block_on(create_space(&fx.client(), &fx.token(), &fx.ak(), "   "))
        .unwrap();
    assert_eq!(space.name.as_deref(), Some("Vault"));
}

#[test]
fn another_device_of_the_account_opens_the_same_space_with_the_same_key() {
    // Р5: a second computer connects an existing vault
    let fx = Fixture::new();
    let client = fx.client();
    let made = fx
        .runtime
        .block_on(create_space(&client, &fx.token(), &fx.ak(), "Shared"))
        .unwrap();
    let second = fx.account.another_device("Second computer");
    let opened = fx
        .runtime
        .block_on(open_space(
            &client,
            &DeviceToken::new(second.token.clone()),
            &second.ak,
            made.space_id,
        ))
        .unwrap();
    assert_eq!(opened.space_id, made.space_id);
    assert_eq!(opened.name.as_deref(), Some("Shared"));
    assert_eq!(opened.vk.as_bytes(), made.vk.as_bytes());
    assert_eq!(opened.vk.epoch(), 1);
}

#[test]
fn a_space_the_account_does_not_have_is_space_not_found() {
    let fx = Fixture::new();
    let error = fx
        .runtime
        .block_on(open_space(&fx.client(), &fx.token(), &fx.ak(), [9; 16]))
        .err()
        .expect("must fail");
    assert_eq!(error.code, "space_not_found");
}

#[test]
fn a_key_that_does_not_open_is_cannot_decrypt() {
    // Ф12: the wrong AK must not produce a key
    let fx = Fixture::new();
    let made = fx
        .runtime
        .block_on(create_space(&fx.client(), &fx.token(), &fx.ak(), "Mine"))
        .unwrap();
    let wrong = AccountKey::from_bytes([0x77; 32]);
    let error = fx
        .runtime
        .block_on(open_space(&fx.client(), &fx.token(), &wrong, made.space_id))
        .err()
        .expect("must fail");
    assert_eq!(error.code, "cannot_decrypt");
}

#[test]
fn the_list_shows_names_newest_first_and_hides_what_it_cannot_read() {
    let fx = Fixture::new();
    let client = fx.client();
    let (first, second) = fx.runtime.block_on(async {
        let first = create_space(&client, &fx.token(), &fx.ak(), "First")
            .await
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = create_space(&client, &fx.token(), &fx.ak(), "Second")
            .await
            .unwrap();
        (first, second)
    });
    let listed = fx
        .runtime
        .block_on(list_spaces(&client, &fx.token(), &fx.ak()))
        .unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].space_id, hex::encode(second.space_id));
    assert_eq!(listed[0].name.as_deref(), Some("Second"));
    assert_eq!(listed[1].space_id, hex::encode(first.space_id));
    assert_eq!(listed[0].seq, 0);
    assert!(listed[0].created_ms > 0);
    // With another key the names cannot be read: the spaces are still listed, without names.
    let blind = fx
        .runtime
        .block_on(list_spaces(
            &client,
            &fx.token(),
            &AccountKey::from_bytes([0x55; 32]),
        ))
        .unwrap();
    assert_eq!(blind.len(), 2);
    assert!(blind.iter().all(|space| space.name.is_none()));
}

#[test]
fn the_default_name_is_the_folder_of_the_vault() {
    assert_eq!(
        default_space_name(Path::new("/Users/x/Documents/Заметки")),
        "Заметки"
    );
    assert_eq!(
        default_space_name(Path::new("/Users/x/My Vault/")),
        "My Vault"
    );
    assert_eq!(default_space_name(Path::new("/")), "Vault");
    assert_eq!(default_space_name(Path::new("")), "Vault");
}

#[test]
fn a_name_is_cut_at_64_bytes_on_a_character() {
    // Ф34: at most 64 bytes of UTF-8; a character is never cut in half
    let long = "я".repeat(40); // 80 bytes
    let cut = clean_space_name(&long);
    assert_eq!(cut.len(), 64);
    assert_eq!(cut, "я".repeat(32));
    let mixed = format!("{}{}", "a".repeat(63), "ы"); // 65 bytes, the last char straddles 64
    assert_eq!(clean_space_name(&mixed), "a".repeat(63));
    assert_eq!(
        default_space_name(Path::new(&format!("/v/{long}"))),
        "я".repeat(32)
    );
}

#[test]
fn a_name_is_trimmed_and_has_no_control_characters() {
    assert_eq!(clean_space_name("  Notes \n"), "Notes");
    assert_eq!(clean_space_name("a\u{0}b\tc"), "abc");
    assert_eq!(clean_space_name(" \t "), "");
}
