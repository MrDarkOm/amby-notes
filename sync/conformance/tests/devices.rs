//! Devices and the revocation of tokens (Р5, П5, П19).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use amby_sync_conformance::client::{enroll, open_device_name, PASSWORD};
use amby_sync_conformance::Target;

#[test]
fn the_list_shows_every_device_with_its_name_for_the_owner_only() {
    // П19, Р5, О2: names are encrypted with AK; the owner opens them. The current device is
    // marked, and the order is the order of creation.
    let target = Target::from_env();
    let first = enroll(&target, PASSWORD);
    let second = first.another_device("laptop");
    let list = first.get("/v1/devices").expect(200).json();
    let devices = list["devices"].as_array().unwrap();
    assert_eq!(devices.len(), 2);
    assert_eq!(devices[0]["device_id"], first.device_id.as_str());
    assert_eq!(devices[1]["device_id"], second.device_id.as_str());
    assert_eq!(
        open_device_name(&first.ak, devices[0]["name_enc"].as_str().unwrap()),
        "first device"
    );
    assert_eq!(
        open_device_name(&first.ak, devices[1]["name_enc"].as_str().unwrap()),
        "laptop"
    );
    assert_eq!(devices[0]["current"], true);
    assert_eq!(devices[1]["current"], false);
    assert!(devices[0]["created_ms"].as_i64().unwrap() > 0);
    assert!(devices[0]["last_seen_ms"].as_i64().unwrap() > 0);
    let from_second = second.get("/v1/devices").expect(200).json();
    assert_eq!(from_second["devices"][1]["current"], true);
}

#[test]
fn a_user_sees_only_their_own_devices() {
    // П6, П19: somebody else's device is not even reported to exist.
    let target = Target::from_env();
    let alice = enroll(&target, PASSWORD);
    let bob = enroll(&target, PASSWORD);
    let seen = bob.get("/v1/devices").expect(200).json();
    assert_eq!(seen["devices"].as_array().unwrap().len(), 1);
    assert_eq!(seen["devices"][0]["device_id"], bob.device_id.as_str());
    bob.delete(&format!("/v1/devices/{}", alice.device_id))
        .expect_error(404, "not_found");
    alice.get("/v1/keys").expect(200);
}

#[test]
fn a_disconnected_device_loses_its_token_at_once() {
    // Р5, П19, П5: DELETE → 204; the token is `token_revoked` everywhere; the others live on.
    let target = Target::from_env();
    let first = enroll(&target, PASSWORD);
    let second = first.another_device("to be disconnected");
    first
        .delete(&format!("/v1/devices/{}", second.device_id))
        .expect(204);
    second.get("/v1/keys").expect_error(401, "token_revoked");
    second.get("/v1/devices").expect_error(401, "token_revoked");
    second.get("/v1/spaces").expect_error(401, "token_revoked");
    first.get("/v1/keys").expect(200);
    let list = first.get("/v1/devices").expect(200).json();
    assert_eq!(
        list["devices"].as_array().unwrap().len(),
        1,
        "the disconnected device is gone"
    );
}

#[test]
fn a_device_can_disconnect_itself() {
    // П19: the current device may delete itself; its token is revoked afterwards.
    let target = Target::from_env();
    let first = enroll(&target, PASSWORD);
    let second = first.another_device("second");
    second
        .delete(&format!("/v1/devices/{}", second.device_id))
        .expect(204);
    second.get("/v1/keys").expect_error(401, "token_revoked");
    first.get("/v1/keys").expect(200);
}

#[test]
fn disconnecting_twice_or_an_unknown_device_is_a_404() {
    // П19, П6.
    let target = Target::from_env();
    let first = enroll(&target, PASSWORD);
    let second = first.another_device("second");
    let path = format!("/v1/devices/{}", second.device_id);
    first.delete(&path).expect(204);
    first.delete(&path).expect_error(404, "not_found");
    first
        .delete(&format!("/v1/devices/{}", "00".repeat(16)))
        .expect_error(404, "not_found");
}

#[test]
fn a_revoked_token_cannot_open_an_event_stream() {
    // Р5, П34, П5: the notification stream needs a live token too.
    let target = Target::from_env();
    let first = enroll(&target, PASSWORD);
    let space = first.create_space();
    let second = first.another_device("second");
    first
        .delete(&format!("/v1/devices/{}", second.device_id))
        .expect(204);
    let error = second
        .api
        .open_events(
            &space.path("/events"),
            Some(&second.token),
            std::time::Duration::from_secs(5),
        )
        .err()
        .expect("a revoked token must not open a stream");
    error.expect_error(401, "token_revoked");
}

#[test]
fn a_new_login_after_disconnecting_works_and_gets_a_new_token() {
    // П14, П19: disconnecting is not a ban; the account keeps working.
    let target = Target::from_env();
    let first = enroll(&target, PASSWORD);
    let second = first.another_device("second");
    first
        .delete(&format!("/v1/devices/{}", second.device_id))
        .expect(204);
    let third = first.another_device("third");
    assert_ne!(third.token, second.token);
    third.get("/v1/keys").expect(200);
    second.get("/v1/keys").expect_error(401, "token_revoked");
}
