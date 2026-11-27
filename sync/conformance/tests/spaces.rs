//! Spaces and their wrapped keys (Р2, Р5, П6, П20).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use amby_sync_conformance::client::{
    enroll, hex16, new_item, open_space_name, random16, seal_space_name, unwrap_ak,
    unwrap_vk_from_listing, PASSWORD,
};
use amby_sync_conformance::Target;
use serde_json::json;

#[test]
fn a_space_is_created_and_listed_with_its_wrapped_key() {
    // П20, Р5, Р2: the listing returns the name and VK as sent; the VK opens with AK.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    let list = account.get("/v1/spaces").expect(200).json();
    let spaces = list["spaces"].as_array().unwrap();
    assert_eq!(spaces.len(), 1);
    let listed = &spaces[0];
    assert_eq!(listed["space_id"], hex16(space.id.as_bytes()).as_str());
    assert_eq!(listed["key_epoch"], 1);
    assert_eq!(listed["seq"], 0);
    assert!(listed["created_ms"].as_i64().unwrap() > 0);
    assert_eq!(
        open_space_name(
            &account.ak,
            space.id.as_bytes(),
            listed["name_enc"].as_str().unwrap()
        ),
        "My vault"
    );
    assert_eq!(unwrap_vk_from_listing(&account.ak, listed), space.vk);
}

#[test]
fn creating_a_space_answers_201_with_seq_zero() {
    // П20, П29: a new space starts at seq 0.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let id = random16();
    let answer = account
        .post(
            "/v1/spaces",
            json!({
                "space_id": hex16(&id),
                "name_enc": seal_space_name(&account.ak, &id, "x"),
                "key_epoch": 1,
                "wrapped_vk": "ab".repeat(73),
            }),
        )
        .expect(201)
        .json();
    assert_eq!(answer["space_id"], hex16(&id).as_str());
    assert_eq!(answer["seq"], 0);
}

#[test]
fn a_second_device_opens_the_same_space() {
    // Р5, П14, П20: a device that logged in with the password unwraps AK and then VK, and reads
    // what the first device wrote.
    let target = Target::from_env();
    let first = enroll(&target, PASSWORD);
    let space = first.create_space();
    let item = new_item();
    let content = b"hello from the first device";
    space.commit_ok(&[space.file(&item, 0, "a.md", content)]);

    let login = amby_sync_conformance::client::login(
        &target.api,
        &first.username,
        PASSWORD,
        &first.ak,
        "second",
    )
    .expect(200)
    .json();
    let ak = unwrap_ak(
        PASSWORD,
        &first.salt,
        &first.params,
        login["wrapped_ak"].as_str().unwrap(),
    );
    let token = login["token"].as_str().unwrap();
    let listed = target.api.get("/v1/spaces", Some(token)).expect(200).json();
    let vk = unwrap_vk_from_listing(&ak, &listed["spaces"][0]);
    let mut as_second = space.with_token(token);
    as_second.vk = vk;
    let change = as_second.all_changes(0).remove(0);
    assert_eq!(as_second.fetch_file(&change), content);
}

#[test]
fn a_space_id_can_be_used_once() {
    // П20: a second creation with the same id is `space_exists`; the first space is untouched.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    account
        .post(
            "/v1/spaces",
            json!({
                "space_id": hex16(space.id.as_bytes()),
                "name_enc": seal_space_name(&account.ak, space.id.as_bytes(), "again"),
                "key_epoch": 1,
                "wrapped_vk": "cd".repeat(73),
            }),
        )
        .expect_error(409, "space_exists");
    let list = account.get("/v1/spaces").expect(200).json();
    assert_eq!(list["spaces"].as_array().unwrap().len(), 1);
    assert_eq!(
        unwrap_vk_from_listing(&account.ak, &list["spaces"][0]),
        space.vk
    );
}

#[test]
fn bad_space_fields_are_refused() {
    // П2, П3, П20, Ф3: hex rules, 73-byte wrapped key, epoch 1 only.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let good_id = random16();
    let good = json!({
        "space_id": hex16(&good_id),
        "name_enc": seal_space_name(&account.ak, &good_id, "x"),
        "key_epoch": 1,
        "wrapped_vk": "ab".repeat(73),
    });
    let mut upper = good.clone();
    upper["space_id"] = json!(hex16(&random16()).to_uppercase());
    let mut short = good.clone();
    short["wrapped_vk"] = json!("ab".repeat(72));
    let mut epoch_two = good.clone();
    epoch_two["key_epoch"] = json!(2);
    let mut epoch_zero = good.clone();
    epoch_zero["key_epoch"] = json!(0);
    let mut short_id = good.clone();
    short_id["space_id"] = json!("ab".repeat(15));
    // Ф34: a name envelope is exactly 105 bytes, no more and no less (П20).
    let mut name_short = good.clone();
    name_short["name_enc"] = json!("ab".repeat(104));
    let mut name_long = good.clone();
    name_long["name_enc"] = json!("ab".repeat(106));
    for body in [
        upper, short, epoch_two, epoch_zero, short_id, name_short, name_long,
    ] {
        account
            .post("/v1/spaces", body)
            .expect_error(400, "bad_request");
    }
    assert!(account.get("/v1/spaces").expect(200).json()["spaces"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn spaces_belong_to_their_owner_alone() {
    // П6, О1: another user gets `not_found` for every route of somebody else's space.
    let target = Target::from_env();
    let alice = enroll(&target, PASSWORD);
    let bob = enroll(&target, PASSWORD);
    let space = alice.create_space();
    let item = new_item();
    let prepared = space.file(&item, 0, "private.md", b"alice only");
    space.commit_ok(std::slice::from_ref(&prepared));
    let bob_view = space.with_token(&bob.token);
    assert!(bob.get("/v1/spaces").expect(200).json()["spaces"]
        .as_array()
        .unwrap()
        .is_empty());
    bob_view.changes(0, None).expect_error(404, "not_found");
    bob_view.get("/events").expect_error(404, "not_found");
    bob_view.versions(&item).expect_error(404, "not_found");
    bob_view
        .commit(std::slice::from_ref(&prepared))
        .expect_error(404, "not_found");
    bob_view
        .init_blob(&prepared.body.unwrap(), 100)
        .expect_error(404, "not_found");
    bob_view
        .download(&prepared.body.unwrap())
        .expect_error(404, "not_found");
}

#[test]
fn the_listing_shows_the_head_of_the_feed() {
    // П20, П29: `seq` of the listing follows the commits.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let space = account.create_space();
    space.commit_ok(&[space.folder(&new_item(), 0, "Docs")]);
    space.commit_ok(&[space.folder(&new_item(), 0, "Pictures")]);
    let list = account.get("/v1/spaces").expect(200).json();
    assert_eq!(list["spaces"][0]["seq"], 2);
}

#[test]
fn spaces_of_one_user_do_not_mix() {
    // Р2, П20: two spaces keep separate feeds and separate keys.
    let target = Target::from_env();
    let account = enroll(&target, PASSWORD);
    let first = account.create_space();
    let second = account.create_space();
    first.commit_ok(&[first.folder(&new_item(), 0, "OnlyInFirst")]);
    assert_eq!(first.all_changes(0).len(), 1);
    assert!(second.all_changes(0).is_empty());
    assert_ne!(first.vk, second.vk);
}

#[test]
fn creating_a_space_takes_no_time_from_the_clock() {
    // Р3, С10: only versions decide; a clock far in the future changes no number.
    let target = Target::in_process();
    let control = amby_sync_conformance::in_process_or_skip!(target);
    let account = enroll(&target, PASSWORD);
    control.advance(Duration::from_secs(400 * 24 * 3600));
    let space = account.create_space();
    assert_eq!(space.commit_ok(&[space.folder(&new_item(), 0, "Docs")]), 1);
}

// ----- the limit of spaces and the account (appendix Е: П60-1, П61) -----

mod space_limit {
    use super::*;
    use amby_sync_conformance::in_process_or_skip;

    fn one_space() -> Target {
        Target::in_process_with_plans(
            &json!({"default_plan": "one", "plans": {"one": {"max_spaces": 1}, "free": {}}})
                .to_string(),
            |_| {},
        )
    }

    #[test]
    fn the_second_space_of_a_one_space_plan_is_403_space_limit_and_nothing_is_created() {
        // П60-1, П59: `details` say how many are allowed and how many there are.
        let target = one_space();
        let _ = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        let first = account.create_space();
        let refused = account
            .post("/v1/spaces", account.new_space_request("Second").2)
            .expect_error(403, "space_limit");
        assert_eq!(refused.details(), json!({"max_spaces": 1, "spaces": 1}));
        let list = account.get("/v1/spaces").expect(200).json();
        assert_eq!(list["spaces"].as_array().unwrap().len(), 1);
        assert_eq!(
            list["spaces"][0]["space_id"],
            hex16(first.id.as_bytes()).as_str()
        );
    }

    #[test]
    fn a_repeated_space_id_is_409_even_at_the_limit() {
        // П60-1: `space_exists` is checked before the limit (the retry of a lost answer).
        let target = one_space();
        let _ = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        let (_, _, body) = account.new_space_request("Only");
        account.post("/v1/spaces", body.clone()).expect(201);
        account
            .post("/v1/spaces", body)
            .expect_error(409, "space_exists");
    }

    #[test]
    fn the_spaces_of_other_users_do_not_count() {
        // П60-1, П6.
        let target = one_space();
        let _ = in_process_or_skip!(target);
        let (first, second) = (enroll(&target, PASSWORD), enroll(&target, PASSWORD));
        first.create_space();
        second.create_space();
        assert_eq!(first.overview()["usage"]["spaces"], 1);
        assert_eq!(first.overview()["limits"]["max_spaces"], 1);
    }

    #[test]
    fn work_in_the_one_space_goes_on_at_the_limit_and_a_free_plan_has_no_limit() {
        // П60: nothing but creation is checked; `free` has no `max_spaces`.
        let target = one_space();
        let _ = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        let space = account.create_space();
        space.commit_ok(&[space.folder(&new_item(), 0, "Docs")]);
        assert_eq!(
            account.get("/v1/spaces").expect(200).json()["spaces"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        target.cli_ok(&["user", "plan", "set", &account.username, "free"]);
        for _ in 0..3 {
            account.create_space();
        }
    }

    #[test]
    fn the_account_lists_the_same_spaces_as_the_listing_and_changes_no_key_material() {
        // П61: rows as in `GET /v1/spaces` (`name_enc`, `wrapped_vk` byte for byte, same order),
        // plus sizes.
        let target = Target::in_process();
        let _ = in_process_or_skip!(target);
        let account = enroll(&target, PASSWORD);
        let first = account.create_space_named("First");
        let second = account.create_space_named("Second");
        first.commit_ok(&[first.raw_file(&new_item(), 0, "a.md", 123)]);
        let listing = account.get("/v1/spaces").expect(200).json();
        let overview = account.overview();
        let (listed, shown) = (
            listing["spaces"].as_array().unwrap(),
            overview["spaces"].as_array().unwrap(),
        );
        assert_eq!(shown.len(), listed.len());
        for (row, extended) in listed.iter().zip(shown) {
            for field in [
                "space_id",
                "name_enc",
                "key_epoch",
                "wrapped_vk",
                "seq",
                "created_ms",
            ] {
                assert_eq!(
                    extended[field], row[field],
                    "`{field}` is the same as in the listing"
                );
            }
            assert!(extended["live_bytes"].is_u64() && extended["history_bytes"].is_u64());
        }
        assert_eq!(shown[0]["live_bytes"], 123);
        assert_eq!(
            open_space_name(
                &account.ak,
                second.id.as_bytes(),
                shown[1]["name_enc"].as_str().unwrap()
            ),
            "Second",
            "the names stay encrypted for the server and open for the owner"
        );
        assert_eq!(unwrap_vk_from_listing(&account.ak, &shown[0]), first.vk);
    }
}
